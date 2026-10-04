# LinkedIn OSINT Toolkit - Architecture

## System Overview

```mermaid
flowchart LR
    Discover["Phase 1\nDiscover"] --> Scrape["Phase 2\nScrape"]
    Scrape --> Classify["Phase 3\nClassify"]
    Classify --> DeepDive["Phase 4\nDeep Dive"]
    DeepDive --> Viewer["Interactive Viewer\norg_chart_viewer.html"]
```

The toolkit follows a four-phase funnel: discover target companies, scrape employee data, classify roles by hierarchy and division, and optionally deep dive into individual profiles. Results are explored in the interactive viewer (`src/org_chart_viewer.html`).

---

## Unified Funnel: `osint_funnel.py`

The recommended entry point is `osint_funnel.py`, which orchestrates the full macro-to-micro funnel using a **single browser session**. This solves LinkedIn's session-only cookie problem -- since cookies are lost when the browser closes, the funnel keeps the browser open throughout all phases.

```mermaid
flowchart LR
    CLI["osint_funnel.py"] --> Login["Login\n(osint_auth)"]
    Login --> P1["Discover\n(osint_discover)"]
    P1 --> P2["Batch Scrape\n(osint_scrape_batch)"]
    P2 --> P3["Classify\n(osint_build_orgchart)"]
    P3 --> P4["Deep Dive\n(osint_scrape_profiles)"]
    P4 --> Viewer["org_chart_viewer.html\n(interactive)"]
    Login -.->|single browser session| P2
    P2 -.->|shared driver| P4
```

The funnel imports each phase as a module, passing the browser instance (`driver`) throughout so no re-authentication is needed. Supports `--start-phase` / `--end-phase` to run any slice, and `--input` to resume from an existing output file.

## Single-Company Pipeline: `osint_pipeline.py`

For single-company workflows, `osint_pipeline.py` provides a simpler entry point that handles login, scraping, and classification:

```mermaid
flowchart LR
    CLI["osint_pipeline.py"] --> Login["Login\n(osint_auth)"]
    Login --> Scrape["Scrape\n(osint_scrape_company)"]
    Scrape --> Classify["Classify & Build\n(osint_build_orgchart)"]
    Classify --> Output["Output JSON\n(org_chart_viewer.html)"]
```

---

## Shared Module: `osint_auth.py`

All scrapers and the unified pipeline import from a single shared login module to ensure consistent authentication behavior.

```mermaid
flowchart TB
    subgraph authModule [osint_auth.py]
        findProfile["find_firefox_profile()"]
        normalize["normalize_input()"]
        createBrowser["create_browser()"]
        checkSession["check_session()"]
        loginFn["login_to_linkedin()"]
        ensureLogged["ensure_logged_in()"]
        navRetry["navigate_with_retry()"]
        killStale["kill_stale_browsers()"]
        setupLog["setup_logging()"]
    end

    funnel["osint_funnel.py"] --> authModule
    pipeline["osint_pipeline.py"] --> authModule
    batch["osint_scrape_batch.py"] --> authModule
    single["osint_scrape_company.py"] --> authModule
    discover["osint_discover.py"] --> authModule
    deepdive["osint_scrape_profiles.py"] --> authModule
```

| Function | Purpose |
|----------|---------|
| `find_firefox_profile()` | Auto-detect user's Firefox profile directory (native, Snap, Flatpak) |
| `normalize_input()` | Normalize company name/URL to people page URL |
| `create_browser()` | Create Firefox WebDriver with profile session and resilient geckodriver resolution |
| `check_session()` | Validate if LinkedIn session is active |
| `login_to_linkedin()` | Full login with Welcome Back + OTP handling |
| `ensure_logged_in()` | Check session, re-authenticate if expired |
| `navigate_with_retry()` | Navigate with exponential backoff + auth retry |
| `kill_stale_browsers()` | Kill orphaned geckodriver/firefox processes to prevent file locks |
| `setup_logging()` | Configure logging level and optional log file for the toolkit |

---

## Stealth Module: `osint_stealth.py`

Centralized anti-detection module imported by `osint_auth.py` and all scraper scripts. Designed around **consistency over randomization** -- coherent browser personas rather than suspicious mixed signals.

```mermaid
flowchart TB
    subgraph stealthModule [osint_stealth.py]
        stealthPrefs["apply_stealth_preferences()
UA rotation, telemetry off,
WebRTC off, accept-language"]
        stealthJS["apply_stealth_js()
Hide navigator.webdriver,
patch plugins/languages"]
        viewport["get_random_viewport()
Weighted common resolutions
+/- small random offset"]
        humanDelay["human_delay()
Gaussian-distributed sleep"]
        humanType["human_type()
Char-by-char with variable speed"]
        randScroll["random_scroll()
Variable scroll with occasional up"]
        proxy["apply_proxy()
SOCKS5/HTTP via Firefox prefs"]
    end

    auth["osint_auth.py"] --> stealthModule
    auth -->|"create_browser()"| stealthPrefs
    auth -->|"create_browser()"| viewport
    auth -->|"create_browser()"| proxy
    auth -->|"navigate_with_retry()"| stealthJS
    auth -->|"login_to_linkedin()"| humanType
    auth -->|"login_to_linkedin()"| humanDelay

    scrapers["All scraper scripts"] -->|"import"| humanDelay
    scrapers -->|"import"| randScroll
    scrapers -->|"import"| stealthJS
```

| Function | Purpose |
|----------|---------|
| `apply_stealth_preferences()` | Firefox prefs: hide WebDriver, rotate UA, disable telemetry/WebRTC |
| `apply_stealth_js()` | JS patches after each navigation: `navigator.webdriver`, plugins, languages |
| `get_random_viewport()` | Weighted random desktop resolution (avoids full-screen fingerprinting) |
| `get_random_user_agent()` | Recent Firefox Linux UA with weighted version selection |
| `human_delay()` | Gaussian-distributed sleep (natural timing, not uniform) |
| `human_type()` | Character-by-character typing with variable speed and occasional pauses |
| `random_scroll()` | Human-like scrolling (variable distance, occasional scroll-up) |
| `apply_proxy()` | SOCKS5/HTTP proxy via Firefox preferences (DNS routed through proxy) |

---

## Phase 1: Company Discovery

```mermaid
flowchart TD
    params["Input: --geo-code, --keyword,\n--industry, --limit"] --> discovery["osint_discover.py"]
    discovery --> search["LinkedIn Company Search"]
    search --> extract["Extract: name, URL,\nindustry, location"]
    extract --> classify_ind["Classify industry\ninto standard categories"]
    classify_ind --> output_disc["Output: JSON / CSV / TXT\nOptional: companies.txt for batch"]
```

---

## Phase 2: Data Collection

```mermaid
flowchart TB
    subgraph scrapers [Data Collection Layer]
        single_scraper["osint_scrape_company.py\n- Single company\n- People list + Show More\n- Optional login"]
        batch_scraper["osint_scrape_batch.py\n- Multi-company\n- Session check every 5 companies\n- Auto re-auth + master DB"]
        deep_dive["osint_scrape_profiles.py\n- Per-profile analysis\n- About, Skills, Experience\n- Session check every 20 profiles"]
    end

    linkedin["LinkedIn.com"] --> scrapers
    scrapers --> authMod["osint_auth.py\nshared login and retry"]
```

### Collection Scripts

| Script | Purpose | Input | Output |
|--------|---------|-------|--------|
| `osint_auth.py` | Authenticate and save session | Email, Password | Firefox profile with session |
| `osint_scrape_company.py` | Scrape single company | Company URL/name | CSV with people |
| `osint_scrape_batch.py` | Scrape multiple companies | `list.txt` or JSON | JSON per company + master DB |
| `osint_discover.py` | Discover companies by region | Geo code, keywords | JSON/CSV/TXT |
| `osint_scrape_profiles.py` | Analyze individual profiles | Profile URLs (JSON) | Detailed profile JSON |

---

## Phase 3: Classification

All classification patterns, keywords, and overrides are stored in `src/classification_rules.json` (learned from ~30K real profiles). The `osint_classify_rules.py` module is the engine -- it loads the JSON at import time and exposes the public API. To tune classification, edit the JSON file directly.

```mermaid
flowchart TD
    rulesJson["classification_rules.json\nPatterns, keywords, overrides"] --> classifier["osint_classify_rules.py\nKeyword engine"]
    input_title["Input: Job Title\ne.g. Senior Cyber Security Manager"] --> classifier
    classifier --> hierarchy["Hierarchy Classification\nCollect all matches, return highest weight"]
    hierarchy --> levels["Executive 100 > VP 90 > Director 80\n> Head 70 > Manager 60 > Lead 50\n> Senior 45 > Specialist 40 > Mid-Level 30\n> Junior 20 > Entry 10 > Staff 5"]
    levels --> division["Division Classification\nKeyword scoring, longest match wins"]
    division --> categories["18 categories:\nCyber Security, IT Infrastructure,\nSoftware Dev, Data/AI, R&D, Product,\nProject Mgmt, Operations, Finance, HR,\nMarketing, Sales, Legal, Customer Service,\nStrategy, Intelligence, Military/Defense, General"]
    categories --> output_class["Output:\nrole_level + role_weight + division"]

    output_class --> importers["Imported by:\nosint_build_orgchart.py\nosint_generate_html.py\nosint_stats.py\nosint_scan.py"]

    output_class -->|"--use-ai"| aiEnhance["osint_classify_ai.py\nGroq LLM optional pass\nPromote if confidence > 0.8"]
```

### Optional AI Enhancement

When `--use-ai` is passed, the `osint_classify_ai.py` module makes Groq API calls to enhance classification results. AI never replaces keyword rules -- it adds `ai_*` fields and only promotes the AI result when confidence is high and the keyword result was low-confidence. System prompts are loaded from `src/prompts/`.

| Level | Function | What it does |
|-------|----------|-------------|
| Macro | `score_companies()` | Score discovered companies for relevance to a search objective |
| Medium | `enhance_classifications_batch()` | Batch-enhance title classifications (10 per API call) |
| In-depth | `deep_classify()` | Classify using full profile data (about, experience, education) |

### Classification Analysis Tools

| Script | Purpose | Input | Output |
|--------|---------|-------|--------|
| `osint_stats.py` | Analyze hierarchy/division distribution | JSON data files | Terminal report with unclassified samples |
| `osint_scan.py` | Scan a directory of company JSONs, suggest new overrides | Directory path | Distribution report + suggested `title_overrides` |

---

## Output & Visualization

```mermaid
flowchart LR
    csv_input["CSV from scraper"] --> buildOrg["osint_build_orgchart.py\n- Load CSV profiles\n- Merge profile images\n- Classify with osint_classify_rules\n- Group by division\n- Sort by hierarchy"]
    buildOrg --> orgJson["Org chart JSON"]
    orgJson --> viewer["org_chart_viewer.html\n- D3.js collapsible tree\n- Matrix grid view\n- Search, zoom, expand/collapse\n- Client-side JSON upload"]
```

---

## Complete Data Flow

```mermaid
flowchart TD
    funnel["osint_funnel.py\nUnified entry point"]
    funnel --> geoParams["Geo code + keywords"]
    geoParams --> discovery["osint_discover.py\nPhase 1: Discover companies"]
    discovery --> companyURLs["discovered_companies JSON"]

    companyURLs --> batchScrape["osint_scrape_batch.py\nPhase 2: Batch scrape people\nSession check every 5"]
    batchScrape --> scrapeJSON["all_companies_people JSON"]

    scrapeJSON --> classifier["osint_classify_rules.py\nPhase 3: Classify titles"]
    classifier --> buildOrg["osint_build_orgchart.py\nBuild org chart data"]
    buildOrg --> orgJSON["org_chart JSON"]

    scrapeJSON --> deepDive["osint_scrape_profiles.py\nPhase 4: Deep dive profiles\nAbout, Skills, Experience"]
    deepDive --> deepJSON["deep_dive_results JSON"]

    orgJSON --> viewer["org_chart_viewer.html\nInteractive viewer"]
    deepJSON --> viewer

    funnel -.->|single browser session| batchScrape
    funnel -.->|shared driver| deepDive
    funnel -.->|"Ctrl+C saves partial results"| scrapeJSON
```

---

## File Structure

```
linkedin/
|
|-- src/                                # Main source code
|   |-- osint_funnel.py               # Unified funnel: discover -> scrape -> classify -> deep dive
|   |-- osint_pipeline.py              # Single-company pipeline (login + scrape + classify)
|   |-- osint_auth.py                  # Shared: login, session, retry, URL normalization (stealth integrated)
|   |-- osint_stealth.py              # Anti-detection: UA rotation, viewport, timing, proxy support
|   |-- osint_discover.py             # Macro: company discovery by region
|   |-- osint_scrape_company.py       # Medium: single company scraper
|   |-- osint_scrape_batch.py         # Medium: multi-company batch scraper
|   |-- osint_scrape_profiles.py      # In-depth: individual profile analyzer
|   |-- osint_classify_rules.py       # Classify: keyword-based role/division engine
|   |-- osint_classify_ai.py          # Classify: optional Groq AI enhancement
|   |-- classification_rules.json     # Classification patterns, keywords, overrides (~30K profiles)
|   |-- osint_build_orgchart.py       # Output: org chart data builder (CSV input)
|   |-- osint_generate_html.py        # Output: legacy HTML chart generator
|   |-- org_chart_viewer.html         # Standalone interactive viewer (D3.js tree + matrix)
|   |-- osint_stats.py               # Analysis: classification statistics
|   |-- osint_scan.py                # Analysis: classification scanner with override suggestions
|   +-- prompts/                      # AI system prompts and skill definitions
|       |-- system_prompt.md
|       |-- skill_classify.md
|       |-- skill_score.md
|       +-- tool_definitions.md
|
|-- tests/                            # Test suite
|   +-- __init__.py                   # Test package
|
|-- docs/                             # Documentation
|   |-- ARCHITECTURE.md               # This file
|   |-- USAGE.md                      # Detailed usage guide
|   |-- REFERENCE.md                  # Classification tables and geo codes
|   +-- OSINT_METHODOLOGY.md          # OSINT approach guide
|
|-- examples/                         # Example input files
|   |-- companies_list.txt.example
|   +-- demo_org_chart.json           # Demo dataset for the org chart viewer
|
|-- .github/                          # GitHub CI and templates
|   |-- workflows/ci.yml
|   |-- ISSUE_TEMPLATE/
|   +-- PULL_REQUEST_TEMPLATE.md
|
|-- assets/                           # Logo and screenshot images
|-- output/                           # Results directory (gitignored)
|-- pyproject.toml                    # Packaging and tool configuration
|-- requirements.txt                  # Python dependencies
|-- Makefile                          # install / lint / test shortcuts
|-- .env.example                      # Environment variable template
|-- .editorconfig                     # Editor formatting rules
|-- CONTRIBUTING.md                   # Contributor guidelines
|-- CHANGELOG.md                      # Version history
|-- SECURITY.md                       # Vulnerability disclosure policy
|-- .gitignore
|-- LICENSE                           # MIT License
+-- README.md
```

---

*Architecture document for the LinkedIn OSINT Toolkit*
