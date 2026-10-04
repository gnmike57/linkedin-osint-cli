#!/usr/bin/env python3
"""
Batch LinkedIn Company People Scraper
======================================

Scrapes people from multiple LinkedIn company pages.
Stores all data in a unified database for later analysis.

Usage:
    python osint_scrape_batch.py list.txt
    python osint_scrape_batch.py list.txt -e email -p password
"""

import os
import sys
import json
import time
import random
import argparse
from datetime import datetime

# Shared login and utilities from osint_auth module
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from osint_auth import (
    normalize_input,
    create_browser,
    login_to_linkedin,
    ensure_logged_in,
    navigate_with_retry,
    logger,
    setup_logging,
)
from osint_stealth import human_delay, random_scroll, apply_stealth_js


# Configuration
PAGE_LOAD_TIMEOUT = 60
OUTPUT_DIR = "output"
MASTER_DB_FILE = None  # Generated with timestamp at runtime

# Delays
MIN_ACTION_DELAY = 2.0
MAX_ACTION_DELAY = 4.0
MIN_SCROLL_DELAY = 1.0
MAX_SCROLL_DELAY = 2.0
BETWEEN_COMPANIES_DELAY = 10  # seconds between companies

# Session validation
SESSION_CHECK_INTERVAL = 5  # Check session every N companies


class CompanyScraper:
    def __init__(self, company_url: str, driver=None, shared_driver=False,
                 industry='Unknown', industry_raw='',
                 email=None, password=None):
        # Use normalize_input to accept both short names and full URLs
        self.company_url = normalize_input(company_url)
        self.company_name = self._extract_company_name(self.company_url)
        self.driver = driver
        self.shared_driver = shared_driver
        self.all_people = {}
        self.industry = industry
        self.industry_raw = industry_raw
        self.email = email
        self.password = password

    def _extract_company_name(self, url: str) -> str:
        import re
        match = re.search(r'/company/([^/]+)', url)
        if match:
            return match.group(1)
        return 'unknown'

    def start_browser(self):
        if self.driver:
            return
        self.driver = create_browser(page_load_timeout=PAGE_LOAD_TIMEOUT)

    def close_browser(self):
        if self.driver and not self.shared_driver:
            try:
                self.driver.quit()
            except:
                pass

    def random_delay(self, min_d=MIN_ACTION_DELAY, max_d=MAX_ACTION_DELAY):
        human_delay(min_d, max_d)

    def navigate(self) -> bool:
        """Navigate to company page with retry and auth redirect handling."""
        success = navigate_with_retry(
            self.driver,
            self.company_url,
            max_retries=3,
            base_delay=5,
            email=self.email,
            password=self.password,
        )
        if not success:
            print(f"    [!] Failed to navigate to {self.company_name}")
        return success

    def extract_people(self) -> list:
        try:
            people = self.driver.execute_script("""
                const results = [];
                const seenUrls = new Set();
                const profileLinks = document.querySelectorAll('a[href*="/in/"]');

                for (const link of profileLinks) {
                    try {
                        const href = link.href || '';
                        if (!href.includes('linkedin.com/in/')) continue;
                        if (href.includes('/messaging/') || href.includes('/detail/')) continue;

                        let profileUrl = href.split('?')[0].split('#')[0];
                        const match = profileUrl.match(/linkedin\\.com\\/in\\/([^/]+)/);
                        if (!match) continue;
                        profileUrl = 'https://www.linkedin.com/in/' + match[1];

                        if (seenUrls.has(profileUrl)) continue;

                        let container = link;
                        for (let i = 0; i < 15 && container; i++) {
                            if (container.tagName === 'SECTION' || container.tagName === 'LI' ||
                                container.classList.contains('artdeco-card') ||
                                container.classList.contains('org-people-profile-card__profile-card-spacing')) {
                                break;
                            }
                            container = container.parentElement;
                        }
                        if (!container) continue;

                        const isInPeopleSection = container.closest('.scaffold-finite-scroll__content') ||
                                                   container.closest('.org-people-profile-card__card-spacing') ||
                                                   container.closest('ul.display-flex');
                        if (!isInPeopleSection) continue;

                        let name = '';
                        const nameElement = container.querySelector('.artdeco-entity-lockup__title a');
                        if (nameElement) {
                            name = nameElement.textContent.trim();
                        } else {
                            const linkText = link.textContent.trim();
                            if (linkText.length >= 2 && linkText.length < 100 &&
                                !linkText.includes('mutual') && !linkText.includes('connection')) {
                                name = linkText;
                            }
                        }
                        if (!name || name.length < 2) continue;

                        let title = '';
                        const titleElement = container.querySelector('.artdeco-entity-lockup__subtitle');
                        if (titleElement) title = titleElement.textContent.trim();

                        let connectionDegree = '';
                        const containerText = container.textContent || '';
                        if (/\\b3rd\\+?\\b/i.test(containerText)) connectionDegree = '3rd+';
                        else if (/\\b2nd\\b/i.test(containerText)) connectionDegree = '2nd';
                        else if (/\\b1st\\b/i.test(containerText)) connectionDegree = '1st';

                        let profileImageUrl = '';
                        const imgs = container.querySelectorAll('img[src*="media.licdn.com"]');
                        for (const img of imgs) {
                            if (img.src.includes('profile')) {
                                profileImageUrl = img.src;
                                break;
                            }
                        }
                        if (!profileImageUrl) {
                            const anyImg = container.querySelector('img[src*="media.licdn.com"]');
                            if (anyImg) profileImageUrl = anyImg.src;
                        }

                        seenUrls.add(profileUrl);
                        results.push({
                            name: name,
                            title: title,
                            profileUrl: profileUrl,
                            profileImageUrl: profileImageUrl,
                            connectionDegree: connectionDegree
                        });
                    } catch (e) {}
                }
                return results;
            """)
            return people or []
        except Exception as e:
            return []

    def click_show_more(self) -> bool:
        try:
            result = self.driver.execute_script("""
                let btn = null;
                const buttons = document.querySelectorAll('button');
                for (const b of buttons) {
                    const text = b.textContent.trim().toLowerCase();
                    if (text.includes('show more') || text === 'load more') {
                        btn = b;
                        break;
                    }
                }
                if (!btn) btn = document.querySelector('.scaffold-finite-scroll__load-button');
                if (!btn) return {clicked: false};
                if (btn.disabled) return {clicked: false, disabled: true};
                btn.scrollIntoView({behavior: 'smooth', block: 'center'});
                btn.click();
                return {clicked: true};
            """)
            return result.get('clicked', False)
        except:
            return False

    def scrape(self) -> dict:
        print(f"\n[*] Scraping: {self.company_name}")
        print(f"    URL: {self.company_url}")

        if not self.navigate():
            return {'company': self.company_name, 'url': self.company_url, 'people': [], 'error': 'Navigation failed'}

        # Scroll and extract
        self.driver.execute_script("window.scrollTo(0, document.body.scrollHeight);")
        self.random_delay(1, 2)

        people = self.extract_people()
        for p in people:
            self.all_people[p['profileUrl']] = p

        print(f"    [+] Initial: {len(self.all_people)} people")

        # Click show more repeatedly
        iteration = 0
        no_new_count = 0
        while no_new_count < 5:
            iteration += 1
            prev_count = len(self.all_people)

            self.driver.execute_script("window.scrollTo(0, document.body.scrollHeight);")
            human_delay(MIN_SCROLL_DELAY, MAX_SCROLL_DELAY)

            if not self.click_show_more():
                break

            self.random_delay()
            people = self.extract_people()
            for p in people:
                self.all_people[p['profileUrl']] = p

            new_count = len(self.all_people) - prev_count
            if new_count == 0:
                no_new_count += 1
            else:
                no_new_count = 0

            if iteration % 5 == 0:
                print(f"    [*] Progress: {len(self.all_people)} people")

        print(f"    [+] Total: {len(self.all_people)} people")

        return {
            'company': self.company_name,
            'url': self.company_url,
            'industry': getattr(self, 'industry', 'Unknown'),
            'industry_raw': getattr(self, 'industry_raw', ''),
            'people': list(self.all_people.values()),
            'count': len(self.all_people),
            'scraped_at': datetime.now().isoformat()
        }


def load_companies(filepath: str) -> list:
    """
    Load companies from TXT (URLs) or JSON (with metadata).

    For TXT files: accepts both short names and full URLs, one per line.
    Lines starting with # are treated as comments.

    For JSON files: expects format from osint_discover.py
    with 'companies' array containing url, industry, etc.

    Returns:
        List of dicts with at least 'url' key, optionally 'industry', 'name', etc.
    """
    companies = []

    if filepath.endswith('.json'):
        with open(filepath, 'r', encoding='utf-8') as f:
            data = json.load(f)
        # Handle output from osint_discover.py
        if 'companies' in data:
            for company in data['companies']:
                companies.append({
                    'url': normalize_input(company.get('url', '')),
                    'name': company.get('name', ''),
                    'industry': company.get('industry', 'Unknown'),
                    'industry_raw': company.get('industry_raw', ''),
                    'location': company.get('location', ''),
                })
        elif isinstance(data, list):
            for item in data:
                if isinstance(item, str):
                    companies.append({'url': normalize_input(item)})
                elif isinstance(item, dict) and 'url' in item:
                    item['url'] = normalize_input(item['url'])
                    companies.append(item)
    else:
        # TXT file - one URL per line
        with open(filepath, 'r') as f:
            for line in f:
                line = line.strip()
                # Skip empty lines and comments
                if not line or line.startswith('#'):
                    continue
                # Normalize the input (accepts both short names and full URLs)
                normalized = normalize_input(line)
                companies.append({'url': normalized})

    return companies


def scrape_all_companies(companies: list, output_dir: str, email=None, password=None,
                         driver=None, proxy_url=None) -> dict:
    """
    Scrape all companies sequentially using a single browser.

    Includes periodic session validation every SESSION_CHECK_INTERVAL companies.

    Args:
        companies: List of company dicts with 'url' and optional 'industry', 'name', etc.
                   Can also be a list of URL strings for backward compatibility.
        output_dir: Directory to save results
        email: Optional LinkedIn email for login
        password: Optional LinkedIn password for login
        driver: Optional pre-authenticated Selenium WebDriver (shared from test runner).
                When provided, skips browser creation and login.
    """
    os.makedirs(output_dir, exist_ok=True)

    # Handle backward compatibility with list of URLs
    if companies and isinstance(companies[0], str):
        companies = [{'url': url} for url in companies]

    all_results = {
        'generated_at': datetime.now().isoformat(),
        'total_companies': len(companies),
        'companies': []
    }

    shared_driver = driver is not None

    if driver:
        # Using shared driver from test runner -- already logged in
        print("\n[*] Starting Firefox browser...")
        print("[+] Using shared browser (already authenticated)")
    else:
        # Start our own browser
        print("\n[*] Starting Firefox browser...")
        driver = create_browser(page_load_timeout=PAGE_LOAD_TIMEOUT, proxy_url=proxy_url)

        # Login if credentials provided
        if email and password:
            if not login_to_linkedin(driver, email, password):
                print("[-] Login failed. Exiting.")
                driver.quit()
                return all_results

    total_people = 0

    try:
        for i, company_data in enumerate(companies):
            print(f"\n{'='*60}")
            print(f"COMPANY {i+1}/{len(companies)}")
            print(f"{'='*60}")

            # ------------------------------------------------------------------
            # Periodic session validation
            # ------------------------------------------------------------------
            if i > 0 and i % SESSION_CHECK_INTERVAL == 0:
                print(f"\n[*] Session check ({i} companies scraped)...")
                if not ensure_logged_in(driver, email, password):
                    print("[-] Session expired and could not re-authenticate. Stopping.")
                    break
                print("[+] Session is valid, continuing...")

            url = company_data.get('url', company_data) if isinstance(company_data, dict) else company_data
            industry = company_data.get('industry', 'Unknown') if isinstance(company_data, dict) else 'Unknown'
            industry_raw = company_data.get('industry_raw', '') if isinstance(company_data, dict) else ''

            try:
                scraper = CompanyScraper(
                    url,
                    driver=driver,
                    shared_driver=True,
                    industry=industry,
                    industry_raw=industry_raw,
                    email=email,
                    password=password,
                )
                result = scraper.scrape()

                all_results['companies'].append(result)
                total_people += result.get('count', 0)

                # Save individual company result
                company_ts = datetime.now().strftime('%Y%m%d_%H%M%S')
                company_file = os.path.join(output_dir, f"{scraper.company_name}_{company_ts}.json")
                with open(company_file, 'w', encoding='utf-8') as f:
                    json.dump(result, f, indent=2, ensure_ascii=False)

                print(f"    [+] Saved to: {company_file}")
            except Exception as e:
                company_name = url.split('/company/')[-1].split('/')[0] if '/company/' in url else 'unknown'
                print(f"    [-] ERROR scraping {company_name}: {e}")
                import traceback
                traceback.print_exc()
                all_results['companies'].append({
                    'company': company_name,
                    'url': url,
                    'people': [],
                    'count': 0,
                    'error': str(e),
                })

            # Delay between companies
            if i < len(companies) - 1:
                base_delay = BETWEEN_COMPANIES_DELAY + random.uniform(0, 5)
                print(f"    [*] Waiting ~{base_delay:.0f}s before next company...")
                human_delay(base_delay * 0.7, base_delay * 1.3)

    except KeyboardInterrupt:
        print("\n\n[!] Interrupted by user - saving partial results...")

    finally:
        if not shared_driver:
            driver.quit()

    # Save master database
    all_results['total_people'] = total_people
    all_results['companies_scraped'] = len(all_results['companies'])

    timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
    master_file = os.path.join(output_dir, f"all_companies_people_{timestamp}.json")
    with open(master_file, 'w', encoding='utf-8') as f:
        json.dump(all_results, f, indent=2, ensure_ascii=False)

    print(f"\n{'='*60}")
    print("BATCH SCRAPING COMPLETE")
    print(f"{'='*60}")
    print(f"Companies scraped: {len(all_results['companies'])}/{len(companies)}")
    print(f"Total people collected: {total_people}")
    print(f"Master database: {master_file}")

    return all_results


def main():
    parser = argparse.ArgumentParser(
        description="Batch scrape LinkedIn company people",
        epilog="""
Input file formats:
  TXT: One company URL per line (lines starting with # are comments)
  JSON: Output from osint_discover.py with industry metadata

Examples:
  python osint_scrape_batch.py companies.txt
  python osint_scrape_batch.py output/discovered_companies_usa_20260215_120000.json
        """
    )
    parser.add_argument("list_file", help="File containing company URLs (TXT) or company data (JSON)")
    parser.add_argument("-o", "--output", default=OUTPUT_DIR, help="Output directory")
    parser.add_argument("-e", "--email", help="LinkedIn email for login")
    parser.add_argument("-p", "--password", help="LinkedIn password for login")
    parser.add_argument("--proxy", default=None, help="Proxy URL (e.g., socks5://host:port)")
    parser.add_argument("-v", "--verbose", action="store_true", help="Enable verbose/debug logging")
    args = parser.parse_args()
    setup_logging(verbose=args.verbose)

    # Load .env for credentials and API keys
    from dotenv import load_dotenv
    load_dotenv()

    # Resolve credentials: CLI flags take priority, then .env
    email = args.email or os.environ.get("LINKEDIN_EMAIL")
    password = args.password or os.environ.get("LINKEDIN_PASSWORD")

    if not os.path.exists(args.list_file):
        print(f"[-] File not found: {args.list_file}")
        sys.exit(1)

    # Load companies (supports both TXT and JSON)
    companies = load_companies(args.list_file)
    print(f"[+] Loaded {len(companies)} companies from {args.list_file}")

    if not companies:
        print("[-] No valid companies found")
        sys.exit(1)

    print("\nCompanies to scrape:")
    for i, company in enumerate(companies):
        url = company.get('url', '')
        name = url.split('/company/')[-1].split('/')[0] if url else 'unknown'
        industry = company.get('industry', 'Unknown')
        print(f"  {i+1}. {name} ({industry})")

    print(f"\n[*] Starting batch scrape of {len(companies)} companies...")
    print("[*] Press Ctrl+C to stop and save partial results\n")

    scrape_all_companies(companies, args.output, email=email, password=password, proxy_url=getattr(args, "proxy", None))


if __name__ == "__main__":
    main()
