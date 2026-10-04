#!/usr/bin/env python3
"""
LinkedIn Company People Scraper
===============================

Scrapes all people associated with a LinkedIn company page.
Uses resilient selectors that prioritize semantic attributes over volatile CSS classes.

Usage:
    python osint_scrape_company.py <company_people_url>
    python osint_scrape_company.py https://www.linkedin.com/company/acme-corp/people/
    python osint_scrape_company.py acme-corp -e email -p password

Output:
    CSV file with columns: name, title, profile_url, profile_image_url, connection_degree, mutual_connections, action_state
"""

import os
import sys
import csv
import re
import time
import random
import argparse
import threading
import subprocess
from datetime import datetime

# Shared login and utilities from osint_auth module
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from osint_auth import (
    normalize_input,
    create_browser,
    login_to_linkedin,
    navigate_with_retry,
    logger,
    setup_logging,
)
from osint_stealth import human_delay, random_scroll, apply_stealth_js


# ============================================================================
# CONFIGURATION
# ============================================================================

PAGE_LOAD_TIMEOUT = 60
OUTPUT_DIR = "output"

# Delay settings
MIN_ACTION_DELAY = 2.0
MAX_ACTION_DELAY = 4.0
MIN_SCROLL_DELAY = 1.0
MAX_SCROLL_DELAY = 2.0

# Content loading settings
CONTENT_WAIT_TIMEOUT = 15
CONTENT_CHECK_INTERVAL = 0.5
MAX_SHOW_MORE_RETRIES = 3
MAX_CONSECUTIVE_NO_NEW = 5


# ============================================================================
# SCREEN LOCK PREVENTION
# ============================================================================

class ScreenLockPreventer:
    def __init__(self):
        self.running = False
        self.thread = None

    def start(self):
        self.running = True
        self.thread = threading.Thread(target=self._keep_alive, daemon=True)
        self.thread.start()
        self._disable_screen_lock()

    def stop(self):
        self.running = False
        if self.thread:
            self.thread.join(timeout=2)

    def _disable_screen_lock(self):
        methods = [
            ["gsettings", "set", "org.gnome.desktop.screensaver", "lock-enabled", "false"],
            ["gsettings", "set", "org.gnome.desktop.screensaver", "idle-activation-enabled", "false"],
            ["gsettings", "set", "org.gnome.desktop.session", "idle-delay", "0"],
            ["xset", "s", "off"],
            ["xset", "-dpms"],
            ["xset", "s", "noblank"],
        ]
        for cmd in methods:
            try:
                subprocess.run(cmd, capture_output=True, timeout=5)
            except Exception:
                pass

    def _keep_alive(self):
        while self.running:
            try:
                subprocess.run(["xdotool", "key", "shift"], capture_output=True, timeout=5)
            except Exception:
                try:
                    subprocess.run(["xset", "s", "reset"], capture_output=True, timeout=5)
                except Exception:
                    pass
            time.sleep(60)


# ============================================================================
# SCRAPER CLASS
# ============================================================================

class LinkedInCompanyPeopleScraper:
    def __init__(self, company_url: str, output_dir: str, email=None, password=None,
                 max_pages=None, max_profiles=None, driver=None, proxy_url=None):
        # Use normalize_input to accept both short names and full URLs
        self.company_url = normalize_input(company_url)
        self.output_dir = output_dir
        os.makedirs(output_dir, exist_ok=True)
        self.driver = driver
        self.shared_driver = driver is not None
        self.all_people = {}
        self.company_name = self._extract_company_name(self.company_url)
        self.email = email
        self.password = password
        self.max_pages = max_pages
        self.max_profiles = max_profiles
        self.proxy_url = proxy_url

    def _extract_company_name(self, url: str) -> str:
        match = re.search(r'/company/([^/]+)', url)
        if match:
            return match.group(1)
        return 'unknown_company'

    def start_browser(self):
        if self.driver:
            # Already have a shared driver from the test runner
            print("[+] Firefox started (shared)")
            return
        print("[*] Starting Firefox browser...")
        self.driver = create_browser(page_load_timeout=PAGE_LOAD_TIMEOUT, proxy_url=self.proxy_url)
        print("[+] Firefox started")

    def close_browser(self):
        if self.shared_driver:
            return  # Don't close shared browser
        if self.driver:
            try:
                self.driver.quit()
                print("[+] Browser closed")
            except Exception:
                pass

    def random_delay(self, min_delay: float = MIN_ACTION_DELAY, max_delay: float = MAX_ACTION_DELAY):
        human_delay(min_delay, max_delay)

    def navigate_to_company_people(self) -> bool:
        """Navigate to company people page with retry and optional auto-login."""
        print(f"[*] Navigating to: {self.company_url}")
        return navigate_with_retry(
            self.driver,
            self.company_url,
            max_retries=3,
            base_delay=5,
            email=self.email,
            password=self.password,
        )

    def get_total_members_count(self) -> int:
        try:
            count = self.driver.execute_script("""
                const header = document.querySelector('h2');
                if (header) {
                    const text = header.textContent;
                    const match = text.match(/(\\d+)\\s*associated\\s*members/i);
                    if (match) return parseInt(match[1]);
                }
                const allH2 = document.querySelectorAll('h2');
                for (const h of allH2) {
                    const text = h.textContent;
                    const match = text.match(/(\\d+)\\s*associated\\s*members/i);
                    if (match) return parseInt(match[1]);
                }
                return 0;
            """)
            return count or 0
        except Exception:
            return 0

    def scroll_to_bottom(self):
        try:
            self.driver.execute_script("""
                window.scrollTo(0, document.body.scrollHeight);
            """)
            human_delay(MIN_SCROLL_DELAY, MAX_SCROLL_DELAY)
        except Exception:
            pass

    def scroll_to_element(self, element):
        try:
            self.driver.execute_script("arguments[0].scrollIntoView({behavior: 'smooth', block: 'center'});", element)
            time.sleep(0.5)
        except Exception:
            pass

    def extract_people_from_page(self) -> list:
        """
        Extract all visible people from the company people page.
        Uses resilient selectors prioritizing semantic attributes.
        """
        try:
            people = self.driver.execute_script("""
                const results = [];
                const seenUrls = new Set();
                
                // Find all profile cards in the people section
                // Strategy 1: Find profile links within the people list
                const profileLinks = document.querySelectorAll('a[href*="/in/"]');
                
                for (const link of profileLinks) {
                    try {
                        const href = link.href || '';
                        
                        // Skip non-profile links
                        if (!href.includes('linkedin.com/in/')) continue;
                        if (href.includes('/messaging/') || href.includes('/detail/')) continue;
                        
                        // Normalize URL
                        let profileUrl = href.split('?')[0].split('#')[0];
                        const match = profileUrl.match(/linkedin\\.com\\/in\\/([^/]+)/);
                        if (!match) continue;
                        profileUrl = 'https://www.linkedin.com/in/' + match[1];
                        
                        // Skip if already seen
                        if (seenUrls.has(profileUrl)) continue;
                        
                        // Find the card container (walk up to find section or li)
                        let container = link;
                        for (let i = 0; i < 15 && container; i++) {
                            if (container.tagName === 'SECTION' || 
                                container.tagName === 'LI' ||
                                container.classList.contains('artdeco-card') ||
                                container.classList.contains('org-people-profile-card__profile-card-spacing')) {
                                break;
                            }
                            container = container.parentElement;
                        }
                        
                        if (!container) continue;
                        
                        // Check if this is inside a profile card section (not header/navigation)
                        const isInPeopleSection = container.closest('.scaffold-finite-scroll__content') ||
                                                   container.closest('.org-people-profile-card__card-spacing') ||
                                                   container.closest('ul.display-flex');
                        
                        if (!isInPeopleSection) continue;
                        
                        // Extract name
                        let name = '';
                        const nameElement = container.querySelector('.artdeco-entity-lockup__title a, [class*="entity-lockup__title"] a');
                        if (nameElement) {
                            name = nameElement.textContent.trim();
                        } else {
                            // Fallback: use the link text if it looks like a name
                            const linkText = link.textContent.trim();
                            if (linkText.length >= 2 && linkText.length < 100 && 
                                !linkText.includes('mutual') && !linkText.includes('connection')) {
                                name = linkText;
                            }
                        }
                        
                        if (!name || name.length < 2) continue;
                        
                        // Extract title/headline
                        let title = '';
                        const titleElement = container.querySelector('.artdeco-entity-lockup__subtitle, [class*="entity-lockup__subtitle"]');
                        if (titleElement) {
                            title = titleElement.textContent.trim();
                        }
                        
                        // Extract connection degree
                        let connectionDegree = '';
                        const degreeElement = container.querySelector('.artdeco-entity-lockup__degree, [class*="entity-lockup__degree"]');
                        if (degreeElement) {
                            const degreeText = degreeElement.textContent.trim();
                            const degreeMatch = degreeText.match(/(1st|2nd|3rd\\+?)/i);
                            if (degreeMatch) {
                                connectionDegree = degreeMatch[1];
                            }
                        }
                        // Fallback: search container text
                        if (!connectionDegree) {
                            const containerText = container.textContent || '';
                            if (/\\b3rd\\+?\\b/i.test(containerText)) connectionDegree = '3rd+';
                            else if (/\\b2nd\\b/i.test(containerText)) connectionDegree = '2nd';
                            else if (/\\b1st\\b/i.test(containerText)) connectionDegree = '1st';
                        }
                        
                        // Extract mutual connections
                        let mutualConnections = '';
                        const mutualElement = container.querySelector('[class*="lt-line-clamp"][class*="t-12"], .t-12.t-black--light');
                        if (mutualElement) {
                            const mutualText = mutualElement.textContent.trim();
                            if (mutualText.includes('mutual') || mutualText.includes('connection') || mutualText.includes('follower')) {
                                mutualConnections = mutualText;
                            }
                        }
                        // Fallback: find text with "mutual connection" pattern
                        if (!mutualConnections) {
                            const allSpans = container.querySelectorAll('span');
                            for (const span of allSpans) {
                                const text = span.textContent.trim();
                                if (text.includes('mutual connection') || text.includes('other mutual')) {
                                    mutualConnections = text;
                                    break;
                                }
                            }
                        }
                        
                        // Extract action state (Connect, Pending, Follow)
                        let actionState = '';
                        const footer = container.querySelector('footer');
                        if (footer) {
                            const buttons = footer.querySelectorAll('button');
                            for (const btn of buttons) {
                                const btnText = btn.textContent.trim().toLowerCase();
                                if (btnText === 'connect' || btnText === 'pending' || btnText === 'follow') {
                                    actionState = btnText.charAt(0).toUpperCase() + btnText.slice(1);
                                    break;
                                }
                            }
                        }
                        // Fallback: check aria-label
                        if (!actionState) {
                            const actionBtn = container.querySelector('button[aria-label*="Invite"], button[aria-label*="Pending"], button[aria-label*="Follow"]');
                            if (actionBtn) {
                                const label = actionBtn.getAttribute('aria-label') || '';
                                if (label.includes('Pending')) actionState = 'Pending';
                                else if (label.includes('Invite') || label.includes('connect')) actionState = 'Connect';
                                else if (label.includes('Follow')) actionState = 'Follow';
                            }
                        }

                        // Extract profile image URL
                        let profileImageUrl = '';
                        // Strategy 1: Look for img with LinkedIn CDN URL
                        const imgElements = container.querySelectorAll('img[src*="media.licdn.com"], img[src*="profile-displayphoto"]');
                        for (const img of imgElements) {
                            const src = img.src || '';
                            if (src.includes('media.licdn.com') && src.includes('profile')) {
                                profileImageUrl = src;
                                break;
                            }
                        }
                        // Strategy 2: Look for ghost-person or default avatar and skip
                        if (!profileImageUrl) {
                            const allImgs = container.querySelectorAll('img');
                            for (const img of allImgs) {
                                const src = img.src || '';
                                // Skip default/placeholder images
                                if (src.includes('ghost') || src.includes('default') || src.includes('data:image')) {
                                    continue;
                                }
                                if (src.includes('media.licdn.com')) {
                                    profileImageUrl = src;
                                    break;
                                }
                            }
                        }
                        // Strategy 3: Check data-delayed-url or data-ghost-url attributes
                        if (!profileImageUrl) {
                            const imgWithData = container.querySelector('img[data-delayed-url*="media.licdn.com"]');
                            if (imgWithData) {
                                profileImageUrl = imgWithData.getAttribute('data-delayed-url') || '';
                            }
                        }

                        seenUrls.add(profileUrl);
                        results.push({
                            name: name,
                            title: title,
                            profileUrl: profileUrl,
                            profileImageUrl: profileImageUrl,
                            connectionDegree: connectionDegree,
                            mutualConnections: mutualConnections,
                            actionState: actionState
                        });
                        
                    } catch (e) {
                        // Skip this element on error
                    }
                }
                
                return results;
            """)
            return people or []
        except Exception as e:
            print(f"    [-] Extraction error: {e}")
            return []

    def add_people(self, people: list) -> int:
        new_count = 0
        for person in people:
            url = person.get('profileUrl', '')
            if url and url not in self.all_people:
                self.all_people[url] = person
                new_count += 1
        return new_count

    def click_show_more(self) -> bool:
        """
        Click the "Show more results" button if present and enabled.
        Returns True if clicked, False otherwise.
        """
        try:
            result = self.driver.execute_script("""
                // Find "Show more results" button
                // Strategy 1: Button with exact text
                let btn = null;
                const buttons = document.querySelectorAll('button');
                for (const b of buttons) {
                    const text = b.textContent.trim().toLowerCase();
                    if (text.includes('show more') || text === 'load more') {
                        btn = b;
                        break;
                    }
                }
                
                // Strategy 2: Scaffold finite scroll load button
                if (!btn) {
                    btn = document.querySelector('.scaffold-finite-scroll__load-button');
                }
                
                // Strategy 3: Any button in scaffold-finite-scroll area
                if (!btn) {
                    const scrollArea = document.querySelector('.scaffold-finite-scroll');
                    if (scrollArea) {
                        btn = scrollArea.querySelector('button');
                    }
                }
                
                if (!btn) return {found: false, clicked: false};
                
                // Check if disabled
                if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') {
                    return {found: true, clicked: false, disabled: true};
                }
                
                // Scroll to button and click
                btn.scrollIntoView({behavior: 'smooth', block: 'center'});
                btn.click();
                return {found: true, clicked: true};
            """)
            
            if result.get('clicked'):
                return True
            elif result.get('disabled'):
                print("    [*] Show more button is disabled (end of list)")
                return False
            else:
                return False
                
        except Exception as e:
            return False

    def scrape_all_people(self):
        """Main scraping loop: extract people and click Show More until done."""
        print("\n" + "=" * 70)
        print(f"SCRAPING COMPANY: {self.company_name}")
        print("=" * 70)
        
        total_members = self.get_total_members_count()
        if total_members > 0:
            print(f"[*] Total associated members: {total_members}")
        else:
            print("[*] Could not determine total member count")

        if self.max_profiles:
            print(f"[*] Max profiles limit: {self.max_profiles}")
        if self.max_pages:
            print(f"[*] Max pages limit: {self.max_pages}")
        
        # Initial extraction
        print("\n[*] Extracting visible profiles...")
        self.scroll_to_bottom()
        self.random_delay(1, 2)
        
        people = self.extract_people_from_page()
        new_count = self.add_people(people)
        print(f"[+] Initial extraction: {len(people)} found, {new_count} new (total: {len(self.all_people)})")

        # Check max_profiles after initial extraction
        if self.max_profiles and len(self.all_people) >= self.max_profiles:
            print(f"\n[+] Reached max profiles limit ({self.max_profiles})")
        else:
            # Click "Show more" repeatedly
            iteration = 0
            consecutive_no_new = 0
            
            while True:
                iteration += 1
                previous_count = len(self.all_people)

                # Check max_pages limit
                if self.max_pages and iteration > self.max_pages:
                    print(f"\n[+] Reached max pages limit ({self.max_pages})")
                    break
                
                # Scroll and click show more
                self.scroll_to_bottom()
                self.random_delay(MIN_SCROLL_DELAY, MAX_SCROLL_DELAY)
                
                clicked = self.click_show_more()
                if not clicked:
                    print(f"\n[*] No more 'Show more' button - scraping complete")
                    break
                
                # Wait for new content to load
                print(f"    [*] Loading more results (iteration {iteration})...")
                self.random_delay()
                
                # Extract newly loaded profiles
                people = self.extract_people_from_page()
                new_count = self.add_people(people)
                
                print(f"    [+] Extracted: {len(people)} visible, {new_count} new (total: {len(self.all_people)})")
                
                # Check if we're still finding new people
                if new_count == 0:
                    consecutive_no_new += 1
                    if consecutive_no_new >= MAX_CONSECUTIVE_NO_NEW:
                        print(f"\n[*] {MAX_CONSECUTIVE_NO_NEW} iterations with no new profiles - stopping")
                        break
                else:
                    consecutive_no_new = 0

                # Check max_profiles limit
                if self.max_profiles and len(self.all_people) >= self.max_profiles:
                    print(f"\n[+] Reached max profiles limit ({self.max_profiles})")
                    break
                
                # Safety check: if we have more than expected, something's wrong
                if total_members > 0 and len(self.all_people) >= total_members:
                    print(f"\n[+] Reached expected member count ({total_members})")
                    break
                
                # Progress update every 5 iterations
                if iteration % 5 == 0:
                    progress = f"{len(self.all_people)}/{total_members}" if total_members > 0 else str(len(self.all_people))
                    print(f"    [*] Progress: {progress} profiles collected")
        
        print("\n" + "=" * 70)
        print("SCRAPING COMPLETE")
        print("=" * 70)
        print(f"[+] Total unique profiles scraped: {len(self.all_people)}")
        if total_members > 0:
            coverage = (len(self.all_people) / total_members) * 100
            print(f"[+] Coverage: {coverage:.1f}% of {total_members} associated members")

    def save_to_csv(self) -> str:
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        filename = f"linkedin_company_{self.company_name}_{timestamp}.csv"
        filepath = os.path.join(self.output_dir, filename)

        fieldnames = ["name", "title", "profile_url", "profile_image_url", "connection_degree", "mutual_connections", "action_state"]

        with open(filepath, "w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=fieldnames, extrasaction="ignore")
            writer.writeheader()

            sorted_people = sorted(
                self.all_people.values(),
                key=lambda x: x.get("name", "").lower()
            )

            for person in sorted_people:
                writer.writerow({
                    "name": person.get("name", ""),
                    "title": person.get("title", ""),
                    "profile_url": person.get("profileUrl", ""),
                    "profile_image_url": person.get("profileImageUrl", ""),
                    "connection_degree": person.get("connectionDegree", ""),
                    "mutual_connections": person.get("mutualConnections", ""),
                    "action_state": person.get("actionState", "")
                })

        print(f"[+] Saved {len(self.all_people)} profiles to: {filepath}")
        return filepath

    def get_company_display_name(self) -> str:
        """Extract the real company display name from the LinkedIn page.

        Tries several strategies:
          1. H1 tag on the company page
          2. <title> element (stripped of ' | LinkedIn')
          3. Falls back to the URL-derived slug
        """
        if not self.driver:
            return self.company_name.replace('-', ' ').title()
        try:
            name = self.driver.execute_script("""
                // Strategy 1: The h1 on the company/people page
                const h1 = document.querySelector('h1');
                if (h1) {
                    const text = h1.textContent.trim();
                    if (text.length > 1 && text.length < 120) return text;
                }
                // Strategy 2: document.title minus LinkedIn suffix
                let t = document.title || '';
                t = t.replace(/\\s*[|·–—-]\\s*LinkedIn.*$/i, '').trim();
                // Remove leading "People" prefix if present
                t = t.replace(/^People\\s*[|·–—-]\\s*/i, '').trim();
                if (t.length > 1 && t.length < 120) return t;
                return '';
            """)
            if name:
                return name
        except Exception:
            pass
        return self.company_name.replace('-', ' ').title()

    def download_profile_images(self, driver=None) -> str:
        """Download profile images locally so the HTML chart works offline.

        Uses the authenticated browser session to fetch LinkedIn CDN images
        before the browser is closed. Rewrites profileImageUrl to local paths.

        Returns the images directory path.
        """
        browser = driver or self.driver
        if not browser:
            print("[!] No browser session available, skipping image download")
            return ""

        images_dir = os.path.join(self.output_dir, "images")
        os.makedirs(images_dir, exist_ok=True)

        people_with_images = [
            (k, v) for k, v in self.all_people.items()
            if v.get("profileImageUrl")
            and v["profileImageUrl"].startswith("http")
        ]

        if not people_with_images:
            print("[*] No profile images to download")
            return images_dir

        print(f"[*] Downloading {len(people_with_images)} profile images...")
        downloaded = 0
        failed = 0

        for idx, (key, person) in enumerate(people_with_images):
            url = person["profileImageUrl"]
            # Sanitize filename from person name
            safe_name = re.sub(r'[^\w\-]', '_', person.get("name", f"person_{idx}").strip())
            safe_name = safe_name[:80]  # limit length
            filename = f"{safe_name}.jpg"
            filepath = os.path.join(images_dir, filename)

            try:
                # Use the browser's fetch API to download with session cookies
                result = browser.execute_async_script("""
                    const [url, callback] = [arguments[0], arguments[arguments.length - 1]];
                    fetch(url, {credentials: 'include'})
                        .then(r => r.blob())
                        .then(blob => {
                            const reader = new FileReader();
                            reader.onloadend = () => callback({ok: true, data: reader.result});
                            reader.readAsDataURL(blob);
                        })
                        .catch(e => callback({ok: false, error: e.message}));
                """, url)

                if result and result.get("ok") and result.get("data"):
                    # data is a base64 data URL: "data:image/jpeg;base64,..."
                    import base64
                    data_url = result["data"]
                    if "," in data_url:
                        b64_data = data_url.split(",", 1)[1]
                        with open(filepath, "wb") as f:
                            f.write(base64.b64decode(b64_data))
                        # Rewrite URL to relative local path
                        person["profileImageUrl"] = f"images/{filename}"
                        downloaded += 1
                    else:
                        failed += 1
                else:
                    failed += 1
            except Exception as e:
                failed += 1
                if idx == 0:
                    # Only log first failure to avoid spam
                    logger.debug(f"Image download failed for {person.get('name', '?')}: {e}")

            # Progress every 10
            if (idx + 1) % 10 == 0:
                print(f"    [{idx + 1}/{len(people_with_images)}] downloaded: {downloaded}, failed: {failed}")

        print(f"[+] Images: {downloaded} downloaded, {failed} failed -> {images_dir}")
        return images_dir

    def print_statistics(self):
        print("\n" + "=" * 70)
        print("STATISTICS")
        print("=" * 70)

        # Connection degree breakdown
        degrees = {}
        actions = {}
        with_images = 0

        for person in self.all_people.values():
            degree = person.get("connectionDegree", "Unknown") or "Unknown"
            degrees[degree] = degrees.get(degree, 0) + 1

            action = person.get("actionState", "Unknown") or "Unknown"
            actions[action] = actions.get(action, 0) + 1

            if person.get("profileImageUrl"):
                with_images += 1

        print("Connection Degrees:")
        for degree, count in sorted(degrees.items()):
            print(f"  {degree}: {count}")

        print("\nAction States:")
        for action, count in sorted(actions.items()):
            print(f"  {action}: {count}")

        print(f"\nProfile Images: {with_images}/{len(self.all_people)} ({100*with_images/len(self.all_people) if self.all_people else 0:.1f}%)")
        print(f"Total Profiles: {len(self.all_people)}")


# ============================================================================
# CLI ARGUMENT PARSING
# ============================================================================

def parse_arguments():
    parser = argparse.ArgumentParser(
        description="Scrape all people from a LinkedIn company page",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
    python osint_scrape_company.py acme-corp
    python osint_scrape_company.py example-org -o output
    python osint_scrape_company.py https://www.linkedin.com/company/acme-corp/people/
    python osint_scrape_company.py acme-corp -e email@example.com -p password
        """
    )
    parser.add_argument(
        "url",
        help="Company name or LinkedIn company URL (e.g., 'acme-corp' or 'https://www.linkedin.com/company/acme-corp/people/')"
    )
    parser.add_argument(
        "-o", "--output",
        default=OUTPUT_DIR,
        help=f"Output directory for CSV files (default: {OUTPUT_DIR})"
    )
    parser.add_argument("-e", "--email", help="LinkedIn email for login")
    parser.add_argument("-p", "--password", help="LinkedIn password for login")
    parser.add_argument("--max-pages", type=int, default=None,
                        help="Maximum number of 'Show more' pages to load (default: unlimited)")
    parser.add_argument("--max-profiles", type=int, default=None,
                        help="Maximum number of profiles to collect (default: unlimited)")
    parser.add_argument("--proxy", default=None, help="Proxy URL (e.g., socks5://host:port)")
    parser.add_argument("-v", "--verbose", action="store_true", help="Enable verbose/debug logging")
    return parser.parse_args()


# ============================================================================
# MAIN
# ============================================================================

def main():
    args = parse_arguments()
    setup_logging(verbose=args.verbose)

    # Load .env for credentials and API keys
    from dotenv import load_dotenv
    load_dotenv()

    # Resolve credentials: CLI flags take priority, then .env
    email = args.email or os.environ.get("LINKEDIN_EMAIL")
    password = args.password or os.environ.get("LINKEDIN_PASSWORD")

    # Normalize input (accept both short names and full URLs)
    normalized_url = normalize_input(args.url)

    print("=" * 70)
    print("LINKEDIN COMPANY PEOPLE SCRAPER")
    print("=" * 70)
    print(f"Input: {args.url}")
    print(f"Normalized URL: {normalized_url}")
    print(f"Output Dir: {args.output}")
    print("=" * 70)

    screen_lock_preventer = ScreenLockPreventer()
    screen_lock_preventer.start()

    scraper = LinkedInCompanyPeopleScraper(
        normalized_url, args.output,
        email=email, password=password,
        max_pages=args.max_pages, max_profiles=args.max_profiles,
        proxy_url=getattr(args, 'proxy', None),
    )
    
    try:
        scraper.start_browser()

        # Login if credentials provided
        if email and password:
            if not login_to_linkedin(scraper.driver, email, password):
                print("[-] Login failed. Exiting.")
                sys.exit(1)
        
        if not scraper.navigate_to_company_people():
            print("[-] Failed to navigate to company page")
            sys.exit(1)
        
        scraper.scrape_all_people()
        
        if scraper.all_people:
            csv_file = scraper.save_to_csv()
            scraper.print_statistics()
            
            print("\n" + "=" * 70)
            print("FINAL RESULTS")
            print("=" * 70)
            print(f"Total profiles scraped: {len(scraper.all_people)}")
            print(f"Output file: {csv_file}")
        else:
            print("\n[-] No profiles were scraped")
    
    except KeyboardInterrupt:
        print("\n\n[!] Interrupted by user")
        if scraper.all_people:
            print("[*] Saving partial results...")
            scraper.save_to_csv()
            scraper.print_statistics()
    
    except Exception as e:
        print(f"\n[-] Error: {e}")
        import traceback
        traceback.print_exc()
        if scraper.all_people:
            print("[*] Saving partial results...")
            scraper.save_to_csv()
    
    finally:
        scraper.close_browser()
        screen_lock_preventer.stop()


if __name__ == "__main__":
    main()
