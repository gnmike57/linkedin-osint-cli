#!/usr/bin/env python3
"""
LinkedIn OSINT Toolkit - Unified Pipeline
==========================================

Single entry point that runs the full pipeline with ONE browser session:
  1. Login to LinkedIn (approve OTP once)
  2. Scrape target company employees
  3. Classify roles and build org chart JSON

Open the result in the standalone viewer:
    firefox src/org_chart_viewer.html   (then load the JSON)

Usage:
    python src/osint_pipeline.py <company> -e <email> -p <password>
    python src/osint_pipeline.py acme-corp -e user@mail.com -p pass123
    python src/osint_pipeline.py https://linkedin.com/company/acme-corp -e user@mail.com -p pass123
    python src/osint_pipeline.py --skip-scrape -c output/linkedin_company_acme_20260214.csv
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
    normalize_input,
    setup_logging,
    logger,
)
from osint_scrape_company import LinkedInCompanyPeopleScraper
from osint_build_orgchart import load_linkedin_csv, build_hierarchical_data


def run_pipeline(args):
    """Run the full OSINT pipeline."""

    output_dir = args.output_dir
    os.makedirs(output_dir, exist_ok=True)

    csv_path = None
    company_name = None
    display_name = None

    # ======================================================================
    # PHASE 1 & 2: Login + Scrape (browser required)
    # ======================================================================
    if not args.skip_scrape:
        company_url = normalize_input(args.company)
        # Extract company name from URL for file naming
        import re
        match = re.search(r'/company/([^/]+)', company_url)
        company_name = match.group(1) if match else 'unknown'

        print("=" * 70)
        print("LINKEDIN OSINT TOOLKIT - UNIFIED PIPELINE")
        print("=" * 70)
        print(f"Target:     {company_url}")
        print(f"Output dir: {output_dir}")
        if getattr(args, 'use_ai', False):
            print(f"AI:         Enabled (Groq)")
        print("=" * 70)

        # --- Create browser ---
        print("\n[1/3] Starting browser...")
        driver = create_browser(headless=args.headless, proxy_url=getattr(args, "proxy", None))

        try:
            # --- Login ---
            print("\n[2/3] Logging in to LinkedIn...")
            if not login_to_linkedin(driver, args.email, args.password):
                print("[-] Login failed. Exiting.")
                driver.quit()
                return 1

            print("[+] Login successful!")

            # --- Scrape ---
            print(f"\n[3/3] Scraping company: {company_name}")
            scraper = LinkedInCompanyPeopleScraper(
                company_url,
                output_dir,
                driver=driver,
                max_pages=args.max_pages,
                max_profiles=args.max_profiles,
            )

            if not scraper.navigate_to_company_people():
                print("[-] Failed to navigate to company page. Exiting.")
                driver.quit()
                return 1

            scraper.scrape_all_people()

            if not scraper.all_people:
                print("\n[-] No profiles scraped. Nothing to classify.")
                driver.quit()
                return 1

            # Capture the real company display name from the live page
            display_name = scraper.get_company_display_name()
            print(f"[*] Company display name: {display_name}")

            # Download profile images while browser is still authenticated
            print("\n[*] Downloading profile images...")
            scraper.download_profile_images(driver=driver)

            # Save CSV (with local image paths now)
            csv_path = scraper.save_to_csv()
            scraper.print_statistics()

        except KeyboardInterrupt:
            print("\n[!] Interrupted by user — saving partial results...")
            if hasattr(scraper, 'all_people') and scraper.all_people:
                csv_path = scraper.save_to_csv()
                print(f"[+] Saved {len(scraper.all_people)} partial profiles to {csv_path}")
                print("[*] Continuing to classification phase with partial data...")
            else:
                print("[*] No profiles scraped before interruption.")
        except Exception as e:
            print(f"\n[!] Error during scraping: {e}")
            if hasattr(scraper, 'all_people') and scraper.all_people:
                csv_path = scraper.save_to_csv()
                print(f"[+] Saved {len(scraper.all_people)} partial profiles to {csv_path}")
        finally:
            print("\n[*] Closing browser...")
            driver.quit()
            print("[+] Browser closed")

        if not csv_path:
            print("[-] No CSV produced. Cannot continue pipeline.")
            return 1

    else:
        # --- Skip scrape, use existing CSV ---
        csv_path = args.csv_file
        if not csv_path:
            print("[-] --skip-scrape requires --csv-file (-c) with path to an existing CSV")
            return 1
        if not os.path.exists(csv_path):
            print(f"[-] CSV file not found: {csv_path}")
            return 1

        import re
        match = re.search(r'linkedin_company_([^_]+)_', os.path.basename(csv_path))
        company_name = match.group(1) if match else 'unknown'

        print("=" * 70)
        print("LINKEDIN OSINT TOOLKIT - CLASSIFY + BUILD ORG CHART")
        print("=" * 70)
        print(f"Input CSV:  {csv_path}")
        print(f"Output dir: {output_dir}")
        print("=" * 70)

    # ======================================================================
    # PHASE: Classify and build org chart JSON (offline, no browser)
    # ======================================================================
    print(f"\n[*] Building org chart data...")

    profiles = load_linkedin_csv(csv_path)
    print(f"    Loaded {len(profiles)} profiles from CSV")

    if not profiles:
        print("[-] No profiles found in CSV.")
        return 1

    # Fix up image paths: CSV stores paths relative to its own dir (e.g. images/name.jpg).
    # The JSON lives in output_dir, so rewrite to be relative from there.
    csv_dir = os.path.dirname(os.path.abspath(csv_path))
    json_dir = os.path.abspath(output_dir)
    for profile in profiles:
        img = profile.get('profile_image_url', '')
        if img and not img.startswith('http') and not os.path.isabs(img):
            abs_img = os.path.join(csv_dir, img)
            if os.path.exists(abs_img):
                profile['profile_image_url'] = os.path.relpath(abs_img, json_dir)

    use_ai = getattr(args, 'use_ai', False)
    divisions = build_hierarchical_data(profiles, use_ai=use_ai)

    timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
    org_chart_json_path = os.path.join(output_dir, f"org_chart_{company_name}_{timestamp}.json")
    os.makedirs(os.path.dirname(org_chart_json_path) or ".", exist_ok=True)

    profiles_with_images = sum(1 for p in profiles if p.get('profile_image_url'))

    if not display_name:
        display_name = company_name.replace('-', ' ').title() if company_name else 'Organization'

    org_data = {
        'generated_at': datetime.now().isoformat(),
        'company_name': display_name,
        'total_people': len(profiles),
        'total_with_images': profiles_with_images,
        'total_divisions': len(divisions),
        'divisions': divisions,
    }

    with open(org_chart_json_path, 'w', encoding='utf-8') as f:
        json.dump(org_data, f, indent=2, ensure_ascii=False)

    print(f"    Org chart data: {org_chart_json_path}")
    print(f"    Divisions: {len(divisions)}")
    for div in divisions:
        print(f"      - {div['name']}: {div['total_people']} people")

    # ======================================================================
    # SUMMARY
    # ======================================================================
    viewer_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'org_chart_viewer.html')
    print("\n" + "=" * 70)
    print("PIPELINE COMPLETE")
    print("=" * 70)
    if csv_path:
        print(f"  Scraped CSV:      {csv_path}")
    print(f"  Org chart JSON:   {org_chart_json_path}")
    print(f"  Total people:     {len(profiles)}")
    print(f"  Divisions:        {len(divisions)}")
    if use_ai:
        ai_enhanced = sum(1 for p in profiles if p.get('ai_role_level') or p.get('ai_division'))
        ai_promoted = sum(1 for p in profiles if p.get('ai_promoted_level') or p.get('ai_promoted_division'))
        print(f"  AI enhanced:      {ai_enhanced}/{len(profiles)} classified")
        print(f"  AI promoted:      {ai_promoted} overrode keyword rules")
    print("=" * 70)
    print(f"\n  To view the org chart, open the viewer and load the JSON:")
    print(f"    firefox {viewer_path}")
    print(f"    Then click 'Load JSON' and select: {org_chart_json_path}")

    return 0


def main():
    # Load .env file so LINKEDIN_EMAIL / LINKEDIN_PASSWORD are available via os.environ
    load_dotenv()

    parser = argparse.ArgumentParser(
        description="LinkedIn OSINT Toolkit - Unified Pipeline",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Full pipeline: login + scrape + classify
  python src/osint_pipeline.py acme-corp -e your@email.com -p yourpassword

  # Full URL works too
  python src/osint_pipeline.py https://linkedin.com/company/acme-corp -e user@mail.com -p pass

  # Re-run classification on an existing CSV (no browser needed)
  python src/osint_pipeline.py --skip-scrape -c output/linkedin_company_acme_20260214.csv

  # Enable AI-enhanced classification (requires GROQ_API_KEY in .env)
  python src/osint_pipeline.py acme-corp -e your@email.com -p yourpassword --use-ai

  # Then open the viewer to explore the result
  firefox src/org_chart_viewer.html
        """,
    )

    parser.add_argument(
        "company", nargs="?", default=None,
        help="Company name or LinkedIn company URL (e.g., 'acme-corp' or full URL)",
    )
    parser.add_argument("-e", "--email", required=False, help="LinkedIn email")
    parser.add_argument("-p", "--password", required=False, help="LinkedIn password")
    parser.add_argument(
        "-o", "--output-dir", default="output",
        help="Base output directory (default: output/)",
    )
    parser.add_argument("--max-pages", type=int, default=None, help="Max 'Show more' pages to load")
    parser.add_argument("--max-profiles", type=int, default=None, help="Max profiles to collect")
    parser.add_argument("--proxy", default=None,
                        help="Proxy URL for browser (e.g., socks5://host:port)")
    parser.add_argument("--headless", action="store_true", help="Run browser in headless mode")
    parser.add_argument("-v", "--verbose", action="store_true", help="Enable verbose/debug logging")
    parser.add_argument(
        "--skip-scrape", action="store_true",
        help="Skip scraping, re-run classification on existing CSV",
    )
    parser.add_argument(
        "-c", "--csv-file", default=None,
        help="Path to existing CSV (used with --skip-scrape)",
    )
    parser.add_argument(
        "--use-ai", action="store_true",
        help="Use Groq AI to enhance classification (requires GROQ_API_KEY in .env)",
    )

    args = parser.parse_args()
    setup_logging(verbose=args.verbose)

    # Resolve credentials: CLI flags take priority, then .env
    if not args.email:
        args.email = os.environ.get("LINKEDIN_EMAIL")
    if not args.password:
        args.password = os.environ.get("LINKEDIN_PASSWORD")

    # Validate arguments
    if not args.skip_scrape:
        if not args.company:
            parser.error("company is required (unless using --skip-scrape)")
        if not args.email or not args.password:
            parser.error("-e/--email and -p/--password are required (set via flags or .env)")
    else:
        if not args.csv_file:
            parser.error("--csv-file (-c) is required when using --skip-scrape")

    sys.exit(run_pipeline(args))


if __name__ == "__main__":
    main()
