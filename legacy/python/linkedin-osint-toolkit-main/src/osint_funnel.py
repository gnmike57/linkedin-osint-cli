#!/usr/bin/env python3
"""
LinkedIn OSINT Funnel - Macro to Micro
========================================

Single entry point that runs the full intelligence funnel with ONE browser
session, chaining each phase's output into the next:

  Phase 1  DISCOVER   - Find companies by region / keyword / industry
  Phase 2  SCRAPE     - Batch scrape people from every discovered company
  Phase 3  CLASSIFY   - Classify titles + build org chart JSON
  Phase 4  DEEP DIVE  - Visit individual profiles for full intel (optional)

Open the result in the interactive viewer:  firefox src/org_chart_viewer.html

All output goes to a single flat directory (default: output/).

Usage:
    # Full funnel: discover -> scrape -> classify
    python src/osint_funnel.py --geo-code 103644278 --keyword "cybersecurity" --limit 5

    # Full funnel with deep dive on top 20 profiles
    python src/osint_funnel.py --geo-code 103644278 --keyword "fintech" --limit 3 --deep-dive --deep-dive-limit 20

    # Start from an existing discovered-companies JSON (skip phase 1)
    python src/osint_funnel.py --input output/discovered_companies_usa_20260215_120000.json

    # Start from an existing batch-scrape JSON (skip phases 1-2)
    python src/osint_funnel.py --input output/all_companies_people_20260215_120000.json --start-phase 3

    # Credentials from .env or CLI flags
    python src/osint_funnel.py --geo-code 103644278 -e user@mail.com -p pass123 --limit 5
"""

import os
import sys
import json
import argparse
from datetime import datetime

from dotenv import load_dotenv

# Ensure src/ is on the path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from osint_auth import (
    create_browser,
    login_to_linkedin,
    setup_logging,
    logger,
)

OUTPUT_DIR = "output"

PHASE_NAMES = {
    1: "DISCOVER",
    2: "SCRAPE",
    3: "CLASSIFY",
    4: "DEEP DIVE",
}


# ============================================================================
# PHASE 1: Discover companies
# ============================================================================

def phase_discover(driver, args, output_dir):
    """Discover companies on LinkedIn by region/keyword/industry."""
    from osint_discover import OSINTCompanyDiscovery, classify_industry

    print("\n" + "=" * 70)
    print("PHASE 1 / 4 — DISCOVER COMPANIES")
    print("=" * 70)
    print(f"  Geo code:  {args.geo_code}")
    print(f"  Keyword:   {args.keyword or '(none)'}")
    print(f"  Industry:  {args.industry or '(none)'}")
    print(f"  Limit:     {args.limit}")
    print("=" * 70)

    discovery = OSINTCompanyDiscovery(driver=driver)
    companies = discovery.search_companies_linkedin(
        keyword=args.keyword or "",
        geo_code=args.geo_code,
        limit=args.limit,
        industry_filter=args.industry,
    )

    if not companies:
        print("[!] No companies discovered.")
        return None

    # AI scoring (optional)
    if args.use_ai:
        objective = args.keyword or args.industry or ""
        if objective:
            try:
                from osint_classify_ai import score_companies
                companies = score_companies(companies, objective)
                discovery.discovered_companies = companies
            except Exception as e:
                print(f"[AI] Warning: scoring failed ({e}), continuing without it")

    # Save results
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    region = args.region_name or "region"
    output_path = os.path.join(output_dir, f"discovered_companies_{region}_{ts}.json")
    discovery.discovered_companies = companies
    discovery.save_results(output_path, format="json")

    print(f"\n[+] Phase 1 complete: {len(companies)} companies -> {output_path}")
    return output_path


# ============================================================================
# PHASE 2: Batch scrape people from companies
# ============================================================================

def phase_scrape(driver, args, output_dir, discover_file):
    """Batch scrape people from all discovered companies."""
    from osint_scrape_batch import load_companies, scrape_all_companies

    print("\n" + "=" * 70)
    print("PHASE 2 / 4 — BATCH SCRAPE PEOPLE")
    print("=" * 70)
    print(f"  Input: {discover_file}")
    print("=" * 70)

    companies = load_companies(discover_file)
    if not companies:
        print("[!] No companies found in input file.")
        return None

    print(f"[+] Loaded {len(companies)} companies to scrape")

    results = scrape_all_companies(
        companies,
        output_dir,
        email=args.email,
        password=args.password,
        driver=driver,
    )

    # Find the master file that was saved (most recent all_companies_people_*.json)
    master_files = sorted(
        [f for f in os.listdir(output_dir) if f.startswith("all_companies_people_") and f.endswith(".json")],
        reverse=True,
    )
    if master_files:
        output_path = os.path.join(output_dir, master_files[0])
    else:
        # Shouldn't happen, but fallback
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        output_path = os.path.join(output_dir, f"all_companies_people_{ts}.json")
        with open(output_path, "w", encoding="utf-8") as f:
            json.dump(results, f, indent=2, ensure_ascii=False)

    total_people = results.get("total_people", 0)
    print(f"\n[+] Phase 2 complete: {total_people} people -> {output_path}")
    return output_path


# ============================================================================
# PHASE 3: Classify titles + build org chart JSON
# ============================================================================

def phase_classify(args, output_dir, scrape_file):
    """Classify scraped people and build hierarchical org chart data."""
    from osint_build_orgchart import build_hierarchical_data, get_division_color

    print("\n" + "=" * 70)
    print("PHASE 3 / 4 — CLASSIFY + ORG CHART")
    print("=" * 70)
    print(f"  Input: {scrape_file}")
    print("=" * 70)

    with open(scrape_file, "r", encoding="utf-8") as f:
        data = json.load(f)

    # Extract all people from the batch-scrape format
    all_people = []
    company_names = set()
    if "companies" in data:
        for company in data["companies"]:
            cname = company.get("company", "Unknown")
            company_names.add(cname)
            for person in company.get("people", []):
                all_people.append({
                    "name": person.get("name", "Unknown"),
                    "title": person.get("title", ""),
                    "profile_url": person.get("profileUrl", ""),
                    "profile_image_url": person.get("profileImageUrl", ""),
                    "connection_degree": person.get("connectionDegree", ""),
                    "company": cname,
                })
    elif "people" in data:
        for person in data["people"]:
            all_people.append({
                "name": person.get("name", "Unknown"),
                "title": person.get("title", ""),
                "profile_url": person.get("profileUrl", person.get("profile_url", "")),
                "profile_image_url": person.get("profileImageUrl", person.get("profile_image_url", "")),
            })

    if not all_people:
        print("[!] No people found in input file.")
        return None

    print(f"[+] Loaded {len(all_people)} people from {len(company_names) or 1} companies")

    use_ai = getattr(args, "use_ai", False)
    divisions = build_hierarchical_data(all_people, use_ai=use_ai)

    display_name = ", ".join(sorted(company_names)) if company_names else "Organization"
    if len(display_name) > 80:
        display_name = f"{len(company_names)} Companies"

    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    output_path = os.path.join(output_dir, f"org_chart_{ts}.json")

    profiles_with_images = sum(1 for p in all_people if p.get("profile_image_url"))

    org_data = {
        "generated_at": datetime.now().isoformat(),
        "company_name": display_name,
        "total_people": len(all_people),
        "total_with_images": profiles_with_images,
        "total_divisions": len(divisions),
        "divisions": divisions,
    }

    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(org_data, f, indent=2, ensure_ascii=False)

    print(f"[+] {len(divisions)} divisions:")
    for div in divisions:
        print(f"      - {div['name']}: {div['total_people']} people")

    print(f"\n[+] Phase 3 complete: {len(all_people)} people classified -> {output_path}")
    return output_path


# ============================================================================
# PHASE 4: Deep dive individual profiles (optional)
# ============================================================================

def phase_deep_dive(driver, args, output_dir, scrape_file):
    """Deep-dive analysis on individual LinkedIn profiles."""
    from osint_scrape_profiles import load_profiles, deep_dive

    print("\n" + "=" * 70)
    print("PHASE 4 / 4 — DEEP DIVE PROFILES")
    print("=" * 70)
    print(f"  Input: {scrape_file}")
    print(f"  Limit: {args.deep_dive_limit or 'all'}")
    print("=" * 70)

    profiles = load_profiles(scrape_file)
    if not profiles:
        print("[!] No valid profiles found in input file.")
        return None

    print(f"[+] Loaded {len(profiles)} profiles for deep dive")

    results = deep_dive(
        profiles,
        output_dir,
        limit=args.deep_dive_limit,
        email=args.email,
        password=args.password,
        driver=driver,
        use_ai=getattr(args, "use_ai", False),
    )

    # Find the results file (most recent deep_dive_results_*.json)
    dd_files = sorted(
        [f for f in os.listdir(output_dir) if f.startswith("deep_dive_results_") and f.endswith(".json")],
        reverse=True,
    )
    output_path = os.path.join(output_dir, dd_files[0]) if dd_files else None

    analyzed = results.get("analyzed", 0)
    print(f"\n[+] Phase 4 complete: {analyzed} profiles analyzed -> {output_path}")
    return output_path


# ============================================================================
# FUNNEL ORCHESTRATOR
# ============================================================================

def detect_input_phase(filepath):
    """Detect which phase produced a given file so we know where to resume.

    Returns the phase number that should consume this file as input:
      - discovered_companies -> phase 2 (scrape)
      - all_companies_people / single company -> phase 3 (classify)
      - org_chart JSON (with divisions) -> already complete (no further phases)
      - deep_dive_results -> already complete (no further phases)
    """
    if not filepath or not os.path.exists(filepath):
        return None

    try:
        with open(filepath, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (json.JSONDecodeError, OSError):
        return None

    # discovered_companies format -> feed into phase 2
    if "companies" in data and "count" in data and "discovered_at" in data:
        return 2

    # batch scrape format (companies with people arrays) -> feed into phase 3
    if "companies" in data and "total_people" in data:
        return 3

    # single company with people -> feed into phase 3
    if "people" in data and isinstance(data["people"], list):
        return 3

    # org chart format -> already at the end of the funnel
    if "divisions" in data:
        return None

    # deep dive results -> already at the end of the funnel
    if "profiles" in data:
        return None

    return None


def run_funnel(args):
    """Run the full OSINT funnel."""

    output_dir = args.output_dir
    os.makedirs(output_dir, exist_ok=True)

    start_phase = args.start_phase
    end_phase = min(args.end_phase, 4)
    do_deep_dive = args.deep_dive

    # If --input is provided, detect what phase it belongs to
    input_file = args.input
    if input_file:
        if not os.path.exists(input_file):
            print(f"[-] Input file not found: {input_file}")
            return 1
        detected = detect_input_phase(input_file)
        if detected is None:
            print(f"[-] Cannot detect format of input file: {input_file}")
            return 1
        if start_phase < detected:
            start_phase = detected
            print(f"[*] Detected input format -> starting from phase {start_phase} ({PHASE_NAMES[start_phase]})")

    # Validate phase 1 requirements
    if start_phase <= 1 and not input_file:
        if not args.geo_code:
            print("[-] Phase 1 (Discover) requires --geo-code")
            print("    Example: --geo-code 103644278 (USA)")
            return 1

    print("=" * 70)
    print("LINKEDIN OSINT FUNNEL — MACRO TO MICRO")
    print("=" * 70)
    phases_str = " -> ".join(
        f"{PHASE_NAMES[p]}" + (" *" if p == 4 and not do_deep_dive else "")
        for p in range(start_phase, end_phase + 1)
    )
    print(f"  Phases:   {phases_str}")
    if not do_deep_dive and start_phase <= 4 <= end_phase:
        print(f"            (* Phase 4 skipped; enable with --deep-dive)")
    print(f"  Output:   {output_dir}/")
    print("=" * 70)

    # -------------------------------------------------------------------
    # Create shared browser session (only if scraping phases are needed)
    # -------------------------------------------------------------------
    needs_browser = (start_phase <= 2 and end_phase >= 1) or (do_deep_dive and start_phase <= 4 <= end_phase)
    driver = None

    if needs_browser:
        print("\n[*] Starting browser...")
        driver = create_browser(headless=args.headless, proxy_url=args.proxy)

        if args.email and args.password:
            print("[*] Logging in to LinkedIn...")
            if not login_to_linkedin(driver, args.email, args.password):
                print("[-] Login failed. Exiting.")
                driver.quit()
                return 1
            print("[+] Login successful!")

    try:
        # Track files as they flow through the pipeline
        discover_file = input_file if (input_file and start_phase <= 2) else None
        scrape_file = input_file if (input_file and start_phase <= 3) else None
        org_chart_file = None

        # ==============================================================
        # PHASE 1: Discover
        # ==============================================================
        if start_phase <= 1 <= end_phase:
            discover_file = phase_discover(driver, args, output_dir)
            if not discover_file:
                print("[-] Phase 1 failed. Stopping.")
                return 1
            scrape_file = None  # must be produced by phase 2

        # ==============================================================
        # PHASE 2: Batch Scrape
        # ==============================================================
        if start_phase <= 2 <= end_phase and discover_file:
            scrape_file = phase_scrape(driver, args, output_dir, discover_file)
            if not scrape_file:
                print("[-] Phase 2 failed. Stopping.")
                return 1
            org_chart_file = None  # must be produced by phase 3

        # ==============================================================
        # PHASE 3: Classify + Org Chart
        # ==============================================================
        if start_phase <= 3 <= end_phase and scrape_file:
            org_chart_file = phase_classify(args, output_dir, scrape_file)
            if not org_chart_file:
                print("[-] Phase 3 failed. Stopping.")
                return 1

        # ==============================================================
        # PHASE 4: Deep Dive (optional)
        # ==============================================================
        if do_deep_dive and start_phase <= 4 <= end_phase and scrape_file:
            phase_deep_dive(driver, args, output_dir, scrape_file)

    except KeyboardInterrupt:
        print("\n\n" + "=" * 70)
        print("[!] INTERRUPTED BY USER — SAVING PARTIAL RESULTS")
        print("=" * 70)
        # Summarize what we have so far
        partial_files = []
        if discover_file and os.path.exists(discover_file):
            partial_files.append(("Discovered companies", discover_file))
        if scrape_file and os.path.exists(scrape_file):
            partial_files.append(("Scraped people", scrape_file))
        if org_chart_file and os.path.exists(org_chart_file):
            partial_files.append(("Org chart JSON", org_chart_file))

        if partial_files:
            print("\n  Partial results saved:")
            for label, path in partial_files:
                print(f"    {label}: {path}")
        else:
            print("\n  No output files were completed before interruption.")
        print("\n  You can resume from the last saved file using --input")
        print("=" * 70)

    except Exception as e:
        print(f"\n\n[!] Unexpected error: {e}")
        import traceback
        traceback.print_exc()
        # Still show partial results
        if discover_file and os.path.exists(discover_file):
            print(f"  Partial: {discover_file}")
        if scrape_file and os.path.exists(scrape_file):
            print(f"  Partial: {scrape_file}")

    finally:
        if driver:
            print("\n[*] Closing browser...")
            driver.quit()
            print("[+] Browser closed")

    # ==================================================================
    # FINAL SUMMARY
    # ==================================================================
    viewer_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "org_chart_viewer.html")

    print("\n" + "=" * 70)
    print("FUNNEL COMPLETE")
    print("=" * 70)
    if discover_file:
        print(f"  Discovered companies: {discover_file}")
    if scrape_file:
        print(f"  Scraped people:       {scrape_file}")
    if org_chart_file:
        print(f"  Org chart JSON:       {org_chart_file}")
    print("=" * 70)
    print(f"\n  To explore the org chart interactively:")
    print(f"    firefox {viewer_path}")
    if org_chart_file:
        print(f"    Then load: {org_chart_file}")

    return 0


# ============================================================================
# CLI
# ============================================================================

def main():
    load_dotenv()

    parser = argparse.ArgumentParser(
        description="LinkedIn OSINT Funnel — full macro-to-micro pipeline",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Full funnel: discover cybersecurity companies in USA, scrape, classify
  python src/osint_funnel.py --geo-code 103644278 --keyword "cybersecurity" --limit 5

  # With deep dive on top 20 profiles
  python src/osint_funnel.py --geo-code 103644278 --keyword "fintech" --limit 3 --deep-dive --deep-dive-limit 20

  # Resume from an existing file (auto-detects format and starting phase)
  python src/osint_funnel.py --input output/discovered_companies_usa_20260215_120000.json
  python src/osint_funnel.py --input output/all_companies_people_20260215_120000.json

  # Only run discovery (phase 1)
  python src/osint_funnel.py --geo-code 103644278 --keyword "defense" --limit 10 --end-phase 1

  # Credentials via .env or CLI
  python src/osint_funnel.py --geo-code 103644278 -e user@mail.com -p pass123 --limit 5

Phases:
  1  DISCOVER    Find companies by region/keyword/industry
  2  SCRAPE      Batch scrape people from discovered companies
  3  CLASSIFY    Classify titles + build org chart JSON
  4  DEEP DIVE   Visit individual profiles (optional, --deep-dive)

Visualization:
  Open the result JSON in the interactive viewer:  firefox src/org_chart_viewer.html
        """,
    )

    # --- Phase control ---
    parser.add_argument("--input", "-i", default=None,
                        help="Resume from an existing output file (auto-detects format)")
    parser.add_argument("--start-phase", type=int, default=1, choices=[1, 2, 3, 4],
                        help="Start from this phase (default: 1)")
    parser.add_argument("--end-phase", type=int, default=4, choices=[1, 2, 3, 4],
                        help="Stop after this phase (default: 4)")

    # --- Phase 1: Discovery ---
    parser.add_argument("--geo-code", "-g", default=None,
                        help="LinkedIn geo code for company search (e.g., 103644278 for USA)")
    parser.add_argument("--keyword", "-k", default=None,
                        help="Search keyword (e.g., 'cybersecurity', 'fintech')")
    parser.add_argument("--industry", default=None,
                        help="Filter by industry category (e.g., 'Cybersecurity')")
    parser.add_argument("--region-name", "-r", default="region",
                        help="Region label for output filenames (default: 'region')")
    parser.add_argument("--limit", "-l", type=int, default=10,
                        help="Max companies to discover (default: 10)")

    # --- Phase 4: Deep dive ---
    parser.add_argument("--deep-dive", action="store_true",
                        help="Enable phase 4: visit individual profiles for full intel")
    parser.add_argument("--deep-dive-limit", type=int, default=None,
                        help="Max profiles to deep-dive (default: all)")

    # --- Credentials ---
    parser.add_argument("-e", "--email", default=None, help="LinkedIn email")
    parser.add_argument("-p", "--password", default=None, help="LinkedIn password")

    # --- General ---
    parser.add_argument("-o", "--output-dir", default=OUTPUT_DIR,
                        help="Output directory (default: output/)")
    parser.add_argument("--proxy", default=None,
                        help="Proxy URL for browser (e.g., socks5://host:port, http://host:port)")
    parser.add_argument("--headless", action="store_true",
                        help="Run browser in headless mode")
    parser.add_argument("--use-ai", action="store_true",
                        help="Use Groq AI for enhanced scoring/classification (requires GROQ_API_KEY)")
    parser.add_argument("-v", "--verbose", action="store_true",
                        help="Enable verbose/debug logging")

    args = parser.parse_args()
    setup_logging(verbose=args.verbose)

    # Resolve credentials: CLI > .env
    if not args.email:
        args.email = os.environ.get("LINKEDIN_EMAIL")
    if not args.password:
        args.password = os.environ.get("LINKEDIN_PASSWORD")

    # Validate
    if args.start_phase > args.end_phase:
        parser.error("--start-phase cannot be greater than --end-phase")

    needs_browser = (args.start_phase <= 2 and args.end_phase >= 1) or \
                    (args.deep_dive and args.start_phase <= 4 <= args.end_phase)
    if needs_browser and not args.input:
        if not args.email or not args.password:
            parser.error("LinkedIn credentials required (use -e/-p or set LINKEDIN_EMAIL/LINKEDIN_PASSWORD in .env)")

    sys.exit(run_funnel(args))


if __name__ == "__main__":
    main()
