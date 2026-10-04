# Legacy Python Projects (archived)

These three projects were the sources consolidated into the unified
TypeScript CLI (`linkedin`). They are archived **intact** — nothing was
deleted — and remain runnable on Linux (the Selenium stack) or with Python 3.8+
as before. The `osint` command group of the TypeScript CLI supersedes their
API-reachable capabilities.

## Port mapping

| Legacy file(s) | New TypeScript home | CLI command |
|----------------|---------------------|-------------|
| `linkedin2username-master/linkedin2username.py` — `get_results`, `find_employees`, `do_loops`, `GEO_REGIONS` | `src/osint/employees-query.ts` + `src/commands/osint/employees.ts` | `linkedin osint employees` |
| `linkedin2username-master/linkedin2username.py` — `NameMutator`, `write_files` | `src/osint/names.ts` + `src/commands/osint/names.ts` (+ tests ported from its pytest suite) | `linkedin osint names` |
| `linkedin-osint-toolkit-main/src/osint_classify_rules.py` + `classification_rules.json` | `src/osint/classify.ts` + `src/osint/data/classification_rules.json` (engine verified 75/75 against the Python self-test) | `linkedin osint classify` |
| `linkedin-osint-toolkit-main/src/osint_classify_ai.py` + `src/prompts/*.md` | `src/osint/ai-client.ts` + `src/osint/prompts.ts` | `linkedin osint ai-score` / `osint ai-classify` / `--use-ai` flags |
| `linkedin-osint-toolkit-main/src/osint_discover.py` (geo codes, industry categories) | `src/osint/geo-codes.ts`, `src/osint/industries.ts` | `linkedin osint discover` |
| `linkedin-osint-toolkit-main/src/osint_build_orgchart.py` | `src/osint/orgchart.ts` | `linkedin osint orgchart` |
| `linkedin-osint-toolkit-main/src/osint_generate_html.py` | `src/osint/matrix.ts` | `linkedin osint matrix` |
| `linkedin-osint-toolkit-main/src/org_chart_viewer.html` | `assets/org_chart_viewer.html` | interactive viewer (unchanged) |
| `linkedin-osint-toolkit-main/src/osint_stats.py`, `osint_scan.py` | `src/osint/stats.ts` | `linkedin osint stats` / `osint scan` |
| `linkedin-osint-toolkit-main/src/osint_scrape_profiles.py` | `src/commands/osint/deep-dive.ts` (uses the profileView API instead of Selenium) | `linkedin osint deep-dive` |
| `linkedin-osint-toolkit-main/src/osint_funnel.py`, `osint_pipeline.py` | `src/commands/osint/funnel.ts` | `linkedin osint funnel` |
| `linkedin-osint-master/outlook_http_client.py` | `src/osint/delve.ts` | `linkedin osint email-lookup` |
| `linkedin-osint-toolkit-main/src/osint_auth.py`, `osint_stealth.py`, `osint_scrape_company.py`, `osint_scrape_batch.py`, `ScreenLockPreventer` | **Not ported** — Selenium browser-mode scraping (Linux/Firefox only). The API path covers the same data more reliably; these files remain here for reference. | — |

## Notable deviations (improvements, documented)

- The original `find_employees` Dr-prefix strip had an off-by-one
  (`full_name[4:]` after checking `[:3]`); the port strips exactly `'Dr '`.
- `osint employees` dedupes names across loops (the original could repeat
  names across geoblast regions).
- Employee scraping runs at 50 results/page over the API (the original web
  flow fetched pages through the browser).

## Running the legacy tools

```bash
cd legacy/python/linkedin2username-master   # uv sync && uv run python linkedin2username.py -c targetco
cd legacy/python/linkedin-osint-toolkit-main # pip install -r requirements.txt && python src/osint_funnel.py --help
cd legacy/python/linkedin-osint-master       # python outlook_http_client.py emails.txt
```
