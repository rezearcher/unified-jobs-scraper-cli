#!/usr/bin/env node
// Live source-health / schema-drift check for the aggregator's inputs: eight ATS
// adapters (hard-gated) and the LinkedIn public guest search (advisory). Each
// source exposes a keyless public feed whose shape can drift silently — a
// renamed field returns rows with null title/url, a moved endpoint returns zero —
// so a plain "it ran" check never notices the data went junk.
//
// For each source we grade three things that break independently, against a
// large, stable canary:
//   1. REACHABLE     — the endpoint still answers.
//   2. POPULATED     — the canary still yields >=1 record.
//   3. SCHEMA-INTACT — records still carry the key fields above a threshold.
//
// Verdicts: OK / DOWN / EMPTY / SCHEMA_DRIFT. Prints a table, writes
// health-status.json, and EXITS NON-ZERO on drift so the scheduled workflow
// opens a maintenance issue.
//
// GATING: the eight ATS adapters are hard gates. LinkedIn's guest endpoint
// rate-limits unpredictably from cloud IPs (a CI runner is often blocked), so a
// LinkedIn DOWN/EMPTY is ADVISORY (reported, never fails the run) — only a clear
// LinkedIn SCHEMA_DRIFT (cards returned but key fields gone) gates, because that
// is a real HTML reshape, not a block. This keeps the daily check from crying
// wolf while still catching genuine drift. Zero dependencies (native fetch).

import { writeFileSync } from 'node:fs';
import { ADAPTERS } from './src/sources/ats/adapters.js';
import { parseSearch } from './src/sources/linkedin/parse.js';

const ATS_CANARIES = {
  greenhouse: 'stripe',
  lever: 'palantir',
  ashby: 'openai',
  smartrecruiters: 'Experian',
  workday: 'nvidia.wd5:NVIDIAExternalCareerSite',
  recruitee: 'bunq',
  workable: 'epignosis',
  bamboohr: 'greenhousejuice',
};
const LINKEDIN_CANARY = { keywords: 'software engineer', location: 'United States' };

const SCHEMA_THRESHOLD = 0.9;
const ATS_KEY_FIELDS = ['id', 'title', 'url'];
const LI_KEY_FIELDS = ['title', 'url'];
const ICON = { OK: '✓', DOWN: '✗', EMPTY: '∅', SCHEMA_DRIFT: '⚠', NO_CANARY: '?' };

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms)),
  ]);
}

function gradeSchema(list, keyFields) {
  const count = list.length;
  const field_presence = {};
  for (const f of keyFields) {
    const present = list.filter((r) => r && r[f] !== null && r[f] !== undefined && r[f] !== '').length;
    field_presence[f] = count ? +(present / count).toFixed(3) : 0;
  }
  const drifted = keyFields.filter((f) => field_presence[f] < SCHEMA_THRESHOLD);
  return { count, field_presence, drifted };
}

async function checkAts(platform, token) {
  const started = Date.now();
  const base = { source: platform, family: 'ats', canary: token, checked_at: new Date().toISOString(), gating: true };
  let records;
  try {
    records = await withTimeout(ADAPTERS[platform](token, { includeDescription: false, maxItems: 50 }), 25000);
  } catch (err) {
    return { ...base, verdict: 'DOWN', count: 0, field_presence: {}, elapsed_ms: Date.now() - started,
      detail: `endpoint error: ${err.status ? `HTTP ${err.status}` : err.message}` };
  }
  const list = Array.isArray(records) ? records : [];
  const { count, field_presence, drifted } = gradeSchema(list, ATS_KEY_FIELDS);
  if (count < 1) return { ...base, verdict: 'EMPTY', count, field_presence, elapsed_ms: Date.now() - started,
    detail: `canary returned 0 records — endpoint moved, newly gated, or reshaped` };
  if (drifted.length) return { ...base, verdict: 'SCHEMA_DRIFT', count, field_presence, elapsed_ms: Date.now() - started,
    detail: `key field(s) below ${SCHEMA_THRESHOLD}: ${drifted.map((f) => `${f}=${field_presence[f]}`).join(', ')}` };
  return { ...base, verdict: 'OK', count, field_presence, elapsed_ms: Date.now() - started,
    detail: `healthy: ${count} records, key fields intact` };
}

async function checkLinkedIn() {
  const started = Date.now();
  const base = { source: 'linkedin', family: 'linkedin', canary: LINKEDIN_CANARY.keywords, checked_at: new Date().toISOString(), gating: false };
  const url = `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=${encodeURIComponent(LINKEDIN_CANARY.keywords)}&location=${encodeURIComponent(LINKEDIN_CANARY.location)}`;
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    'Accept-Language': 'en-US,en;q=0.9',
  };
  let res;
  try {
    res = await withTimeout(fetch(url, { headers }), 25000);
  } catch (err) {
    return { ...base, verdict: 'DOWN', count: 0, field_presence: {}, elapsed_ms: Date.now() - started,
      detail: `fetch error: ${err.message} (advisory — guest endpoint often blocks cloud IPs)` };
  }
  if (!res.ok) {
    return { ...base, verdict: 'DOWN', count: 0, field_presence: {}, elapsed_ms: Date.now() - started,
      detail: `HTTP ${res.status} (advisory — guest endpoint rate-limits/blocks cloud IPs; not a schema break)` };
  }
  const html = await res.text();
  const list = parseSearch(html);
  const { count, field_presence, drifted } = gradeSchema(list, LI_KEY_FIELDS);
  if (count < 1) return { ...base, verdict: 'EMPTY', count, field_presence, elapsed_ms: Date.now() - started,
    detail: `guest search returned 0 parseable cards (advisory — likely a soft block; a true HTML reshape would also show here)` };
  if (drifted.length) return { ...base, verdict: 'SCHEMA_DRIFT', count, field_presence, elapsed_ms: Date.now() - started,
    detail: `cards returned but key field(s) below ${SCHEMA_THRESHOLD}: ${drifted.map((f) => `${f}=${field_presence[f]}`).join(', ')} — guest card HTML reshaped` };
  return { ...base, verdict: 'OK', count, field_presence, elapsed_ms: Date.now() - started,
    detail: `healthy: ${count} cards, key fields intact` };
}

const args = process.argv.slice(2).filter((a) => !a.startsWith('-'));

(async () => {
  console.log('unified-jobs source freshness / schema-drift check — live canary probe\n');
  const results = [];
  const wantAts = !args.length || args.includes('ats');
  const wantLi = !args.length || args.includes('linkedin');

  if (wantAts) {
    for (const [platform, token] of Object.entries(ATS_CANARIES)) {
      // eslint-disable-next-line no-await-in-loop -- serial = polite client
      results.push(await checkAts(platform, token));
    }
  }
  if (wantLi) results.push(await checkLinkedIn());

  for (const r of results) {
    const icon = ICON[r.verdict] || '?';
    const fp = r.field_presence ? Object.entries(r.field_presence).map(([k, v]) => `${k}:${v}`).join(' ') : '';
    const tag = r.gating ? '' : ' (advisory)';
    console.log(`  ${icon} ${r.source.padEnd(16)} ${String(r.verdict).padEnd(13)} count=${String(r.count ?? '-').padEnd(5)} ${fp}${tag}`);
    if (r.verdict !== 'OK') console.log(`      ↳ ${r.detail}`);
  }

  // A source fails the gate only if it is gating AND not OK, OR it is a real
  // SCHEMA_DRIFT on any source (advisory sources still gate on a true reshape).
  const gatingFailures = results.filter((r) => (r.gating && r.verdict !== 'OK') || r.verdict === 'SCHEMA_DRIFT');
  const report = {
    generated_at: new Date().toISOString(),
    tool: 'unified-jobs-scraper-cli',
    sources_total: results.length,
    sources_ok: results.filter((r) => r.verdict === 'OK').length,
    gating_failures: gatingFailures.map((r) => r.source),
    healthy: gatingFailures.length === 0,
    results,
  };
  try { writeFileSync('health-status.json', JSON.stringify(report, null, 2)); }
  catch (e) { console.error(`  (warn) could not write health-status.json: ${e.message}`); }

  const advisory = results.filter((r) => !r.gating && r.verdict !== 'OK').map((r) => r.source);
  console.log(`\n  ${report.sources_ok}/${report.sources_total} sources OK` +
    (report.healthy ? '' : ` — GATE FAIL on: ${report.gating_failures.join(', ')}`) +
    (advisory.length ? ` — advisory note: ${advisory.join(', ')}` : ''));

  process.exit(report.healthy ? 0 : 1);
})();
