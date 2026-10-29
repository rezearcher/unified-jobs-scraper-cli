#!/usr/bin/env node
// Zero-install, zero-API-key CLI for the Unified Jobs Aggregator. Runnable by a
// stranger with:
//
//   npx github:rezearcher/unified-jobs-scraper-cli \
//       --keywords "data engineer" --location "United States" \
//       --companies stripe,lever:palantir
//
// It uses only the DEPENDENCY-FREE cores (ATS public JSON via native fetch, the
// LinkedIn guest search via native fetch, and the pure dedup/merge layer), so it
// runs with no npm install. Indeed is intentionally omitted here — it is 403
// keyless and needs the hosted actor's residential proxy. This CLI mirrors the role
// of ats-jobs-scraper-cli: a no-account distribution + trust surface that funnels to
// the metered Apify actor. It does NOT meter USD itself.
//
// SCOPE: public postings only. No login, no member data.

import { scrape as atsScrape } from './src/sources/ats/scrape.js';
import { parseSearch } from './src/sources/linkedin/parse.js';
import { dedupe, dedupStats } from './src/dedup.js';

// --- tiny arg parser -----------------------------------------------------
function parseArgs(argv) {
  const out = { companies: [], sources: null };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--keywords' || a === '-k') out.keywords = argv[++i];
    else if (a === '--location' || a === '-l') out.location = argv[++i];
    else if (a === '--companies' || a === '-c') out.companies = (argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--max') out.maxResultsPerSource = Number(argv[++i]);
    else if (a === '--no-dedupe') out.dedupe = false;
    else if (a === '--sources') out.sources = (argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--json') out.json = true;
    else if (a === '-h' || a === '--help') out.help = true;
    else rest.push(a);
  }
  // bare args become companies if no --companies given
  if (out.companies.length === 0 && rest.length) out.companies = rest;
  return out;
}

const HELP = `Unified Jobs Aggregator — cross-source deduplicated public jobs feed

USAGE
  unified-jobs --keywords "<query>" --location "<place>" --companies <a,b,...>

OPTIONS
  -k, --keywords <q>     search query for LinkedIn (e.g. "backend engineer")
  -l, --location <loc>   location filter for LinkedIn
  -c, --companies <csv>  ATS companies: domains/slugs/"platform:token"
                         (e.g. stripe,lever:palantir,ashby:ramp)
      --sources <csv>    subset of: ats,linkedin  (default: both)
      --max <n>          max results per source (default 25)
      --no-dedupe        emit every source hit 1:1 (no cross-source merge)
      --json             print raw JSON records
  -h, --help

NOTE  This free CLI covers the keyless sources (ATS + LinkedIn public pages).
      The hosted Apify actor adds Indeed + rotating proxies + metered billing.
      Public postings only — no login, no member data.`;

// --- native-fetch LinkedIn guest search (zero-dep) -----------------------
const GUEST = 'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search';
function liSearchUrl({ keywords, location, start = 0 }) {
  const p = new URLSearchParams();
  if (keywords) p.set('keywords', keywords);
  if (location) p.set('location', location);
  if (start) p.set('start', String(start));
  return `${GUEST}?${p.toString()}`;
}
async function linkedinSearch({ keywords, location }, max, onLog) {
  const out = [];
  const seen = new Set();
  const PAGE = 10;
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    'Accept-Language': 'en-US,en;q=0.9',
  };
  for (let page = 0; page * PAGE < max + PAGE && out.length < max; page += 1) {
    const url = liSearchUrl({ keywords, location, start: page * PAGE });
    let res;
    try { res = await fetch(url, { headers }); } catch (e) { onLog(`linkedin fetch error: ${e.message}`); break; }
    if (!res.ok) { onLog(`linkedin HTTP ${res.status} (guest endpoint rate-limited — try the hosted actor for volume)`); break; }
    const html = await res.text();
    const jobs = parseSearch(html);
    if (jobs.length === 0) break;
    for (const j of jobs) {
      if (out.length >= max) break;
      const k = j.job_key || j.url;
      if (seen.has(k)) continue;
      seen.add(k);
      j.source_family = 'linkedin';
      out.push(j);
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || (!args.keywords && !args.location && args.companies.length === 0)) {
    console.log(HELP);
    process.exit(args.help ? 0 : 1);
  }
  const max = args.maxResultsPerSource || 25;
  const sources = args.sources || ['ats', 'linkedin'];
  const onLog = (m) => console.error(`· ${m}`);

  const pool = [];
  if (sources.includes('ats') && args.companies.length) {
    onLog(`ATS: resolving ${args.companies.length} compan(y/ies)...`);
    const { jobs } = await atsScrape({ companies: args.companies, maxItemsPerCompany: max }, (e) => onLog(`ats ${e.msg}`));
    for (const j of jobs) j.source_family = 'ats';
    pool.push(...jobs);
  }
  if (sources.includes('linkedin') && (args.keywords || args.location)) {
    onLog(`LinkedIn: searching "${args.keywords || ''}" @ "${args.location || ''}"...`);
    pool.push(...await linkedinSearch({ keywords: args.keywords, location: args.location }, max, onLog));
  }

  const records = dedupe(pool, { dedupe: args.dedupe !== false });
  const stats = dedupStats(pool.length, records);

  if (args.json) { process.stdout.write(JSON.stringify(records, null, 2) + '\n'); }
  else {
    console.error(`\n${stats.canonical_jobs} canonical jobs (${stats.raw_source_hits} source-hits, ${stats.cross_source_merges} cross-source merges)\n`);
    for (const r of records.slice(0, 60)) {
      const src = r.sources.map((s) => s.source_platform).join('+');
      const sal = r.salary ? ` — ${r.salary}` : '';
      const star = r.sources.length > 1 ? '★' : ' ';
      console.log(`${star} ${r.title}  @ ${r.company}  [${r.location || '—'}]  (${src})${sal}`);
    }
    if (records.length > 60) console.log(`  … and ${records.length - 60} more (use --json for all)`);
  }
}

main().catch((e) => { console.error('fatal:', e.message); process.exit(1); });
