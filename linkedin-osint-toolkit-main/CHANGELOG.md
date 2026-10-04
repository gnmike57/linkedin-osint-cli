# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and
this project adheres to [Semantic Versioning](https://semver.org/).

## [0.8.0] - 2026-02-15

Anti-detection stealth module, graceful interruption with partial result saving, and proxy support.

### Added

- **`src/osint_stealth.py`** -- new centralized anti-detection module with:
  - User-Agent rotation (recent Firefox versions on Linux, weighted toward newer)
  - Viewport randomization (common desktop resolutions with small offsets)
  - WebDriver hiding (`navigator.webdriver` patched, Selenium properties removed)
  - Firefox preference hardening (telemetry, WebRTC, geolocation disabled)
  - JavaScript stealth patches (plugins, languages, permissions API)
  - Human-like timing (`human_delay()` with Gaussian distribution)
  - Human-like typing (`human_type()` with variable speed and occasional pauses)
  - Natural scrolling (`random_scroll()` with variable distance and direction)
  - SOCKS5/HTTP proxy support (`apply_proxy()` with DNS routing through proxy)
- **`--proxy` flag** on all browser-based scripts: `osint_funnel.py`, `osint_pipeline.py`, `osint_discover.py`, `osint_scrape_company.py`, `osint_scrape_batch.py`, `osint_scrape_profiles.py`
- **Graceful interruption**: every file-producing script saves partial results on Ctrl+C, OTP timeout, or unexpected errors. Covers: `osint_funnel.py`, `osint_pipeline.py`, `osint_discover.py`, `osint_scrape_company.py`, `osint_scrape_batch.py`, `osint_scrape_profiles.py`, `osint_build_orgchart.py`, `osint_generate_html.py`, and `osint_scan.py`. Funnel prints a summary of saved files and suggests `--input` to resume.
- `PROXY_URL` environment variable in `.env.example`

### Changed

- **`osint_auth.py`**: `create_browser()` now accepts `proxy_url` parameter and automatically applies stealth preferences, random viewport, and stealth JS injection. `login_to_linkedin()` uses `human_type()` for credential entry. `navigate_with_retry()` injects stealth JS after each successful navigation.
- **All scraper scripts**: replaced uniform `time.sleep(random.uniform(...))` delays with `human_delay()` (Gaussian distribution) from the stealth module.
- **`osint_funnel.py`**: `KeyboardInterrupt` handler now prints a detailed summary of saved partial files and suggests `--input` to resume. Also catches generic `Exception`.
- **`osint_discover.py`**: `KeyboardInterrupt` during search saves partial company list. Inner search loop catches interrupts gracefully. Added `proxy_url` parameter to `OSINTCompanyDiscovery` class.
- **`osint_pipeline.py`**: `KeyboardInterrupt` during scraping saves partial CSV and **continues to classification** phase with partial data (previously it would exit).
- **`osint_build_orgchart.py`**: wrapped classification + save in try/except; saves partial org chart JSON if interrupted mid-classification.
- **`osint_generate_html.py`**: wrapped generation in try/except; reports partial output state on interrupt.
- **`osint_scan.py`**: wrapped analysis loop in try/except; saves partial JSON suggestions (`--json-suggest`) if interrupted.
- **`osint_scrape_profiles.py`**: `deep_dive()` now accepts `proxy_url` parameter.
- `pyproject.toml` version bumped to `0.8.0`.
- `README.md` updated with Anti-Detection, Proxy Support, and Graceful Interruption features.
- `docs/USAGE.md` added Anti-Detection & Stealth section, Proxy Support section, Graceful Interruption section.
- `docs/ARCHITECTURE.md` added Stealth Module section with mermaid diagram and function table.

## [0.7.0] - 2026-02-15

Unified OSINT funnel, flat output directory, unique timestamped filenames, and multi-format viewer support.

### Added

- `src/osint_funnel.py` -- unified macro-to-micro OSINT script that chains four phases (discover, scrape, classify, deep dive) with a single browser session. Supports `--start-phase`/`--end-phase`, `--input` to resume from any file, and `--deep-dive` for optional profile analysis. HTML generation removed -- use the interactive viewer (`src/org_chart_viewer.html`) instead.
- `org_chart_viewer.html` now supports loading four JSON formats: org chart (`divisions`), batch scrape (`companies`), deep dive (`profiles`), and single company (`people`). Includes a lightweight client-side title classifier for on-the-fly classification.

### Changed

- **Flat output directory**: removed all output subfolders (`batch_scrape/`, `scrape_data/`, `deep_dive/`). All scripts now save directly to `output/`.
- **Unique filenames**: all output files now include timestamps (`YYYYMMDD_HHMMSS`) to prevent overwrites across runs. Affected scripts: `osint_scrape_batch.py`, `osint_pipeline.py`, `osint_build_orgchart.py`, `osint_generate_html.py`.
- `osint_scan.py` updated to skip timestamped aggregate files via prefix matching.
- `README.md` -- added `osint_funnel.py` as recommended entry point; updated Quick Start, script table, project structure, and all output path references.
- `docs/USAGE.md` -- added "Full OSINT Funnel" section; replaced manual chained commands with `osint_funnel.py` usage; fixed all ~20 outdated subfolder path references.
- `docs/ARCHITECTURE.md` -- added `osint_funnel.py` to system overview, pipeline diagrams, data flow, auth module consumers, and file structure tree.

## [0.6.0] - 2026-02-14

Unified file naming convention across all scripts and externalized AI prompts.

### Added

- `src/prompts/` directory with externalized Groq AI prompt files:
  - `system_prompt.md` -- core OSINT analyst persona and behavior rules
  - `skill_classify.md` -- title and profile classification skill definition
  - `skill_score.md` -- company relevance scoring skill definition
  - `tool_definitions.md` -- input/output data schemas for all AI functions

### Changed

- **Renamed all Python scripts** to a consistent `osint_<phase>_<purpose>.py` convention reflecting the OSINT funnel:

| Old Name | New Name | Phase |
|----------|----------|-------|
| `linkedin_osint.py` | `osint_pipeline.py` | Entry point |
| `linkedin_login.py` | `osint_auth.py` | Authentication |
| `osint_company_discovery.py` | `osint_discover.py` | Macro discovery |
| `linkedin_company_people_scraper.py` | `osint_scrape_company.py` | Medium scraping |
| `batch_company_scraper.py` | `osint_scrape_batch.py` | Medium scraping |
| `profile_deep_dive.py` | `osint_scrape_profiles.py` | In-depth scraping |
| `role_classifier.py` | `osint_classify_rules.py` | Classification |
| `ai_enhancer.py` | `osint_classify_ai.py` | Classification |
| `build_org_chart_data.py` | `osint_build_orgchart.py` | Output building |
| `generate_org_chart_visjs.py` | `osint_generate_html.py` | Output building |
| `keyword_stats.py` | `osint_stats.py` | Analysis |
| `scan_classifications.py` | `osint_scan.py` | Analysis |

- All internal imports, docstrings, CLI examples, and epilogs updated to use new module names
- `osint_classify_ai.py` now loads system prompts from `src/prompts/` markdown files at runtime instead of inline strings
- `README.md` -- updated project structure tree, script table, and all CLI examples with new filenames
- `docs/ARCHITECTURE.md` -- full rewrite of all diagrams, tables, and file structure tree with new filenames; added `src/prompts/` to structure
- `docs/USAGE.md` -- updated all CLI examples and module references
- `docs/REFERENCE.md` -- updated module name references
- `docs/OSINT_METHODOLOGY.md` -- updated script reference

## [0.5.0] - 2026-02-14

Optional Groq AI integration across all three OSINT depth levels.

### Added

- `src/osint_classify_ai.py` -- new module providing optional Groq LLM-powered enhancement for company scoring, title classification, and deep profile classification
- `--use-ai` flag on `osint_pipeline.py`, `osint_discover.py`, `osint_build_orgchart.py`, and `osint_scrape_profiles.py`
- `--search-objective` flag on `osint_discover.py` for AI relevance scoring
- Three AI enhancement levels: macro (company scoring), medium (batch title classification), in-depth (full profile deep classification)
- Batch mode for title classification (10 titles per API call) to reduce Groq API usage
- AI results stored as `ai_*` prefixed fields alongside keyword results; AI promotes only when confidence > 0.8 and keyword result was low-confidence
- `GROQ_API_KEY` placeholder in `.env.example`
- `groq>=0.28.0` added to `requirements.txt` and `pyproject.toml`

### Changed

- `osint_build_orgchart.py` `build_hierarchical_data()` now accepts `use_ai` parameter
- `osint_scrape_profiles.py` `deep_dive()` now accepts `use_ai` parameter for per-profile AI classification
- `README.md` -- added "AI Enhancement (Optional)" section, updated features list, project structure, and configuration table
- `docs/USAGE.md` -- added AI Enhancement section with usage examples
- `docs/ARCHITECTURE.md` -- added AI enhancement to classification phase diagram and file structure

## [0.4.0] - 2026-02-14

Standalone org chart viewer, JSON-only pipeline output, and pre-upload audit fixes.

### Added

- `src/org_chart_viewer.html` -- standalone interactive viewer with D3.js collapsible tree and HTML/CSS matrix grid, loaded via client-side JSON upload (no pipeline HTML generation needed)
- `examples/demo_org_chart.json` -- generic demo dataset (44 people, 6 departments) with random avatars for testing and screenshots
- Dual-view toggle in viewer: Tree View (default) and Matrix View with view-specific controls
- Level-by-level expand/collapse in both tree and matrix views
- `assets/screenshots/Tree.png` and `assets/screenshots/Matrix.png` for README demo section
- `.gitignore` entries for `test_output/` and all `output/` subdirectories (scrape_data, batch_scrape, deep_dive)
- `load_dotenv()` call in `osint_pipeline.py` so `.env` credentials are loaded automatically

### Changed

- Pipeline (`osint_pipeline.py`) now produces **JSON only** -- HTML generation removed; users open the standalone viewer instead
- Profile image download integrated into pipeline: images saved locally via authenticated Selenium session to avoid CDN expiration
- `README.md` -- replaced broken `org_chart_screenshot.png` placeholder with actual Tree/Matrix screenshots; updated output description to JSON-only; added `org_chart_viewer.html` and `demo_org_chart.json` to project structure; replaced specific company examples with generic `acme-corp`
- `docs/USAGE.md` -- updated output table to JSON-only; added "Viewing Results" section documenting the standalone viewer
- `docs/ARCHITECTURE.md` -- updated Phase 4 visualization diagram to show JSON output and standalone viewer instead of vis-network HTML; updated file structure tree
- Replaced phantom `tests/test_e2e.py` reference in project structure trees with actual `tests/__init__.py`

### Removed

- `src/__pycache__/` -- build artifacts (6 .pyc files) that would have been committed to the repo

### Fixed

- `.gitignore` was missing `test_output/` (real LinkedIn scrape data) and standalone script output directories (now consolidated under `output/`)
- Documentation referenced `tests/test_e2e.py` which does not exist in the repo
- Multiple stale `vis.js` / `vis-network` references in README, USAGE.md, and ARCHITECTURE.md replaced with current D3.js viewer info

## [0.3.0] - 2026-02-14

Unified pipeline script and documentation updates.

### Added

- `src/osint_pipeline.py` -- single entry point that runs the full pipeline (login, scrape, classify, visualize) using one continuous browser session, solving LinkedIn's session-only cookie problem
- `--skip-scrape` / `-c` flags on the unified pipeline to re-run classification and visualization on an existing CSV without a browser
- Pipeline flags: `--max-pages`, `--max-profiles`, `--headless`, `-v`, `-o` (output directory)

### Changed

- `README.md` -- restructured Usage section: unified pipeline is now the recommended "Quick Start", individual scripts moved to an "Advanced: Individual Scripts" table
- `docs/USAGE.md` -- added full "Unified Pipeline" section at the top with examples, output table, and flags reference; added note about LinkedIn session-only cookies to Session Handling; individual script docs remain as "Advanced" reference
- `CHANGELOG.md` -- added v0.3.0 entry

## [0.2.0] - 2026-02-14

Repository hygiene, open-source scaffolding, README overhaul, and full
documentation audit against the codebase.

### Added

- `pyproject.toml` with PEP 621 packaging metadata and tool configuration (pytest, ruff, mypy)
- `Makefile` with `install`, `install-dev`, `lint`, `format`, `typecheck`, `test`, and `clean` targets
- `.editorconfig` for consistent indentation and encoding across editors
- `SECURITY.md` with vulnerability disclosure policy
- `CONTRIBUTING.md` with setup, workflow, and code style guidelines
- `CODE_OF_CONDUCT.md` (Contributor Covenant v2.1)
- `.github/workflows/ci.yml` -- GitHub Actions CI pipeline (lint + test across Python 3.10-3.13)
- `.github/ISSUE_TEMPLATE/bug_report.md` and `feature_request.md`
- `.github/PULL_REQUEST_TEMPLATE.md` with testing checklist
- `src/__init__.py` and `tests/__init__.py` to make both proper Python packages
- `assets/` directory with `.gitkeep` for logo and screenshot placeholders
- `.gitignore` entries for `.pytest_cache/`, `.mypy_cache/`, `.ruff_cache/`, `.coverage`, `htmlcov/`, `.tox/`

### Changed

- Rewrote `README.md` with professional open-source structure: centered logo placeholder, expanded description, prerequisites, installation, configuration (`.env.example` table), six usage sub-sections covering every script, updated project structure tree, documentation cross-reference table, contributing section, and license link
- Added demo/example output section with `assets/org_chart_screenshot.png` image placeholder
- `docs/USAGE.md` -- added missing CLI flags for all scripts; documented JSON input for batch scraper; corrected `osint_classify_rules.py` standalone description to note it runs a self-test; added `osint_scan.py` documentation; added default output directory info for each scraper; expanded session persistence to include Snap and Flatpak Firefox profile paths
- `docs/ARCHITECTURE.md` -- added `kill_stale_browsers()` and `setup_logging()` to the `osint_auth.py` function table and diagram; added `classification_rules.json` as a key architectural component with its own diagram node; added `osint_scan.py` to the classification phase with a new analysis tools sub-table; updated file structure tree
- `docs/REFERENCE.md` -- added note that classification rules are loaded from `src/classification_rules.json` at runtime
- `docs/OSINT_METHODOLOGY.md` -- replaced conversational ending with a neutral reference to `osint_discover.py` and its `--cities-file` and `--list-industries` flags

### Removed

- `src/__pycache__/` and `tests/__pycache__/` -- build artifacts (10 .pyc files, ~260 KB)
- `test_output/` -- sensitive scraped data (~1.7 MB of real employee names, org charts, and profile deep dives from prior test runs)
- `output/.gitkeep` -- dead file; the `output/` gitignore rule blocked it from ever being tracked

### Fixed

- `docs/REFERENCE.md` -- "Legal / Compliance" corrected to "Legal & Compliance" and "Military / Defense" corrected to "Military/Defense" to match actual division names in `classification_rules.json`

## [0.1.0] - 2026-02-14

Initial release of the LinkedIn OSINT Toolkit.

### Added

- LinkedIn login and session management with OTP support (`osint_auth.py`)
- OSINT company discovery by region with industry classification (`osint_discover.py`)
- Single-company employee scraper with resilient selectors (`osint_scrape_company.py`)
- Batch company scraper with session checks every 5 companies (`osint_scrape_batch.py`)
- Profile deep-dive extraction for about, experience, education, and skills (`osint_scrape_profiles.py`)
- Data-driven role classifier with hierarchy (12 levels) and division (18 categories) detection (`osint_classify_rules.py`)
- Classification rules JSON learned from ~30K real profiles across 48 companies (`classification_rules.json`)
- Org chart data builder from scraped CSV with profile image merging (`osint_build_orgchart.py`)
- Interactive org chart generator with search, filter, and export (`osint_generate_html.py`)
- Classification statistics analyzer for JSON data files (`osint_stats.py`)
- Classification scanner with override suggestions (`osint_scan.py`)
- Documentation: Usage Guide, Architecture with mermaid diagrams, Reference Tables, OSINT Methodology
- Example batch input file (`examples/companies_list.txt.example`)
- Environment variable template (`.env.example`)
- MIT License
