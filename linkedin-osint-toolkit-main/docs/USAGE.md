# Usage Guide

Detailed usage instructions for the LinkedIn OSINT Toolkit. For a quick overview, see the [README](../README.md).

---

## Full OSINT Funnel (recommended)

The recommended way to run the toolkit is `osint_funnel.py`, which chains all four phases (discover, scrape, classify, deep dive) with **one browser session**:

```bash
python src/osint_funnel.py --geo-code 103644278 --keyword "cybersecurity" --limit 5
```

This avoids session issues that arise when running individual scripts, since LinkedIn session cookies do not persist across browser restarts.

### Funnel Examples

```bash
# Full funnel: discover -> scrape -> classify
python src/osint_funnel.py --geo-code 103644278 --keyword "cybersecurity" --limit 5

# With deep dive on top 20 profiles
python src/osint_funnel.py --geo-code 103644278 --keyword "fintech" --limit 3 --deep-dive --deep-dive-limit 20

# Resume from an existing file (auto-detects format and starting phase)
python src/osint_funnel.py --input output/discovered_companies_usa_20260215_120000.json
python src/osint_funnel.py --input output/all_companies_people_20260215_120000.json

# Only run discovery (phase 1)
python src/osint_funnel.py --geo-code 103644278 --keyword "defense" --limit 10 --end-phase 1

# With AI-enhanced scoring and classification
python src/osint_funnel.py --geo-code 103644278 --keyword "cybersecurity" --limit 5 --use-ai

# Explicit credentials (or set LINKEDIN_EMAIL / LINKEDIN_PASSWORD in .env)
python src/osint_funnel.py --geo-code 103644278 -e user@mail.com -p pass123 --limit 5

# Route through a SOCKS5 proxy
python src/osint_funnel.py --geo-code 103644278 --keyword "defense" --limit 5 --proxy socks5://127.0.0.1:9050
```

### Funnel Phases

| Phase | Name | What it does | Output |
|-------|------|-------------|--------|
| 1 | DISCOVER | Find companies by region/keyword/industry | `discovered_companies_*_TIMESTAMP.json` |
| 2 | SCRAPE | Batch scrape people from discovered companies | `all_companies_people_TIMESTAMP.json` |
| 3 | CLASSIFY | Classify titles + build org chart JSON | `org_chart_TIMESTAMP.json` |
| 4 | DEEP DIVE | Visit individual profiles (optional, `--deep-dive`) | `deep_dive_results_TIMESTAMP.json` |

Open the result JSON in the interactive viewer: `firefox src/org_chart_viewer.html`

### Funnel Flags

| Flag | Description |
|------|-------------|
| `-i`, `--input` | Resume from an existing output file (auto-detects format) |
| `--start-phase` | Start from this phase (1-4, default: 1) |
| `--end-phase` | Stop after this phase (1-4, default: 4) |
| `-g`, `--geo-code` | LinkedIn geo code for company search (phase 1) |
| `-k`, `--keyword` | Search keyword for company discovery (phase 1) |
| `--industry` | Filter by industry category (phase 1) |
| `-r`, `--region-name` | Region label for output filenames |
| `-l`, `--limit` | Max companies to discover (default: 10) |
| `--deep-dive` | Enable phase 4: visit individual profiles |
| `--deep-dive-limit` | Max profiles to deep-dive |
| `-e`, `--email` | LinkedIn email |
| `-p`, `--password` | LinkedIn password |
| `-o`, `--output-dir` | Output directory (default: `output/`) |
| `--proxy` | Proxy URL (e.g., `socks5://host:port`, `http://host:port`) |
| `--headless` | Run browser in headless mode |
| `--use-ai` | Enable Groq AI enhancement |
| `-v`, `--verbose` | Enable verbose/debug logging |

---

## Single-Company Pipeline

For single-company workflows, `osint_pipeline.py` handles login, scraping, classification, and org chart generation:

```bash
python src/osint_pipeline.py acme-corp -e your@email.com -p yourpassword

# Full URL works too
python src/osint_pipeline.py https://linkedin.com/company/acme-corp -e user@email.com -p pass

# Limit scraping scope
python src/osint_pipeline.py acme-corp -e your@email.com -p yourpassword --max-pages 5 --max-profiles 100

# Headless mode
python src/osint_pipeline.py acme-corp -e your@email.com -p yourpassword --headless

# Re-run classification on an existing CSV (no browser needed)
python src/osint_pipeline.py --skip-scrape -c output/linkedin_company_acme-corp_20260214.csv

# AI-enhanced classification
python src/osint_pipeline.py acme-corp -e your@email.com -p yourpassword --use-ai
```

### Pipeline Output

All output is saved to `output/` by default (customizable with `-o`):

| File | Description |
|------|-------------|
| `output/linkedin_company_*_TIMESTAMP.csv` | Raw scraped employee data |
| `output/org_chart_*_TIMESTAMP.json` | Classified org chart data (open with the standalone viewer) |

### Viewing Results

Open `src/org_chart_viewer.html` in your browser and load any JSON file via the upload button. The viewer supports multiple JSON formats (org chart, batch scrape, deep dive, single company) and provides:

- **Tree View** (default): D3.js collapsible tree with zoom, pan, and level-by-level expand/collapse
- **Matrix View**: Grid of hierarchy tiers vs. departments with expandable cells

A demo dataset is available at `examples/demo_org_chart.json` for testing the viewer.

---

## AI Enhancement (Optional)

Add `--use-ai` to enable Groq LLM-powered classification. The AI enhances keyword-based results -- it never replaces them. When AI confidence is high and the keyword classifier returned a low-confidence result (Staff/General), the AI result is promoted.

The `--use-ai` flag is available on these scripts:

| Script | AI behavior |
|--------|-------------|
| `osint_pipeline.py` | Enhances the classification phase |
| `osint_build_orgchart.py` | Enhances title classification |
| `osint_discover.py` | Scores company relevance (pair with `--search-objective`) |
| `osint_scrape_profiles.py` | Deep classifies using full profile context (about, experience, education) |

AI system prompts are loaded from `src/prompts/` markdown files, which define the OSINT analyst persona, classification skills, scoring rubric, and data schemas.

Requires `GROQ_API_KEY` in your `.env` file. Get a free key at [console.groq.com](https://console.groq.com).

---

## Individual Scripts (advanced)

The individual scripts below can be used for more granular control. Each script that requires a browser session will start its own browser. Credentials are read from `.env` automatically; you can also pass `-e`/`-p` flags to override.

### Company Discovery (Macro)

Find companies in any region using LinkedIn geo codes. See [OSINT_METHODOLOGY.md](OSINT_METHODOLOGY.md) for discovery strategies and [REFERENCE.md](REFERENCE.md) for geo codes.

> **Tip:** Company discovery runs independently from the pipeline. Use it to find targets, then pass them to `osint_pipeline.py`.

```bash
# Discover companies in USA (geo code 103644278)
python src/osint_discover.py --geo-code 103644278 --region-name usa --limit 10

# Search for cybersecurity companies
python src/osint_discover.py --geo-code 103644278 --keyword "cybersecurity" --limit 20

# Filter by industry category
python src/osint_discover.py --geo-code 103644278 --industry Cybersecurity --limit 10

# Generate a list for batch scraping
python src/osint_discover.py --geo-code 103644278 --region-name usa --limit 10 --generate-list

# Save output in different formats (default: json)
python src/osint_discover.py --geo-code 103644278 --output companies.csv --format csv

# Use a cities file to validate company locations
python src/osint_discover.py --geo-code 103644278 --cities-file config/cities.txt --limit 15

# List all available industry categories
python src/osint_discover.py --list-industries

# List all available geo codes (51 countries)
python src/osint_discover.py --list-geo-codes

# AI-powered relevance scoring
python src/osint_discover.py --geo-code 103644278 --keyword "cybersecurity" --use-ai --search-objective "defense contractors with SOC teams"
```

Default output: `output/discovered_companies_<region>_TIMESTAMP.<format>`

Additional flags: `--headless`, `-v` (verbose), `--debug-selectors` (save raw HTML).

---

### Company Employee Scraping (Medium)

**Single company:**

```bash
python src/osint_scrape_company.py https://linkedin.com/company/target-company

# With login credentials (if session expired)
python src/osint_scrape_company.py target-company -e your@email.com -p yourpassword

# Custom output directory, limit pages/profiles
python src/osint_scrape_company.py target-company -o output --max-pages 10 --max-profiles 200
```

Default output directory: `output/`

**Multiple companies (batch):**

```bash
# From a TXT file (one URL per line, # comments supported)
python src/osint_scrape_batch.py companies.txt

# From a JSON file (output of osint_discover.py, preserves industry metadata)
python src/osint_scrape_batch.py output/discovered_companies_usa_20260215_120000.json

# With login credentials
python src/osint_scrape_batch.py companies.txt -e your@email.com -p yourpassword
```

Default output directory: `output/` (individual JSON per company + `all_companies_people_TIMESTAMP.json` master database).

---

### Profile Deep Dive (In-Depth)

```bash
# Deep dive on profiles from batch scrape results
python src/osint_scrape_profiles.py output/all_companies_people_20260215_120000.json --limit 50

# Resume from a specific profile number
python src/osint_scrape_profiles.py output/all_companies_people_20260215_120000.json --start 25 --limit 50

# With AI-enhanced deep classification
python src/osint_scrape_profiles.py output/all_companies_people_20260215_120000.json --use-ai --limit 50
```

Default output directory: `output/`

---

### Classification and Analysis

```bash
# Run the role classifier's built-in self-test
python src/osint_classify_rules.py

# Build org chart data from a scraped CSV
python src/osint_build_orgchart.py output/linkedin_company_acme_20260215_120000.csv

# Build org chart with AI-enhanced classification
python src/osint_build_orgchart.py output/linkedin_company_acme_20260215_120000.csv --use-ai

# Generate org chart HTML (legacy matrix view; prefer using src/org_chart_viewer.html instead)
python src/osint_generate_html.py output/org_chart_20260215_120000.json

# Analyze classification statistics across JSON data files
python src/osint_stats.py output/all_companies_people_20260215_120000.json

# Scan a directory of company JSONs and suggest new classification overrides
python src/osint_scan.py output/ --suggest 50
```

Classification rules are loaded from `src/classification_rules.json`. To tune classification, edit the JSON file directly -- the `osint_classify_rules.py` module is the engine only.

---

## Anti-Detection & Stealth

All browser-based scripts automatically apply stealth measures to reduce the risk of LinkedIn detecting automated activity:

- **User-Agent Rotation**: Random recent Firefox UA string (Linux, matching your actual OS)
- **Viewport Randomization**: Random common desktop resolution (avoids full-screen fingerprinting)
- **WebDriver Hiding**: `navigator.webdriver` patched to `undefined`, Selenium-injected properties removed
- **Telemetry Disabled**: Firefox telemetry, health reports, and WebRTC (IP leak) disabled
- **Human-Like Timing**: All delays use Gaussian distribution (clustered around a natural center with occasional longer pauses)
- **Human-Like Typing**: Login credentials are typed character-by-character with variable speed
- **Stealth JS Patches**: Injected after every page navigation to hide automation signals

### Proxy Support

Route all browser traffic through a proxy for IP rotation:

```bash
# SOCKS5 proxy
python src/osint_funnel.py --geo-code 103644278 --keyword "defense" --limit 5 --proxy socks5://127.0.0.1:9050

# HTTP proxy
python src/osint_pipeline.py acme-corp --proxy http://proxy.example.com:8080

# Works with all scripts that use a browser
python src/osint_discover.py --geo-code 103644278 --keyword "fintech" --limit 10 --proxy socks5://user:pass@host:1080
```

The `--proxy` flag is available on: `osint_funnel.py`, `osint_pipeline.py`, `osint_discover.py`, `osint_scrape_company.py`, `osint_scrape_batch.py`, `osint_scrape_profiles.py`.

DNS is routed through the proxy automatically (no DNS leaks).

### Best Practices for Avoiding Detection

1. **Don't run in full-screen** -- the toolkit randomizes viewport automatically
2. **Use reasonable limits** -- don't scrape 1000 profiles in one session
3. **Add pauses between sessions** -- wait hours/days between large runs
4. **Rotate IPs** -- use `--proxy` with a SOCKS5 rotating proxy service
5. **Don't run headless for LinkedIn** -- headless browsers have different fingerprints

---

## Graceful Interruption & Partial Results

All scripts support graceful interruption. Press **Ctrl+C** at any time to:

1. **Save whatever has been collected** -- partial company lists, scraped people, or profile data
2. **Print a summary** of saved files
3. **Exit cleanly** (browser is closed properly)

You can then **resume from the last saved file** using `--input`:

```bash
# Funnel was interrupted during phase 2 -- resume from the saved discovery file
python src/osint_funnel.py --input output/discovered_companies_usa_20260215_120000.json

# Pipeline was interrupted -- re-run classification on the partial CSV
python src/osint_pipeline.py --skip-scrape -c output/linkedin_company_acme_20260215_123456.csv
```

This also applies to **OTP timeouts**: if the OTP approval window expires, the toolkit saves whatever it managed to collect before the session expired.

## Login and Session Handling

The toolkit uses a shared login module (`src/osint_auth.py`) across all scrapers. The unified pipeline (`osint_pipeline.py`) keeps a single browser session open throughout the full workflow, so you only need to log in once. Individual scripts each start their own browser, so credentials must be provided every time.

> **Important:** LinkedIn uses session-only cookies that do not persist after the browser closes. This is why the unified pipeline is the recommended approach -- it keeps the browser open for the entire workflow.

### Login Scenarios

| Scenario | Behavior |
|----------|----------|
| Already logged in | Detected automatically, skips login |
| "Welcome Back" page | Clicks "Sign in using another account" automatically |
| Fresh login | Enters email/password, clicks submit |
| OTP/Challenge | Waits up to 2 minutes for phone approval |
| Session expired during batch | Re-authenticates automatically (every 5 companies) |
| Auth redirect during navigation | Retries with exponential backoff + re-auth |

### Session Persistence

Sessions are saved to the auto-detected Firefox profile (typically `~/.mozilla/firefox/*.default-esr`). After a successful login, subsequent runs reuse the saved session without re-authentication.

The `find_firefox_profile()` function in `osint_auth.py` searches these locations, in order:

1. **Native Firefox**: `~/.mozilla/firefox/`
2. **Snap Firefox**: `~/snap/firefox/common/.mozilla/firefox/`
3. **Flatpak Firefox**: `~/.var/app/org.mozilla.firefox/.mozilla/firefox/`

Within each location, it prefers profiles with these suffixes:
1. `.default-esr` (Firefox ESR)
2. `.default-release` (Firefox Release)
3. `.default` (fallback)

### Error Recovery

All navigation uses exponential backoff retry (3 attempts). If an auth redirect is detected (`/login` or `/authwall`), the toolkit automatically re-authenticates if credentials are available.

### Troubleshooting

- **"Login timeout"**: Ensure you approve the OTP within 2 minutes
- **"Auth redirect detected"**: Your session expired; provide `-e` and `-p` flags
- **"No Firefox profile found"**: Run `python src/osint_auth.py` first to create the session
- **Rate limiting**: The toolkit uses random delays between actions; increase delays if needed

---

## Testing Commands Cheatsheet

One-liner commands to test every stage of the OSINT funnel. All scripts read credentials from `.env` automatically -- no need for `-e`/`-p` flags if `LINKEDIN_EMAIL` and `LINKEDIN_PASSWORD` are set there.

### Stage 0: Setup and Offline Checks (no browser)

```bash
# Verify dependencies are installed
pip install -r requirements.txt && echo "Dependencies OK"

# Run the keyword classifier self-test (verifies classification_rules.json)
python src/osint_classify_rules.py

# Check if Groq AI is available (requires GROQ_API_KEY in .env)
python src/osint_classify_ai.py

# Open the org chart viewer with the demo dataset (just open in browser)
firefox src/org_chart_viewer.html
```

### Stage 1: Macro -- Company Discovery

```bash
# Discover 10 cybersecurity companies in the USA
python src/osint_discover.py --geo-code 103644278 --keyword "cybersecurity" --region-name usa --limit 10

# Discover companies filtered by industry
python src/osint_discover.py --geo-code 103644278 --industry Cybersecurity --region-name usa --limit 10

# List all available industry categories
python src/osint_discover.py --list-industries

# List all 51 built-in geo codes
python src/osint_discover.py --list-geo-codes

# Save discovery results as a batch-ready list
python src/osint_discover.py --geo-code 103644278 --keyword "cybersecurity" --region-name usa --limit 10 --generate-list

# Export as CSV
python src/osint_discover.py --geo-code 103644278 --keyword "cybersecurity" --region-name usa --limit 10 --format csv --output output/discovered.csv

# With AI relevance scoring
python src/osint_discover.py --geo-code 103644278 --keyword "cybersecurity" --region-name usa --limit 10 --use-ai --search-objective "defense contractors with active SOC teams"

# Discover in UK with AI scoring
python src/osint_discover.py --geo-code 101165590 --keyword "fintech" --region-name uk --limit 15 --use-ai --search-objective "fintech companies handling PII data"
```

### Stage 2: Medium -- Scrape Employee Lists

```bash
# Full pipeline: single company (login + scrape + classify + JSON output)
python src/osint_pipeline.py acme-corp

# Full pipeline with AI-enhanced classification
python src/osint_pipeline.py acme-corp --use-ai

# Full pipeline with scraping limits
python src/osint_pipeline.py acme-corp --max-pages 3 --max-profiles 50

# Full pipeline in headless mode
python src/osint_pipeline.py acme-corp --headless

# Re-classify an existing CSV without browser (offline)
python src/osint_pipeline.py --skip-scrape -c output/linkedin_company_acme-corp_20260214.csv

# Re-classify with AI
python src/osint_pipeline.py --skip-scrape -c output/linkedin_company_acme-corp_20260214.csv --use-ai

# Individual: scrape a single company directly
python src/osint_scrape_company.py acme-corp

# Individual: batch scrape from a text list
python src/osint_scrape_batch.py companies.txt

# Individual: batch scrape from discovery JSON (preserves industry metadata)
python src/osint_scrape_batch.py output/discovered_companies_usa_20260215_120000.json
```

### Stage 3: In-Depth -- Profile Deep Dive

```bash
# Deep dive on batch scrape results (first 50 profiles)
python src/osint_scrape_profiles.py output/all_companies_people_20260215_120000.json --limit 50

# Deep dive with AI-enhanced classification
python src/osint_scrape_profiles.py output/all_companies_people_20260215_120000.json --limit 50 --use-ai

# Resume deep dive from profile #25
python src/osint_scrape_profiles.py output/all_companies_people_20260215_120000.json --start 25 --limit 50

# Deep dive on pipeline output
python src/osint_scrape_profiles.py output/org_chart_acme-corp_20260215_120000.json --limit 20 --use-ai
```

### Stage 4: Analysis and Visualization

```bash
# Build org chart from scraped CSV (offline)
python src/osint_build_orgchart.py output/linkedin_company_acme_20260215_120000.csv

# Build org chart with AI-enhanced classification (offline, needs GROQ_API_KEY)
python src/osint_build_orgchart.py output/linkedin_company_acme_20260215_120000.csv --use-ai

# Analyze classification statistics
python src/osint_stats.py output/org_chart_20260215_120000.json

# Analyze batch scrape results
python src/osint_stats.py output/all_companies_people_20260215_120000.json

# Scan and suggest classification overrides
python src/osint_scan.py output/ --suggest 50

# Export scan suggestions as JSON
python src/osint_scan.py output/ --json-suggest output/overrides.json

# Open viewer with results
firefox src/org_chart_viewer.html
# Then upload any JSON from output/ via the UI
```

### Full Funnel: End-to-End (single command)

```bash
# The unified funnel replaces manual step chaining -- one command does it all:
python src/osint_funnel.py \
  --geo-code 103644278 --keyword "cybersecurity" --region-name usa \
  --limit 10 --deep-dive --deep-dive-limit 50 --use-ai

# Or run phases selectively:
# Discovery only
python src/osint_funnel.py --geo-code 103644278 --keyword "cybersecurity" --limit 10 --end-phase 1

# Resume from existing discovery output
python src/osint_funnel.py --input output/discovered_companies_usa_20260215_120000.json

# Resume from existing batch scrape (phases 3-4 only)
python src/osint_funnel.py --input output/all_companies_people_20260215_120000.json --start-phase 3

# View results
firefox src/org_chart_viewer.html
# Upload any JSON from output/
```

### Quick Smoke Tests (no LinkedIn account needed)

```bash
# Verify all modules load correctly
python -c "from src.osint_auth import create_browser; from src.osint_classify_rules import classify_title; from src.osint_classify_ai import is_available; print('All imports OK')"

# Test keyword classifier on a sample title
python -c "from src.osint_classify_rules import classify_title; r = classify_title('Senior Cyber Security Manager'); print(r)"

# Test AI module availability
python -c "from src.osint_classify_ai import is_available; print('AI available:', is_available())"

# Test AI self-test (requires GROQ_API_KEY in .env)
cd src && python osint_classify_ai.py

# View demo data in the org chart viewer
firefox src/org_chart_viewer.html
# Load examples/demo_org_chart.json via the upload button
```
