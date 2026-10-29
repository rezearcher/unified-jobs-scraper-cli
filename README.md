# unified-jobs-scraper-cli

[![source-freshness](https://github.com/rezearcher/unified-jobs-scraper-cli/actions/workflows/freshness.yml/badge.svg)](https://github.com/rezearcher/unified-jobs-scraper-cli/actions/workflows/freshness.yml)

**One deduplicated jobs feed across company ATS boards and LinkedIn public postings — zero dependencies, zero API keys.**

Most job scrapers give you one source. Run a few of them and you own the hard part:
the same role shows up on LinkedIn, on Indeed, and on the company's own careers page,
and now you have three near-duplicates to reconcile across three different schemas.

This CLI queries the **public ATS boards** of any company (Greenhouse, Lever, Ashby,
SmartRecruiters, Workday, Recruitee, Workable) **and** LinkedIn's public job search,
then **merges the duplicates**: the same role collapses into one canonical record
with a `sources[]` array listing every place it appeared and the union of the richest
fields.

## Run it (no install)

```bash
npx github:rezearcher/unified-jobs-scraper-cli \
  --keywords "data engineer" --location "United States" \
  --companies lever:palantir,ashby:ramp,stripe.com
```

Or list what it does:

```bash
npx github:rezearcher/unified-jobs-scraper-cli --help
```

## Example

```
$ npx github:rezearcher/unified-jobs-scraper-cli -k "palantir" -l "United States" -c lever:palantir

35 canonical jobs (45 source-hits, 10 cross-source merges)

★ Backend Software Engineer - Infrastructure  @ palantir  [New York, NY]  (lever+linkedin)
★ Commercial Contracts Specialist             @ palantir  [Palo Alto, CA]  (lever+linkedin)
  Data Engineer - Talent Acquisition          @ palantir  [New York, NY]  (lever)
  ...
```

A `★` marks a role found on more than one source. Add `--json` for the full records
(stable id, normalized salary, ISO post date, and the `sources[]` array).

## Options

| Flag | Meaning |
|------|---------|
| `-k, --keywords <q>` | LinkedIn search query |
| `-l, --location <loc>` | LinkedIn location filter |
| `-c, --companies <csv>` | ATS companies: domains / slugs / `platform:token` |
| `--sources <csv>` | subset of `ats,linkedin` (default: both) |
| `--max <n>` | max results per source (default 25) |
| `--no-dedupe` | emit every source hit 1:1 (no merge) |
| `--json` | print raw JSON records |

## How the dedup works

A canonical job key is `normalized-company | normalized-title | city`. Company legal
suffixes (`Inc`, `LLC`, `GmbH`…) are stripped so `Stripe` and `Stripe, Inc.` match.
It is deliberately conservative — seniority words and role qualifiers are kept, so two
genuinely different openings are never force-merged — and it degrades open: a record
that can't be matched confidently is kept on its own, never dropped.

## Scope

Public job postings only — company ATS public JSON and LinkedIn's public guest pages.
No login, no cookies, no member data.

## Maintained — live source health

Job feeds drift silently: a renamed field returns rows with `null` titles, a moved
endpoint returns zero — the run "succeeds" but the data is junk. A scheduled probe
runs **daily** ([`.github/workflows/freshness.yml`](.github/workflows/freshness.yml)),
hitting a large live canary per source and grading reachable / populated /
schema-intact. The seven ATS adapters are hard-gated; LinkedIn's guest endpoint is
advisory (it rate-limits cloud IPs, so a block never raises a false alarm — only a
genuine card-HTML reshape does). On real drift the probe opens a tracking issue, so
breakage is caught before it reaches your run. Run it yourself any time:

```bash
node health-check.mjs            # probe every source against live canaries
node health-check.mjs ats        # ATS adapters only
```

## Need more?

This CLI covers the keyless sources for small pulls. A hosted version on the Apify
Store adds Indeed, rotating proxies for high-volume pulls, and metered billing.

## License

ISC.
