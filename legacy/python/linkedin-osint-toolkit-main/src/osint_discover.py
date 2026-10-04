#!/usr/bin/env python3
"""
OSINT Company Discovery Tool
Discovers companies from LinkedIn search for any region/country.
Use this as the first step to find target companies before scraping their employees.

Usage:
    python osint_discover.py --geo-code 103644278 --region-name usa --limit 10
    python osint_discover.py --keyword "cybersecurity" --geo-code 103644278
    python osint_discover.py --geo-code 103644278 --industry Cybersecurity --limit 20
    python osint_discover.py --list-industries
"""

import os
import sys
import json
import time
import random
import argparse
from datetime import datetime
from urllib.parse import quote_plus

# Shared login and utilities from osint_auth module
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from osint_auth import (
    login_to_linkedin,
    create_browser,
    check_session,
    ensure_logged_in,
    logger,
    setup_logging,
)
from osint_stealth import human_delay, random_scroll, apply_stealth_js


# Industry classification categories
# Maps standard categories to keywords found in LinkedIn industry strings
INDUSTRY_CATEGORIES = {
    # Technology
    'Technology': ['software', 'technology', 'tech', 'it services', 'computer', 'information technology'],
    'Cybersecurity': ['cyber', 'security', 'infosec', 'defense', 'defence'],
    'Telecommunications': ['telecom', 'isp', 'internet', 'mobile', 'wireless', 'communications'],
    'Cloud/SaaS': ['cloud', 'saas', 'platform', 'hosting'],

    # Finance
    'Banking': ['bank', 'banking', 'financial services'],
    'Insurance': ['insurance', 'insurtech'],
    'Fintech': ['fintech', 'payment', 'crypto', 'blockchain'],

    # Government & Defense
    'Government': ['government', 'public sector', 'ministry', 'municipal', 'federal', 'state'],
    'Defense': ['defense', 'defence', 'military', 'aerospace'],
    'Intelligence': ['intelligence', 'national security'],

    # Industry
    'Manufacturing': ['manufacturing', 'industrial', 'factory', 'production'],
    'Energy': ['energy', 'oil', 'gas', 'utilities', 'power', 'renewable'],
    'Transportation': ['transportation', 'logistics', 'shipping', 'freight', 'aviation'],

    # Services
    'Healthcare': ['health', 'medical', 'hospital', 'pharma', 'biotech', 'life sciences'],
    'Consulting': ['consulting', 'advisory', 'professional services', 'management consulting'],
    'Legal': ['legal', 'law firm', 'attorney', 'law practice'],
    'Education': ['education', 'university', 'school', 'training', 'e-learning'],
    'Retail': ['retail', 'e-commerce', 'consumer', 'wholesale'],
    'Media': ['media', 'entertainment', 'broadcast', 'publishing', 'news'],

    # Catch-all
    'Other': []
}

# ---------------------------------------------------------------------------
# LinkedIn Geo Codes (~50 countries/regions)
# Use with --geo-code <code> or --list-geo-codes to print this table.
# Find additional codes via LinkedIn's company search URL parameters:
#   companyHqGeo=%5B%22<CODE>%22%5D
# ---------------------------------------------------------------------------
GEO_CODES = {
    "Argentina": "100446943",
    "Australia": "101452733",
    "Austria": "103883259",
    "Belgium": "100565514",
    "Brazil": "106057199",
    "Canada": "101174742",
    "Chile": "104621616",
    "China": "102890883",
    "Colombia": "100876405",
    "Czech Republic": "104508036",
    "Denmark": "104514075",
    "Egypt": "106155005",
    "Finland": "100456013",
    "France": "105015875",
    "Germany": "101282230",
    "Greece": "104677530",
    "Hong Kong": "103291313",
    "India": "102713980",
    "Indonesia": "102478259",
    "Ireland": "104738515",
    "Israel": "101620260",
    "Italy": "103350119",
    "Japan": "101355337",
    "Kenya": "100660959",
    "Malaysia": "106808692",
    "Mexico": "103323778",
    "Netherlands": "102890719",
    "New Zealand": "105490917",
    "Nigeria": "105365761",
    "Norway": "103819153",
    "Pakistan": "101022442",
    "Peru": "102927786",
    "Philippines": "103121230",
    "Poland": "105072130",
    "Portugal": "100364837",
    "Romania": "106670623",
    "Saudi Arabia": "100459316",
    "Singapore": "102454443",
    "South Africa": "104035573",
    "South Korea": "105149562",
    "Spain": "105646813",
    "Sweden": "105117694",
    "Switzerland": "106693272",
    "Taiwan": "104187078",
    "Thailand": "105146118",
    "Turkey": "102105699",
    "UAE": "104305776",
    "UK": "101165590",
    "Ukraine": "102264497",
    "USA": "103644278",
    "Vietnam": "104195383",
}


def classify_industry(raw_industry: str) -> str:
    """
    Normalize LinkedIn industry string to standard category.

    Args:
        raw_industry: Raw industry string from LinkedIn

    Returns:
        Standard industry category name
    """
    if not raw_industry or raw_industry == 'Unknown':
        return 'Unknown'

    raw_lower = raw_industry.lower()
    for category, keywords in INDUSTRY_CATEGORIES.items():
        for keyword in keywords:
            if keyword in raw_lower:
                return category
    return 'Other'


def load_target_cities(cities_file: str = None) -> list:
    """
    Load target cities for location validation from config file.

    Args:
        cities_file: Path to file with city names (one per line)

    Returns:
        List of city names (lowercase) for validation
    """
    if cities_file and os.path.exists(cities_file):
        with open(cities_file, 'r', encoding='utf-8') as f:
            return [line.strip().lower() for line in f if line.strip() and not line.startswith('#')]
    return []  # No validation if no cities configured


def list_industries():
    """Print available industry categories."""
    print("\nAvailable Industry Categories:")
    print("=" * 40)
    for category, keywords in INDUSTRY_CATEGORIES.items():
        if keywords:
            print(f"  {category}")
            print(f"    Keywords: {', '.join(keywords[:5])}{'...' if len(keywords) > 5 else ''}")
    print()


def list_geo_codes():
    """Print available LinkedIn geo codes for company search."""
    print("\nLinkedIn Geo Codes:")
    print("=" * 45)
    for region, code in sorted(GEO_CODES.items()):
        print(f"  {region:<25} {code}")
    print(f"\nTotal: {len(GEO_CODES)} regions")
    print("Tip: Find more codes via LinkedIn search URL parameters.\n")


class OSINTCompanyDiscovery:
    def __init__(self, headless=False, target_cities=None, debug_selectors=False, driver=None, proxy_url=None):
        self.driver = driver
        self.shared_driver = driver is not None
        self.headless = headless
        self.proxy_url = proxy_url
        self.discovered_companies = []
        self.target_cities = target_cities or []
        self.debug_selectors = debug_selectors

    def setup_browser(self):
        """Initialize Firefox with existing profile for LinkedIn session."""
        if self.driver:
            # Already have a shared driver from the test runner
            print("[+] Browser initialized (shared)")
            return
        self.driver = create_browser(headless=self.headless, proxy_url=self.proxy_url)
        self.driver.implicitly_wait(10)
        print("[+] Browser initialized")

    def login(self, email, password):
        """Login to LinkedIn using the shared login module."""
        return login_to_linkedin(self.driver, email, password)

    def search_companies_linkedin(self, keyword="", geo_code=None, limit=10, industry_filter=None):
        """
        Search for companies on LinkedIn using their company search.

        Args:
            keyword: Search keyword (e.g., "cybersecurity", "fintech")
            geo_code: LinkedIn geo code for region (required)
            limit: Maximum number of companies to discover
            industry_filter: Optional industry category to filter results
        """
        if not geo_code:
            print("[-] Error: geo_code is required")
            return []

        companies = []
        page = 1

        try:
          while len(companies) < limit:
            # Build search URL
            if keyword:
                url = f"https://www.linkedin.com/search/results/companies/?companyHqGeo=%5B%22{geo_code}%22%5D&keywords={quote_plus(keyword)}&origin=FACETED_SEARCH&page={page}"
            else:
                url = f"https://www.linkedin.com/search/results/companies/?companyHqGeo=%5B%22{geo_code}%22%5D&origin=FACETED_SEARCH&page={page}"

            print(f"[*] Fetching page {page}: {url}")
            self.driver.get(url)
            apply_stealth_js(self.driver)
            human_delay(4.0, 7.0)

            # Scroll to load all results
            self._scroll_page(scrolls=5)
            human_delay(1.5, 3.0)

            # Extract companies using JavaScript
            try:
                new_companies = self.driver.execute_script("""
                    const results = [];
                    const seenSlugs = new Set();

                    // Find all company links
                    const companyLinks = document.querySelectorAll('a[href*="/company/"]');

                    for (const link of companyLinks) {
                        try {
                            const href = link.href || '';
                            if (!href.includes('linkedin.com/company/')) continue;

                            // Extract slug
                            const match = href.match(/\\/company\\/([^/?]+)/);
                            if (!match) continue;
                            const slug = match[1];

                            // Skip duplicates and special pages
                            if (seenSlugs.has(slug)) continue;
                            if (slug === 'company' || slug.length < 2) continue;

                            // Find the container card
                            let container = link;
                            for (let i = 0; i < 10 && container; i++) {
                                if (container.tagName === 'LI' ||
                                    container.classList.contains('entity-result') ||
                                    container.classList.contains('reusable-search__result-container')) {
                                    break;
                                }
                                container = container.parentElement;
                            }

                            // Get company name
                            let name = '';
                            const titleEl = container ? container.querySelector('.entity-result__title-text span[aria-hidden="true"]') : null;
                            if (titleEl) {
                                name = titleEl.textContent.trim();
                            } else {
                                // Fallback: use link text
                                const linkText = link.textContent.trim();
                                if (linkText && linkText.length > 1 && linkText.length < 100) {
                                    name = linkText.split('\\n')[0].trim();
                                }
                            }
                            if (!name || name.length < 2) name = slug;

                            // Extract industry, location, summary using TEXT-BASED approach.
                            // LinkedIn's CSS classes change frequently, so we extract all
                            // distinct text lines from the card and assign them by position:
                            //   line 0 = company name (already extracted above)
                            //   line 1 = industry / company type
                            //   line 2 = location / employee count
                            //   line 3+ = summary / description
                            let industry = 'Unknown';
                            let location = '';
                            let summary = '';

                            if (container) {
                                // Strategy A: Try known CSS selectors first
                                const selectorMap = {
                                    industry: [
                                        '.entity-result__primary-subtitle',
                                        '.artdeco-entity-lockup__subtitle',
                                        '[class*="primary-subtitle"]',
                                        '[class*="entity-lockup__subtitle"]',
                                    ],
                                    location: [
                                        '.entity-result__secondary-subtitle',
                                        '.artdeco-entity-lockup__caption',
                                        '[class*="secondary-subtitle"]',
                                        '[class*="entity-lockup__caption"]',
                                    ],
                                    summary: [
                                        '.entity-result__summary',
                                        '.artdeco-entity-lockup__metadata',
                                        '[class*="entity-result__summary"]',
                                    ],
                                };

                                for (const sel of selectorMap.industry) {
                                    const el = container.querySelector(sel);
                                    if (el) {
                                        const t = el.textContent.trim();
                                        if (t && t.length > 1 && t.length < 200) { industry = t; break; }
                                    }
                                }
                                for (const sel of selectorMap.location) {
                                    const el = container.querySelector(sel);
                                    if (el) {
                                        const t = el.textContent.trim();
                                        if (t && t.length > 1 && t.length < 200) { location = t; break; }
                                    }
                                }
                                for (const sel of selectorMap.summary) {
                                    const el = container.querySelector(sel);
                                    if (el) {
                                        const t = el.textContent.trim();
                                        if (t && t.length > 1) { summary = t; break; }
                                    }
                                }

                                // Strategy B: Full text extraction fallback
                                // If selectors failed, extract all visible text lines from the card
                                if (industry === 'Unknown' || !location) {
                                    const rawText = container.innerText || container.textContent || '';
                                    const lines = rawText.split('\\n')
                                        .map(l => l.trim())
                                        .filter(l => l.length > 1 && l.length < 200);

                                    // Remove the company name line (already have it)
                                    const nameNorm = name.toLowerCase().trim();
                                    const textLines = lines.filter(l =>
                                        l.toLowerCase().trim() !== nameNorm &&
                                        !l.toLowerCase().includes('connect') &&
                                        !l.toLowerCase().includes('follow') &&
                                        !l.toLowerCase().includes('view') &&
                                        l !== '...' && l !== 'more'
                                    );

                                    // Heuristic: line with "employees" or location patterns
                                    const locPattern = /\\b(employees|employee|members?|people|followers?)\\b/i;
                                    const cityPattern = /\\b(city|area|region|district|state|county|country|israel|usa|uk|germany|france|india|canada|london|new york|tel aviv|jerusalem|haifa)\\b/i;

                                    if (textLines.length >= 1 && industry === 'Unknown') {
                                        industry = textLines[0];
                                    }
                                    if (textLines.length >= 2 && !location) {
                                        // Second line is often location/size
                                        location = textLines[1];
                                    }

                                    // If we found more lines, try to improve assignment
                                    for (let li = 0; li < textLines.length; li++) {
                                        const line = textLines[li];
                                        if ((locPattern.test(line) || cityPattern.test(line)) && !location) {
                                            location = line;
                                            // If this was misassigned as industry, swap
                                            if (industry === line && li > 0) {
                                                industry = textLines[0];
                                            }
                                        }
                                    }

                                    if (textLines.length >= 3 && !summary) {
                                        summary = textLines.slice(2).join(' ').substring(0, 300);
                                    }
                                }
                            }

                            seenSlugs.add(slug);
                            results.push({
                                url: 'https://www.linkedin.com/company/' + slug + '/',
                                slug: slug,
                                name: name,
                                industry: industry,
                                location: location,
                                summary: summary
                            });

                        } catch (e) {}
                    }

                    return results;
                """)

                # Save debug HTML when --debug-selectors is active
                if self.debug_selectors and new_companies:
                    all_unknown = all(c.get('industry', 'Unknown') == 'Unknown' for c in new_companies)
                    if all_unknown:
                        os.makedirs('output', exist_ok=True)
                        debug_path = f"output/debug_selectors_page_{page}.html"
                        with open(debug_path, "w", encoding='utf-8') as f:
                            f.write(self.driver.page_source)
                        print(f"    [debug] All results returned Unknown -- saved HTML to {debug_path}")

                if new_companies:
                    for company in new_companies:
                        if len(companies) >= limit:
                            break
                        if company['url'] not in [c['url'] for c in companies]:
                            # Add industry classification
                            company['industry_raw'] = company['industry']
                            company['industry'] = classify_industry(company['industry_raw'])

                            # Apply industry filter if specified
                            if industry_filter and company['industry'] != industry_filter:
                                continue

                            company['discovered_at'] = datetime.now().isoformat()
                            companies.append(company)
                            print(f"  [+] Found: {company['name']} ({company['industry']})")

                    print(f"[*] Page {page}: Found {len(new_companies)} companies (total: {len(companies)})")
                else:
                    print(f"[*] No companies found on page {page}")
                    # Save debug info
                    os.makedirs('output', exist_ok=True)
                    with open(f"output/debug_page_{page}.html", "w", encoding='utf-8') as f:
                        f.write(self.driver.page_source)
                    print(f"[*] Saved debug HTML to output/debug_page_{page}.html")
                    break

                if len(companies) >= limit:
                    break

                page += 1
                human_delay(3.0, 6.0)

                # Safety limit
                if page > 10:
                    print("[*] Reached page limit")
                    break

            except Exception as e:
                print(f"[-] Error on page {page}: {e}")
                import traceback
                traceback.print_exc()
                break

        except KeyboardInterrupt:
            print(f"\n[!] Discovery interrupted — collected {len(companies)} companies so far")

        self.discovered_companies = companies
        return companies

    def _scroll_page(self, scrolls=3):
        """Scroll the page to load lazy content."""
        for i in range(scrolls):
            self.driver.execute_script("window.scrollTo(0, document.body.scrollHeight);")
            human_delay(0.8, 1.5)
        self.driver.execute_script("window.scrollTo(0, 0);")
        human_delay(0.8, 1.5)

    def validate_target_location(self, company):
        """Check if company location matches target cities (if configured)."""
        if not self.target_cities:
            return True  # No validation if no cities configured

        location = company.get('location', '').lower()

        for city in self.target_cities:
            if city in location:
                return True

        return False

    def save_results(self, output_path, format='json'):
        """Save discovered companies to file."""
        os.makedirs(os.path.dirname(output_path) if os.path.dirname(output_path) else '.', exist_ok=True)

        if format == 'json':
            with open(output_path, 'w', encoding='utf-8') as f:
                json.dump({
                    'discovered_at': datetime.now().isoformat(),
                    'count': len(self.discovered_companies),
                    'companies': self.discovered_companies
                }, f, indent=2, ensure_ascii=False)
        elif format == 'txt':
            with open(output_path, 'w', encoding='utf-8') as f:
                for company in self.discovered_companies:
                    f.write(f"{company['url']}\n")
        elif format == 'csv':
            import csv
            with open(output_path, 'w', newline='', encoding='utf-8') as f:
                writer = csv.DictWriter(f, fieldnames=['name', 'url', 'slug', 'industry', 'industry_raw', 'location', 'summary'])
                writer.writeheader()
                for company in self.discovered_companies:
                    writer.writerow({k: company.get(k, '') for k in writer.fieldnames})

        print(f"[+] Saved {len(self.discovered_companies)} companies to {output_path}")

    def generate_scraper_list(self, output_path='companies.txt'):
        """Generate a list file compatible with osint_scrape_batch.py"""
        with open(output_path, 'w', encoding='utf-8') as f:
            for company in self.discovered_companies:
                f.write(f"{company['url']}\n")
        print(f"[+] Generated scraper list: {output_path}")
        print(f"    Run: python src/osint_scrape_batch.py {output_path}")

    def close(self):
        """Close the browser (unless it's a shared driver from the test runner)."""
        if self.shared_driver:
            return
        if self.driver:
            self.driver.quit()
            print("[+] Browser closed")


def main():
    from dotenv import load_dotenv
    load_dotenv()

    parser = argparse.ArgumentParser(
        description='OSINT Company Discovery - Find companies on LinkedIn by region',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Discover companies in USA
  python osint_discover.py --geo-code 103644278 --region-name usa --limit 10

  # Search for cybersecurity companies
  python osint_discover.py --geo-code 103644278 --keyword "cybersecurity" --limit 20

  # Filter by industry category
  python osint_discover.py --geo-code 103644278 --industry Cybersecurity --limit 10

  # List available industry categories
  python osint_discover.py --list-industries

  # Use cities file for location validation
  python osint_discover.py --geo-code 103644278 --cities-file config/cities.txt --limit 15

  # Save in different formats
  python osint_discover.py --geo-code 103644278 --output companies.json --format json
  python osint_discover.py --geo-code 103644278 --output companies.txt --format txt

Geo Codes:
  Run --list-geo-codes to see all 50+ supported countries.
  USA: 103644278, UK: 101165590, Germany: 101282230, Israel: 101620260
        """
    )

    parser.add_argument('--keyword', '-k', type=str, default='',
                        help='Search keyword (e.g., "cybersecurity", "fintech")')
    parser.add_argument('--geo-code', '-g', type=str, required=False,
                        help='LinkedIn geo code for region (use --list-geo-codes to see all codes)')
    parser.add_argument('--region-name', '-r', type=str, default='region',
                        help='Name for output files (default: "region")')
    parser.add_argument('--cities-file', type=str, default=None,
                        help='Optional file with city names for location validation')
    parser.add_argument('--industry', '-i', type=str, default=None,
                        help='Filter by industry category (e.g., "Cybersecurity")')
    parser.add_argument('--list-industries', action='store_true',
                        help='Show available industry categories and exit')
    parser.add_argument('--list-geo-codes', action='store_true',
                        help='Show available LinkedIn geo codes and exit')
    parser.add_argument('--limit', '-l', type=int, default=10,
                        help='Maximum companies to discover (default: 10)')
    parser.add_argument('--output', '-o', type=str, default=None,
                        help='Output file path')
    parser.add_argument('--format', '-f', type=str, default='json',
                        choices=['json', 'txt', 'csv'],
                        help='Output format (default: json)')
    parser.add_argument('--email', '-e', type=str, default=None,
                        help='LinkedIn email for login')
    parser.add_argument('--password', '-p', type=str, default=None,
                        help='LinkedIn password for login')
    parser.add_argument('--proxy', default=None,
                        help='Proxy URL for browser (e.g., socks5://host:port)')
    parser.add_argument('--headless', action='store_true',
                        help='Run browser in headless mode')
    parser.add_argument('--verbose', '-v', action='store_true',
                        help='Enable verbose/debug logging')
    parser.add_argument('--generate-list', action='store_true',
                        help='Also generate companies.txt for batch scraper')
    parser.add_argument('--debug-selectors', action='store_true',
                        help='Save raw HTML of each search result page for offline selector debugging')
    parser.add_argument('--use-ai', action='store_true',
                        help='Use Groq AI to score company relevance (requires GROQ_API_KEY in .env)')
    parser.add_argument('--search-objective', type=str, default=None,
                        help='Describe what you are looking for (used with --use-ai for relevance scoring)')

    args = parser.parse_args()
    setup_logging(verbose=args.verbose)

    # Resolve credentials: CLI flags take priority, then .env
    email = args.email or os.environ.get("LINKEDIN_EMAIL")
    password = args.password or os.environ.get("LINKEDIN_PASSWORD")

    # Handle --list-industries
    if args.list_industries:
        list_industries()
        return 0

    # Handle --list-geo-codes
    if args.list_geo_codes:
        list_geo_codes()
        return 0

    # Validate geo_code is provided
    if not args.geo_code:
        print("[-] Error: --geo-code is required")
        print("    Example: --geo-code 103644278 (USA)")
        print("    Use --list-geo-codes to see all available codes")
        return 1

    # Validate industry filter if provided
    if args.industry and args.industry not in INDUSTRY_CATEGORIES:
        print(f"[-] Error: Unknown industry category '{args.industry}'")
        print("    Use --list-industries to see available options")
        return 1

    # Load target cities if specified
    target_cities = load_target_cities(args.cities_file)

    # Default output filename
    if not args.output:
        timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
        args.output = f"output/discovered_companies_{args.region_name}_{timestamp}.{args.format}"

    # Ensure output directory exists
    os.makedirs(os.path.dirname(args.output) if os.path.dirname(args.output) else 'output', exist_ok=True)

    print("=" * 60)
    print("OSINT Company Discovery Tool")
    print("=" * 60)
    print(f"Region: {args.region_name} (geo code: {args.geo_code})")
    print(f"Keyword: {args.keyword or '(none)'}")
    print(f"Industry Filter: {args.industry or '(none)'}")
    print(f"Limit: {args.limit} companies")
    print(f"Output: {args.output}")
    if target_cities:
        print(f"Location validation: {len(target_cities)} cities loaded")
    print("=" * 60)

    discovery = OSINTCompanyDiscovery(
        headless=args.headless,
        target_cities=target_cities,
        debug_selectors=getattr(args, 'debug_selectors', False),
        proxy_url=getattr(args, 'proxy', None),
    )

    try:
        discovery.setup_browser()

        # Login if credentials provided
        if email and password:
            if not discovery.login(email, password):
                print("[-] Login failed. Exiting.")
                return 1
        else:
            # Check if already logged in
            if not check_session(discovery.driver):
                print("[-] Not logged in. Please provide --email and --password")
                return 1

        # Discover companies
        companies = discovery.search_companies_linkedin(
            keyword=args.keyword,
            geo_code=args.geo_code,
            limit=args.limit,
            industry_filter=args.industry
        )

        if not companies:
            print("[!] No companies discovered (search returned zero results)")
            # Still save empty output so downstream tools don't break
            discovery.save_results(args.output, args.format)
            return 0

        # AI relevance scoring (optional)
        if getattr(args, 'use_ai', False):
            objective = args.search_objective or args.keyword or args.industry or ''
            if objective:
                try:
                    from osint_classify_ai import score_companies
                    companies = score_companies(companies, objective)
                    discovery.discovered_companies = companies
                except Exception as e:
                    print(f"[AI] Warning: AI scoring failed ({e}), continuing without it")
            else:
                print("[AI] Skipping scoring: provide --search-objective or --keyword for AI relevance")

        # Count location-validated companies
        if target_cities:
            validated_count = sum(1 for c in companies if discovery.validate_target_location(c))
            print(f"\n[*] Discovered {len(companies)} companies ({validated_count} in target cities)")
        else:
            print(f"\n[*] Discovered {len(companies)} companies")

        # Industry breakdown
        industry_counts = {}
        for c in companies:
            ind = c.get('industry', 'Unknown')
            industry_counts[ind] = industry_counts.get(ind, 0) + 1

        print("\n[*] Industry breakdown:")
        for ind, count in sorted(industry_counts.items(), key=lambda x: x[1], reverse=True):
            print(f"    {ind}: {count}")

        # Save results
        discovery.save_results(args.output, args.format)

        # Generate scraper list if requested
        if args.generate_list:
            list_path = args.output.rsplit('.', 1)[0] + '_batch_list.txt'
            discovery.generate_scraper_list(list_path)

        # Print summary
        print("\n" + "=" * 60)
        print("DISCOVERED COMPANIES")
        print("=" * 60)
        for i, company in enumerate(companies, 1):
            location_ok = "[OK]" if discovery.validate_target_location(company) else "    "
            ai_score = company.get('ai_relevance_score')
            score_str = f" [AI: {ai_score}/100]" if ai_score is not None else ""
            print(f"{i:2}. {location_ok} {company['name']}{score_str}")
            print(f"        URL: {company['url']}")
            print(f"        Industry: {company['industry']} (raw: {company.get('industry_raw', 'N/A')})")
            print(f"        Location: {company['location']}")
            if company.get('ai_reasoning'):
                print(f"        AI: {company['ai_reasoning']}")
            print()

        return 0

    except KeyboardInterrupt:
        print("\n[!] Interrupted by user — saving partial results...")
        if discovery.discovered_companies:
            try:
                discovery.save_results(args.output, args.format)
                print(f"[+] Saved {len(discovery.discovered_companies)} companies to {args.output}")
            except Exception as save_err:
                print(f"[-] Could not save partial results: {save_err}")
        else:
            print("[*] No companies discovered before interruption.")
        return 1
    except Exception as e:
        print(f"[-] Error: {e}")
        import traceback
        traceback.print_exc()
        # Try to save whatever we have
        if discovery.discovered_companies:
            try:
                discovery.save_results(args.output, args.format)
                print(f"[+] Saved {len(discovery.discovered_companies)} partial companies to {args.output}")
            except Exception:
                pass
        return 1
    finally:
        discovery.close()


if __name__ == "__main__":
    sys.exit(main())
