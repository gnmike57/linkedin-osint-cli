#!/usr/bin/env python3
"""
LinkedIn Login & Session Module (Shared)
=========================================

Provides unified login, session validation, navigation retry, and URL
normalization utilities used by all scrapers in this toolkit.

Functions:
    normalize_input(input_str)      - Normalize company name/URL to people page URL
    create_browser(**kwargs)        - Create a Firefox WebDriver with profile
    check_session(driver)           - Check if LinkedIn session is still active
    login_to_linkedin(driver, email, password) - Full login with Welcome Back + OTP
    ensure_logged_in(driver, email, password)  - Check session, re-auth if needed
    navigate_with_retry(driver, url, ...) - Navigate with exponential backoff
    kill_stale_browsers()           - Kill orphaned geckodriver/firefox processes
    setup_logging(verbose, log_file) - Configure logging for the toolkit

Note:
    Session persistence relies on the Firefox profile (via -profile flag) or
    keeping a single browser instance alive across steps (as the E2E test
    runner does).  There is no cross-process cookie export/import.

CLI Usage:
    python src/osint_auth.py your@email.com yourpassword
"""

import os
import sys
import time
import random
import shutil
import subprocess
import logging

from selenium import webdriver
from selenium.webdriver.firefox.service import Service
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.common.exceptions import TimeoutException, WebDriverException
from webdriver_manager.firefox import GeckoDriverManager

# Anti-detection & stealth
from osint_stealth import (
    apply_stealth_preferences,
    apply_stealth_js,
    get_random_viewport,
    human_delay,
    human_type,
    random_scroll,
    apply_proxy,
)


# ============================================================================
# LOGGING
# ============================================================================

logger = logging.getLogger("linkedin_osint")


def setup_logging(verbose=False, log_file=None):
    """
    Configure logging for the toolkit.

    Args:
        verbose: If True, set DEBUG level; otherwise INFO.
        log_file: Optional path to a log file.
    """
    level = logging.DEBUG if verbose else logging.INFO
    fmt = "[%(levelname)s] %(message)s"

    handlers = [logging.StreamHandler(sys.stdout)]
    if log_file:
        os.makedirs(os.path.dirname(log_file) or ".", exist_ok=True)
        handlers.append(logging.FileHandler(log_file, encoding="utf-8"))

    logging.basicConfig(level=level, format=fmt, handlers=handlers, force=True)


# Ensure a default handler exists so messages are never lost
if not logger.handlers and not logging.root.handlers:
    setup_logging()


# ============================================================================
# CONFIGURATION
# ============================================================================

def find_firefox_profile():
    """
    Auto-detect the user's Firefox profile directory.

    Checks (in order):
        1. Native Firefox: ~/.mozilla/firefox/<hash>.default-esr / .default-release / .default
        2. Snap Firefox:   ~/snap/firefox/common/.mozilla/firefox/<hash>.default*
        3. Flatpak:        ~/.var/app/org.mozilla.firefox/.mozilla/firefox/<hash>.default*
    """
    search_dirs = [
        os.path.expanduser("~/.mozilla/firefox"),
        os.path.expanduser("~/snap/firefox/common/.mozilla/firefox"),
        os.path.expanduser("~/.var/app/org.mozilla.firefox/.mozilla/firefox"),
    ]
    for firefox_dir in search_dirs:
        if not os.path.isdir(firefox_dir):
            continue
        for suffix in ('.default-esr', '.default-release', '.default'):
            for entry in os.listdir(firefox_dir):
                if entry.endswith(suffix):
                    path = os.path.join(firefox_dir, entry)
                    if os.path.isdir(path):
                        return path
    return None

FIREFOX_PROFILE_PATH = find_firefox_profile()
DEFAULT_PAGE_LOAD_TIMEOUT = 60



# ============================================================================
# URL NORMALIZATION
# ============================================================================

def normalize_input(input_str: str) -> str:
    """
    Accept company name OR full URL, return normalized URL ending in /people.

    Examples:
        "acme-corp" -> "https://www.linkedin.com/company/acme-corp/people"
        "example-org" -> "https://www.linkedin.com/company/example-org/people"
        "https://linkedin.com/company/acme-corp" -> "https://linkedin.com/company/acme-corp/people"
    """
    input_str = input_str.strip()

    # Already a full URL
    if input_str.startswith('http'):
        url = input_str
    else:
        # Short name - expand to full URL
        company_name = input_str.strip('/')
        url = f"https://www.linkedin.com/company/{company_name}"

    # Ensure /people suffix
    url = url.rstrip('/')
    if not url.endswith('/people'):
        url = url + '/people'

    return url


# ============================================================================
# PROCESS CLEANUP
# ============================================================================

def kill_stale_browsers():
    """
    Kill orphaned geckodriver and zombie Firefox processes.

    This prevents the 'Text file busy' OSError that occurs when
    webdriver-manager tries to overwrite a geckodriver binary that
    is still being executed by a stale process.

    Returns:
        int: Number of process groups killed
    """
    killed = 0
    for pattern in ["geckodriver", r"firefox.*-marionette"]:
        try:
            result = subprocess.run(
                ["pkill", "-f", pattern],
                capture_output=True, timeout=5
            )
            if result.returncode == 0:
                killed += 1
                logger.info("Killed stale processes matching '%s'", pattern)
        except Exception:
            pass

    # Also reap zombie (defunct) firefox processes
    try:
        subprocess.run(
            ["pkill", "-9", "-f", r"firefox.*defunct"],
            capture_output=True, timeout=5
        )
    except Exception:
        pass

    if killed:
        # Give the OS a moment to release file locks
        time.sleep(1)

    return killed


def _find_cached_geckodriver():
    """
    Find a cached geckodriver binary in the webdriver-manager cache.

    Returns:
        str or None: Path to the geckodriver binary, or None if not found.
    """
    wdm_dir = os.path.join(os.path.expanduser("~"), ".wdm", "drivers", "geckodriver")
    if not os.path.isdir(wdm_dir):
        return None

    # Walk the cache looking for the geckodriver binary
    for root, dirs, files in os.walk(wdm_dir):
        if "geckodriver" in files:
            path = os.path.join(root, "geckodriver")
            if os.access(path, os.X_OK):
                return path

    return None


def _get_geckodriver_path():
    """
    Get a working geckodriver path with multiple fallback strategies.

    Strategy order:
        1. Use cached geckodriver if it exists and is valid
        2. Use GeckoDriverManager().install() (downloads if needed)
        3. If 'Text file busy', kill stale processes and retry
        4. Fall back to system-installed geckodriver

    Returns:
        str: Path to a working geckodriver binary

    Raises:
        RuntimeError: If no geckodriver could be found or made available
    """
    # Strategy 1: Try the cached binary first (avoids re-download entirely)
    cached = _find_cached_geckodriver()
    if cached:
        logger.debug("Using cached geckodriver: %s", cached)
        return cached

    # Strategy 2: Normal webdriver-manager install
    try:
        path = GeckoDriverManager().install()
        logger.debug("webdriver-manager installed geckodriver: %s", path)
        return path
    except OSError as e:
        if "Text file busy" in str(e) or getattr(e, "errno", None) == 26:
            logger.warning(
                "geckodriver binary is locked by a stale process. "
                "Attempting cleanup..."
            )

            # Strategy 3: Kill stale processes and retry
            kill_stale_browsers()
            try:
                path = GeckoDriverManager().install()
                logger.debug("webdriver-manager installed geckodriver (after cleanup): %s", path)
                return path
            except OSError:
                # Still locked -- try the cached binary anyway
                cached = _find_cached_geckodriver()
                if cached:
                    logger.warning("Using cached geckodriver despite lock: %s", cached)
                    return cached
        else:
            logger.error("webdriver-manager error: %s", e)
    except Exception as e:
        logger.error("webdriver-manager error: %s", e)

    # Strategy 4: Fall back to system-installed geckodriver
    system_geckodriver = shutil.which("geckodriver")
    if system_geckodriver:
        logger.info("Using system geckodriver: %s", system_geckodriver)
        return system_geckodriver

    raise RuntimeError(
        "Could not find or install geckodriver.\n"
        "  Possible fixes:\n"
        "  1. Kill stale processes: pkill geckodriver && pkill -9 -f 'firefox.*defunct'\n"
        "  2. Install geckodriver for your distro:\n"
        "       Debian/Kali/Ubuntu: sudo apt install firefox-geckodriver\n"
        "       Fedora:             sudo dnf install geckodriver\n"
        "       Arch:               sudo pacman -S geckodriver\n"
        "  3. Delete cache and retry: rm -rf ~/.wdm/drivers/geckodriver"
    )


# ============================================================================
# BROWSER CREATION
# ============================================================================

def create_browser(profile_path=None, page_load_timeout=None, headless=False,
                   proxy_url=None):
    """
    Create a Firefox WebDriver using the saved Firefox profile for session reuse.

    Includes resilient geckodriver resolution with automatic stale-process
    cleanup and multiple fallback strategies.  Applies anti-detection stealth
    settings (UA rotation, viewport randomization, WebDriver hiding, telemetry
    disabling) automatically.

    Args:
        profile_path: Path to Firefox profile. Defaults to FIREFOX_PROFILE_PATH.
        page_load_timeout: Page load timeout in seconds. Defaults to 60.
        headless: Run in headless mode.
        proxy_url: Optional proxy URL (e.g., 'socks5://host:port').

    Returns:
        selenium.webdriver.Firefox instance

    Raises:
        RuntimeError: If the browser could not be started after all retries.
    """
    profile_path = profile_path or FIREFOX_PROFILE_PATH
    page_load_timeout = page_load_timeout or DEFAULT_PAGE_LOAD_TIMEOUT

    options = Options()
    # Cookie and notification settings
    options.set_preference("dom.webnotifications.enabled", False)
    options.set_preference("network.cookie.cookieBehavior", 0)

    # Suppress sidebar / history panel that may be open in the user's profile
    options.set_preference("sidebar.visibility", "")
    options.set_preference("sidebar.revamp", False)
    options.set_preference("sidebar.verticalTabs", False)
    options.set_preference("browser.startup.homepage_override.mstone", "ignore")
    options.set_preference("browser.tabs.warnOnClose", False)
    options.set_preference("browser.shell.checkDefaultBrowser", False)
    options.set_preference("browser.sessionstore.resume_from_crash", False)
    options.set_preference("toolkit.legacyUserProfileCustomizations.stylesheets", False)

    # --- Anti-detection stealth preferences ---
    apply_stealth_preferences(options)

    # --- Proxy support ---
    if proxy_url:
        apply_proxy(options, proxy_url)

    if headless:
        options.add_argument("--headless")

    if profile_path and os.path.exists(profile_path):
        # Use -profile to tell Firefox to use this profile directory directly
        # (faster than options.profile which copies the entire profile).
        options.add_argument("-profile")
        options.add_argument(profile_path)
        logger.info("Using Firefox profile: %s", profile_path)
    else:
        logger.warning("No Firefox profile found. Browser will start with a fresh profile.")

    # Resolve geckodriver with resilient fallback chain
    try:
        geckodriver_path = _get_geckodriver_path()
    except RuntimeError as e:
        logger.error(str(e))
        raise

    service = Service(geckodriver_path)

    try:
        driver = webdriver.Firefox(service=service, options=options)
    except WebDriverException as e:
        # If Firefox fails to start (e.g. profile lock), try once more after cleanup
        logger.warning("Firefox failed to start: %s", e)
        logger.info("Killing stale browser processes and retrying...")
        kill_stale_browsers()
        time.sleep(2)

        try:
            service = Service(geckodriver_path)
            driver = webdriver.Firefox(service=service, options=options)
        except Exception as retry_err:
            raise RuntimeError(
                f"Browser startup failed after retry: {retry_err}\n"
                "  Fix: Run 'pkill geckodriver && pkill -f firefox' and try again."
            ) from retry_err

    driver.set_page_load_timeout(page_load_timeout)

    # --- Set random viewport (avoids full-screen fingerprinting) ---
    try:
        vp_w, vp_h = get_random_viewport()
        driver.set_window_size(vp_w, vp_h)
        # Position window slightly off-origin (humans don't always start at 0,0)
        import random as _rnd
        driver.set_window_position(_rnd.randint(10, 80), _rnd.randint(10, 60))
        logger.debug("Viewport: %dx%d", vp_w, vp_h)
    except Exception as e:
        logger.debug("Could not set viewport (non-fatal): %s", e)

    # --- Inject stealth JavaScript patches ---
    try:
        driver.get("about:blank")
        apply_stealth_js(driver)
    except Exception:
        pass

    return driver


# ============================================================================
# SESSION MANAGEMENT
# ============================================================================

def check_session(driver):
    """
    Check if the current LinkedIn session is still valid.

    Navigates to the feed page and checks if we get redirected to login.

    Args:
        driver: Selenium WebDriver instance

    Returns:
        True if logged in, False otherwise
    """
    try:
        driver.get("https://www.linkedin.com/feed/")
        time.sleep(3)
        current = driver.current_url
        if '/feed' in current or '/mynetwork' in current:
            return True
        return False
    except Exception as e:
        logger.warning("Session check error: %s", e)
        return False


def login_to_linkedin(driver, email, password):
    """
    Full LinkedIn login with Welcome Back page handling and OTP support.

    Handles:
    - Already-logged-in detection
    - "Welcome Back" page -> clicks "Sign in using another account"
    - Credential entry (email + password)
    - OTP / Challenge verification wait (2 minutes)

    Args:
        driver: Selenium WebDriver instance
        email: LinkedIn email address
        password: LinkedIn password

    Returns:
        True if login succeeded, False otherwise
    """
    logger.info("Checking LinkedIn login status...")

    # Check if already logged in via Firefox profile
    try:
        driver.get("https://www.linkedin.com/feed/")
        apply_stealth_js(driver)
        human_delay(2.0, 4.0)

        current = driver.current_url
        if '/feed' in current or '/mynetwork' in current:
            logger.info("Already logged in!")
            return True
    except Exception:
        pass

    # Not logged in, go to login page
    logger.info("Not logged in, proceeding to login...")
    driver.get("https://www.linkedin.com/login")
    apply_stealth_js(driver)
    human_delay(3.0, 6.0)

    try:
        # ------------------------------------------------------------------
        # Handle "Welcome Back" page
        # ------------------------------------------------------------------
        try:
            page_source = driver.page_source.lower()
            if 'welcome back' in page_source or 'welcome-back' in page_source:
                logger.info("Detected 'Welcome back' page, clicking 'Sign in using another account'...")
                switch_selectors = [
                    "//a[contains(text(), 'Sign in using another account')]",
                    "//button[contains(text(), 'Sign in using another account')]",
                    "//a[contains(text(), 'another account')]",
                    "//button[contains(text(), 'another account')]",
                    "//a[contains(@class, 'alternate')]",
                    "//a[contains(@href, '/login')]",
                ]
                clicked = False
                for selector in switch_selectors:
                    try:
                        switch_link = driver.find_element(By.XPATH, selector)
                        switch_link.click()
                        time.sleep(3)
                        logger.info("Clicked 'Sign in using another account'")
                        clicked = True
                        break
                    except Exception:
                        continue

                if not clicked:
                    # Fallback: navigate directly to login page
                    logger.info("Could not click switch link, navigating to login page directly...")
                    driver.get("https://www.linkedin.com/login")
                    time.sleep(3)
        except Exception as e:
            logger.debug("No 'Welcome back' page detected: %s", e)

        # ------------------------------------------------------------------
        # Enter credentials
        # ------------------------------------------------------------------
        email_field = WebDriverWait(driver, 15).until(
            EC.presence_of_element_located((By.ID, "username"))
        )
        email_field.clear()
        human_type(email_field, email)
        logger.info("Email entered")

        # Natural pause between fields (as if tabbing / moving mouse)
        human_delay(0.8, 2.0)

        password_field = driver.find_element(By.ID, "password")
        password_field.clear()
        human_type(password_field, password)
        logger.info("Password entered")

        # Brief pause before clicking (as if double-checking)
        human_delay(0.5, 1.5)

        # Click login button
        login_btn = driver.find_element(By.CSS_SELECTOR, "button[type='submit']")
        login_btn.click()
        logger.info("Sign in clicked")

        # ------------------------------------------------------------------
        # Wait for OTP / Challenge verification (2 minutes)
        # ------------------------------------------------------------------
        print("\n" + "=" * 50)
        print("WAITING FOR OTP VERIFICATION")
        print("=" * 50)
        print("Please approve the login on your phone app.")
        print("=" * 50 + "\n")

        for i in range(60):  # 60 iterations x 2s = 120s = 2 minutes
            current = driver.current_url
            if '/feed' in current or '/mynetwork' in current or '/company' in current:
                logger.info("LOGIN SUCCESSFUL!")
                time.sleep(2)
                return True

            if '/checkpoint' in current or '/challenge' in current:
                if i % 10 == 0:
                    remaining = 120 - (i * 2)
                    logger.info("Approve OTP on your phone... (%ds remaining)", remaining)

            time.sleep(2)

        # Final check
        current = driver.current_url
        if '/feed' in current or '/mynetwork' in current:
            logger.info("Login successful!")
            return True

        logger.error("Login timeout - please try again")
        return False

    except Exception as e:
        logger.error("Login error: %s", e)
        return False


def ensure_logged_in(driver, email=None, password=None):
    """
    Check session validity and re-authenticate if needed.

    If email/password are not provided and session is expired, returns False.

    Args:
        driver: Selenium WebDriver instance
        email: LinkedIn email (optional)
        password: LinkedIn password (optional)

    Returns:
        True if session is valid (or was successfully restored), False otherwise
    """
    if check_session(driver):
        return True

    if email and password:
        logger.info("Session expired, re-authenticating...")
        return login_to_linkedin(driver, email, password)

    logger.error("Session expired and no credentials provided for re-authentication")
    return False


# ============================================================================
# NAVIGATION WITH RETRY
# ============================================================================

def navigate_with_retry(driver, url, max_retries=3, base_delay=5, email=None, password=None):
    """
    Navigate to a URL with exponential backoff retry and auth redirect handling.

    On each failure or auth redirect, waits with exponential backoff before
    retrying. If an auth redirect is detected and credentials are available,
    attempts to re-authenticate.

    Args:
        driver: Selenium WebDriver instance
        url: URL to navigate to
        max_retries: Maximum number of retry attempts (default: 3)
        base_delay: Base delay in seconds for exponential backoff (default: 5)
        email: LinkedIn email for re-auth on auth redirects (optional)
        password: LinkedIn password for re-auth on auth redirects (optional)

    Returns:
        True if navigation succeeded (no auth wall), False otherwise
    """
    for attempt in range(max_retries + 1):
        try:
            driver.get(url)
            human_delay(2.0, 4.5)

            current = driver.current_url

            # Check for auth redirects
            if '/login' in current or '/authwall' in current:
                if email and password:
                    logger.warning(
                        "Auth redirect detected (attempt %d/%d), re-authenticating...",
                        attempt + 1, max_retries + 1
                    )
                    if login_to_linkedin(driver, email, password):
                        # Retry navigation after re-auth
                        driver.get(url)
                        time.sleep(random.uniform(2, 4))
                        current = driver.current_url
                        if '/login' not in current and '/authwall' not in current:
                            apply_stealth_js(driver)
                            return True
                else:
                    logger.warning("Auth redirect detected, no credentials available")

                if attempt < max_retries:
                    delay = base_delay * (2 ** attempt) + random.uniform(0, 2)
                    logger.info(
                        "Retrying in %ds (attempt %d/%d)...",
                        delay, attempt + 1, max_retries + 1
                    )
                    time.sleep(delay)
                    continue
                return False

            # Navigation succeeded -- re-apply stealth JS patches
            apply_stealth_js(driver)
            return True

        except TimeoutException:
            logger.warning("Page load timeout (attempt %d/%d)", attempt + 1, max_retries + 1)
        except WebDriverException as e:
            logger.warning("Navigation error (attempt %d/%d): %s", attempt + 1, max_retries + 1, e)
        except Exception as e:
            logger.error("Unexpected error (attempt %d/%d): %s", attempt + 1, max_retries + 1, e)

        if attempt < max_retries:
            delay = base_delay * (2 ** attempt) + random.uniform(0, 2)
            logger.info("Retrying in %ds...", delay)
            time.sleep(delay)

    logger.error("Navigation failed after %d attempts", max_retries + 1)
    return False


# ============================================================================
# CLI ENTRY POINT
# ============================================================================

if __name__ == "__main__":
    setup_logging(verbose=("--verbose" in sys.argv or "-v" in sys.argv))

    # Filter out flags from argv
    args = [a for a in sys.argv[1:] if not a.startswith("-")]

    email = args[0] if len(args) > 0 else os.environ.get("LINKEDIN_EMAIL") or input("Email: ")
    password = args[1] if len(args) > 1 else os.environ.get("LINKEDIN_PASSWORD") or input("Password: ")

    driver = create_browser()
    success = False

    try:
        success = login_to_linkedin(driver, email, password)
        if success:
            logger.info("Keeping browser open for 10 seconds...")
            time.sleep(10)
        else:
            logger.error("Login failed")
    finally:
        logger.info("Closing browser...")
        driver.quit()
        if success:
            logger.info("Done! Session saved to Firefox profile.")
