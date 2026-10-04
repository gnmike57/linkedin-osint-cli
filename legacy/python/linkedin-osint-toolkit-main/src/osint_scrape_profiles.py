#!/usr/bin/env python3
"""
LinkedIn Profile Deep Dive
==========================

Analyzes individual LinkedIn profiles to extract:
- About/Summary section
- Experience history
- Education
- Skills

Usage:
    python osint_scrape_profiles.py output/all_companies_people_20260215_120000.json
    python osint_scrape_profiles.py output/all_companies_people_20260215_120000.json --limit 100
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
    create_browser,
    navigate_with_retry,
    ensure_logged_in,
    logger,
    setup_logging,
)
from osint_stealth import human_delay, random_scroll, apply_stealth_js
PAGE_LOAD_TIMEOUT = 30
OUTPUT_DIR = "output"

MIN_DELAY = 3.0
MAX_DELAY = 6.0
BETWEEN_PROFILES_DELAY = 5


class ProfileAnalyzer:
    def __init__(self, email=None, password=None, driver=None, proxy_url=None):
        self.driver = driver
        self.shared_driver = driver is not None
        self.email = email
        self.password = password
        self.proxy_url = proxy_url

    def start_browser(self):
        if self.driver:
            print("[+] Browser started (shared)")
            return
        print("[*] Starting Firefox browser...")
        self.driver = create_browser(page_load_timeout=PAGE_LOAD_TIMEOUT, proxy_url=self.proxy_url)
        print("[+] Browser started")

    def close_browser(self):
        if self.shared_driver:
            return  # Don't close shared browser
        if self.driver:
            self.driver.quit()

    def random_delay(self, min_d=MIN_DELAY, max_d=MAX_DELAY):
        human_delay(min_d, max_d)

    def analyze_profile(self, profile_url: str, name: str = "") -> dict:
        """Extract detailed information from a LinkedIn profile."""
        result = {
            'profile_url': profile_url,
            'name': name,
            'analyzed_at': datetime.now().isoformat(),
            'about': '',
            'experience': [],
            'education': [],
            'skills': [],
            'error': None
        }

        try:
            print(f"    [*] Loading profile...")
            if not navigate_with_retry(self.driver, profile_url, max_retries=2, base_delay=3,
                                       email=self.email, password=self.password):
                result['error'] = 'Navigation failed'
                return result

            # Extract data using JavaScript
            data = self.driver.execute_script("""
                const result = {
                    name: '',
                    headline: '',
                    location: '',
                    about: '',
                    experience: [],
                    education: [],
                    skills: []
                };

                // Name
                const nameEl = document.querySelector('h1.text-heading-xlarge, h1[class*="text-heading"]');
                if (nameEl) result.name = nameEl.textContent.trim();

                // Headline
                const headlineEl = document.querySelector('.text-body-medium[data-generated-suggestion-target]');
                if (headlineEl) result.headline = headlineEl.textContent.trim();

                // Location
                const locationEl = document.querySelector('.text-body-small[class*="text-color-text"]');
                if (locationEl) result.location = locationEl.textContent.trim();

                // About section
                const aboutSection = document.querySelector('#about');
                if (aboutSection) {
                    const aboutContainer = aboutSection.closest('section');
                    if (aboutContainer) {
                        const aboutText = aboutContainer.querySelector('.inline-show-more-text, [class*="show-more-text"], .pv-shared-text-with-see-more span[aria-hidden="true"]');
                        if (aboutText) {
                            result.about = aboutText.textContent.trim();
                        } else {
                            // Fallback: get all span text in about section
                            const spans = aboutContainer.querySelectorAll('span.visually-hidden + span, span[aria-hidden="true"]');
                            for (const span of spans) {
                                const text = span.textContent.trim();
                                if (text.length > 50) {
                                    result.about = text;
                                    break;
                                }
                            }
                        }
                    }
                }

                // Experience section
                const expSection = document.querySelector('#experience');
                if (expSection) {
                    const expContainer = expSection.closest('section');
                    if (expContainer) {
                        const expItems = expContainer.querySelectorAll('li.artdeco-list__item');
                        for (const item of expItems) {
                            const exp = {};

                            // Job title
                            const titleEl = item.querySelector('.t-bold span[aria-hidden="true"], .mr1.t-bold span');
                            if (titleEl) exp.title = titleEl.textContent.trim();

                            // Company
                            const companyEl = item.querySelector('.t-14.t-normal span[aria-hidden="true"]');
                            if (companyEl) exp.company = companyEl.textContent.trim();

                            // Date range
                            const dateEl = item.querySelector('.t-14.t-normal.t-black--light span[aria-hidden="true"]');
                            if (dateEl) exp.dates = dateEl.textContent.trim();

                            // Location
                            const locEl = item.querySelectorAll('.t-14.t-normal.t-black--light span[aria-hidden="true"]');
                            if (locEl.length > 1) exp.location = locEl[1].textContent.trim();

                            // Description
                            const descEl = item.querySelector('.inline-show-more-text span[aria-hidden="true"]');
                            if (descEl) exp.description = descEl.textContent.trim();

                            if (exp.title || exp.company) {
                                result.experience.push(exp);
                            }
                        }
                    }
                }

                // Education section
                const eduSection = document.querySelector('#education');
                if (eduSection) {
                    const eduContainer = eduSection.closest('section');
                    if (eduContainer) {
                        const eduItems = eduContainer.querySelectorAll('li.artdeco-list__item');
                        for (const item of eduItems) {
                            const edu = {};

                            const schoolEl = item.querySelector('.t-bold span[aria-hidden="true"]');
                            if (schoolEl) edu.school = schoolEl.textContent.trim();

                            const degreeEl = item.querySelector('.t-14.t-normal span[aria-hidden="true"]');
                            if (degreeEl) edu.degree = degreeEl.textContent.trim();

                            const datesEl = item.querySelector('.t-14.t-normal.t-black--light span[aria-hidden="true"]');
                            if (datesEl) edu.dates = datesEl.textContent.trim();

                            if (edu.school) {
                                result.education.push(edu);
                            }
                        }
                    }
                }

                // Skills section
                const skillsSection = document.querySelector('#skills');
                if (skillsSection) {
                    const skillsContainer = skillsSection.closest('section');
                    if (skillsContainer) {
                        const skillItems = skillsContainer.querySelectorAll('.t-bold span[aria-hidden="true"]');
                        for (const item of skillItems) {
                            const skill = item.textContent.trim();
                            if (skill && skill.length < 100) {
                                result.skills.push(skill);
                            }
                        }
                    }
                }

                return result;
            """)

            if data:
                result['name'] = data.get('name') or name
                result['headline'] = data.get('headline', '')
                result['location'] = data.get('location', '')
                result['about'] = data.get('about', '')
                result['experience'] = data.get('experience', [])
                result['education'] = data.get('education', [])
                result['skills'] = data.get('skills', [])

            # Try to expand and get more content
            self._try_expand_sections()
            self.random_delay(1, 2)

            # Re-extract after expansion
            expanded_data = self.driver.execute_script("""
                const result = { about: '', experience: [] };

                // About
                const aboutSection = document.querySelector('#about');
                if (aboutSection) {
                    const container = aboutSection.closest('section');
                    if (container) {
                        const text = container.querySelector('.inline-show-more-text--expanded, .pv-shared-text-with-see-more');
                        if (text) result.about = text.textContent.trim();
                    }
                }

                return result;
            """)

            if expanded_data and expanded_data.get('about'):
                result['about'] = expanded_data['about']

        except Exception as e:
            result['error'] = str(e)

        return result

    def _try_expand_sections(self):
        """Try to click 'see more' buttons to expand content."""
        try:
            self.driver.execute_script("""
                // Click all 'see more' buttons
                const seeMoreButtons = document.querySelectorAll('button.inline-show-more-text__button, [class*="see-more"]');
                for (const btn of seeMoreButtons) {
                    try { btn.click(); } catch(e) {}
                }
            """)
        except:
            pass


def load_profiles(filepath: str) -> list:
    """Load profiles from batch scrape results."""
    with open(filepath, 'r', encoding='utf-8') as f:
        data = json.load(f)

    profiles = []

    # Handle different formats
    if 'companies' in data:
        # Batch scrape format
        for company in data['companies']:
            company_name = company.get('company', 'Unknown')
            for person in company.get('people', []):
                profiles.append({
                    'url': person.get('profileUrl', ''),
                    'name': person.get('name', ''),
                    'title': person.get('title', ''),
                    'company': company_name,
                    'image_url': person.get('profileImageUrl', '')
                })
    elif 'divisions' in data:
        # Org chart format
        for div in data['divisions']:
            for level in div.get('levels', []):
                for person in level.get('people', []):
                    profiles.append({
                        'url': person.get('profile_url', ''),
                        'name': person.get('name', ''),
                        'title': person.get('title', ''),
                        'company': 'Unknown',
                        'image_url': person.get('profile_image_url', '')
                    })
    elif 'profiles' in data:
        # Simple profiles format
        for person in data['profiles']:
            profiles.append({
                'url': person.get('profile_url', person.get('profileUrl', '')),
                'name': person.get('name', ''),
                'title': person.get('title', ''),
                'company': 'Unknown',
                'image_url': person.get('profile_image_url', person.get('profileImageUrl', ''))
            })

    # Filter valid URLs
    profiles = [p for p in profiles if p['url'] and 'linkedin.com/in/' in p['url']]

    return profiles


def deep_dive(profiles: list, output_dir: str, limit: int = None,
              email: str = None, password: str = None, driver=None,
              use_ai: bool = False, proxy_url: str = None) -> dict:
    """Perform deep dive analysis on profiles.

    Args:
        driver: Optional pre-authenticated Selenium WebDriver (shared from test runner).
        use_ai: If True, use Groq AI for deep classification of each profile.
    """
    os.makedirs(output_dir, exist_ok=True)

    if limit:
        profiles = profiles[:limit]

    analyzer = ProfileAnalyzer(email=email, password=password, driver=driver, proxy_url=proxy_url)
    analyzer.start_browser()

    results = {
        'generated_at': datetime.now().isoformat(),
        'total_profiles': len(profiles),
        'analyzed': 0,
        'profiles': []
    }

    try:
        for i, profile in enumerate(profiles):
            # Periodic session validation
            if i > 0 and i % 20 == 0:
                print(f"\n    [*] Session check ({i} profiles analyzed)...")
                ensure_logged_in(analyzer.driver, analyzer.email, analyzer.password)

            print(f"\n[{i+1}/{len(profiles)}] {profile['name']}")
            print(f"    Company: {profile['company']}")
            print(f"    Title: {profile['title'][:50]}..." if len(profile.get('title', '')) > 50 else f"    Title: {profile.get('title', 'N/A')}")

            analysis = analyzer.analyze_profile(profile['url'], profile['name'])

            # Merge with original data
            analysis['original_title'] = profile.get('title', '')
            analysis['original_company'] = profile.get('company', '')
            analysis['profile_image_url'] = profile.get('image_url', '')

            # AI deep classification (optional)
            if use_ai and not analysis.get('error'):
                try:
                    from osint_classify_ai import deep_classify, is_available
                    if is_available():
                        # Pass title for context
                        analysis['title'] = profile.get('title', '')
                        analysis = deep_classify(analysis)
                        if analysis.get('ai_role_level'):
                            print(f"    [AI] {analysis['ai_role_level']} / {analysis.get('ai_division', '?')} "
                                  f"(conf: {analysis.get('ai_confidence', '?')})")
                except Exception as e:
                    print(f"    [AI] Warning: deep classify failed ({e})")

            results['profiles'].append(analysis)
            results['analyzed'] = i + 1

            # Show summary
            if analysis['error']:
                print(f"    [-] Error: {analysis['error']}")
            else:
                print(f"    [+] About: {len(analysis['about'])} chars")
                print(f"    [+] Experience: {len(analysis['experience'])} positions")
                print(f"    [+] Education: {len(analysis['education'])} entries")
                print(f"    [+] Skills: {len(analysis['skills'])} skills")

            # Save progress periodically
            if (i + 1) % 10 == 0:
                progress_file = os.path.join(output_dir, 'deep_dive_progress.json')
                with open(progress_file, 'w', encoding='utf-8') as f:
                    json.dump(results, f, indent=2, ensure_ascii=False)
                print(f"\n    [*] Progress saved ({i+1}/{len(profiles)})")

            # Delay between profiles
            if i < len(profiles) - 1:
                base_delay = BETWEEN_PROFILES_DELAY + random.uniform(0, 3)
                print(f"    [*] Waiting ~{base_delay:.0f}s...")
                human_delay(base_delay * 0.7, base_delay * 1.3)

    except KeyboardInterrupt:
        print("\n\n[!] Interrupted - saving results...")

    finally:
        analyzer.close_browser()

    # Save final results
    output_file = os.path.join(output_dir, f'deep_dive_results_{datetime.now().strftime("%Y%m%d_%H%M%S")}.json')
    with open(output_file, 'w', encoding='utf-8') as f:
        json.dump(results, f, indent=2, ensure_ascii=False)

    print(f"\n{'='*60}")
    print("DEEP DIVE COMPLETE")
    print(f"{'='*60}")
    print(f"Profiles analyzed: {results['analyzed']}/{len(profiles)}")
    print(f"Results saved to: {output_file}")

    # Summary stats
    with_about = sum(1 for p in results['profiles'] if p.get('about'))
    with_exp = sum(1 for p in results['profiles'] if p.get('experience'))
    print(f"\nWith About section: {with_about}")
    print(f"With Experience: {with_exp}")

    return results


def main():
    from dotenv import load_dotenv
    load_dotenv()

    parser = argparse.ArgumentParser(description="Deep dive analysis of LinkedIn profiles")
    parser.add_argument("input_file", help="JSON file with profiles (batch scrape results or org chart)")
    parser.add_argument("-o", "--output", default=OUTPUT_DIR, help="Output directory")
    parser.add_argument("-l", "--limit", type=int, help="Limit number of profiles to analyze")
    parser.add_argument("--start", type=int, default=0, help="Start from profile number")
    parser.add_argument("-e", "--email", help="LinkedIn email for login")
    parser.add_argument("-p", "--password", help="LinkedIn password for login")
    parser.add_argument("--proxy", default=None, help="Proxy URL (e.g., socks5://host:port)")
    parser.add_argument("-v", "--verbose", action="store_true", help="Enable verbose/debug logging")
    parser.add_argument("--use-ai", action="store_true",
                        help="Use Groq AI for deep profile classification (requires GROQ_API_KEY in .env)")
    args = parser.parse_args()
    setup_logging(verbose=args.verbose)

    # Resolve credentials: CLI flags take priority, then .env
    email = args.email or os.environ.get("LINKEDIN_EMAIL")
    password = args.password or os.environ.get("LINKEDIN_PASSWORD")

    if not os.path.exists(args.input_file):
        print(f"[-] File not found: {args.input_file}")
        sys.exit(1)

    profiles = load_profiles(args.input_file)
    print(f"[+] Loaded {len(profiles)} profiles from {args.input_file}")

    if not profiles:
        print("[-] No valid profiles found")
        sys.exit(1)

    if args.start > 0:
        profiles = profiles[args.start:]
        print(f"[*] Starting from profile #{args.start}")

    if args.limit:
        print(f"[*] Limiting to {args.limit} profiles")

    print(f"\n[*] Starting deep dive analysis...")
    print("[*] Press Ctrl+C to stop and save partial results\n")

    deep_dive(profiles, args.output, args.limit,
              email=email, password=password,
              use_ai=args.use_ai,
              proxy_url=getattr(args, 'proxy', None))


if __name__ == "__main__":
    main()
