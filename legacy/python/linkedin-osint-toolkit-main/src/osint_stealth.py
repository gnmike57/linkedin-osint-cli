#!/usr/bin/env python3
"""
Anti-Detection & Stealth Module
================================

Centralized browser fingerprint evasion for all scrapers in this toolkit.
Designed around the principle of **consistency over randomization** -- a small
set of coherent, realistic browser personas rather than aggressive
randomization that creates impossible device combinations.

Capabilities:
    - Firefox preference hardening (hide WebDriver flags, disable telemetry)
    - Realistic User-Agent rotation (recent Firefox versions, matching platform)
    - Common viewport / window-size randomization (weighted distribution)
    - JavaScript patches to hide automation signals (navigator.webdriver, etc.)
    - Human-like timing (Gaussian-distributed delays, natural scroll patterns)
    - SOCKS5 / HTTP proxy support via Firefox preferences

Usage:
    from osint_stealth import (
        apply_stealth_preferences,
        apply_stealth_js,
        get_random_viewport,
        get_random_user_agent,
        human_delay,
        random_scroll,
        apply_proxy,
    )
"""

import time
import random
import logging
from dataclasses import dataclass
from urllib.parse import urlparse

logger = logging.getLogger("linkedin_osint")


# ============================================================================
# USER-AGENT ROTATION
# ============================================================================

# Recent Firefox versions on Linux (matching Kali/Debian).
# We only use Linux UAs because the TLS fingerprint and OS-level signals
# from Selenium on Linux would be inconsistent with a Windows/Mac UA.
_FIREFOX_VERSIONS = [
    "128.0",
    "129.0",
    "130.0",
    "131.0",
    "132.0",
    "133.0",
    "134.0",
]

# Weight recent versions more heavily (people update browsers)
_VERSION_WEIGHTS = [5, 8, 12, 15, 20, 22, 25]


def get_random_user_agent():
    """Return a realistic Firefox User-Agent string for Linux."""
    version = random.choices(_FIREFOX_VERSIONS, weights=_VERSION_WEIGHTS, k=1)[0]
    return (
        "Mozilla/5.0 (X11; Linux x86_64; rv:{ver}) "
        "Gecko/20100101 Firefox/{ver}"
    ).format(ver=version)


# ============================================================================
# VIEWPORT / WINDOW SIZE
# ============================================================================

# Common desktop resolutions with approximate market-share weights.
_VIEWPORTS = [
    ((1366, 768),  25),
    ((1920, 1080), 22),
    ((1536, 864),  12),
    ((1440, 900),  10),
    ((1280, 720),   8),
    ((1600, 900),   7),
    ((1280, 800),   5),
    ((1360, 768),   4),
    ((1280, 1024),  4),
    ((1680, 1050),  3),
]


def get_random_viewport():
    """Return a (width, height) tuple from common desktop resolutions.

    Uses weighted random selection favoring the most popular sizes.
    Adds small random offsets to avoid exact-match fingerprinting.
    """
    sizes, weights = zip(*_VIEWPORTS)
    base_w, base_h = random.choices(sizes, weights=weights, k=1)[0]
    w = base_w + random.randint(-8, 8)
    h = base_h + random.randint(-5, 5)
    return (w, h)


# ============================================================================
# FIREFOX PREFERENCE HARDENING
# ============================================================================

def apply_stealth_preferences(options):
    """Apply anti-detection Firefox preferences to a selenium Options object.

    Hides WebDriver flags, disables telemetry, sets a random UA and
    accept-language, and disables features that leak automation context.
    """
    # --- Hide automation signals ---
    options.set_preference("dom.webdriver.enabled", False)
    options.set_preference("useAutomationExtension", False)

    # --- User-Agent override ---
    ua = get_random_user_agent()
    options.set_preference("general.useragent.override", ua)
    logger.debug("Stealth UA: %s", ua)

    # --- Accept-Language (randomize order slightly) ---
    lang_pools = [
        "en-US,en;q=0.9",
        "en-US,en;q=0.8",
        "en-GB,en;q=0.9,en-US;q=0.8",
        "en-US,en;q=0.9,en-GB;q=0.8",
        "en,en-US;q=0.9",
    ]
    options.set_preference("intl.accept_languages", random.choice(lang_pools))

    # --- Disable telemetry and reporting ---
    options.set_preference("toolkit.telemetry.enabled", False)
    options.set_preference("toolkit.telemetry.unified", False)
    options.set_preference("toolkit.telemetry.archive.enabled", False)
    options.set_preference("datareporting.healthreport.uploadEnabled", False)
    options.set_preference("datareporting.policy.dataSubmissionEnabled", False)
    options.set_preference("app.shield.optoutstudies.enabled", False)

    # --- Disable WebRTC IP leak ---
    options.set_preference("media.peerconnection.enabled", False)

    # --- Do NOT enable resistFingerprinting (marks you as unusual) ---
    options.set_preference("privacy.resistFingerprinting", False)

    # --- Misc privacy / anti-detection ---
    options.set_preference("geo.enabled", False)
    options.set_preference("permissions.default.geo", 2)
    options.set_preference("media.navigator.enabled", False)
    options.set_preference("network.http.sendRefererHeader", 2)

    # Suppress "controlled by automation" infobar
    options.set_preference("marionette.preferences.recommended", False)


# ============================================================================
# JAVASCRIPT STEALTH PATCHES
# ============================================================================

_STEALTH_JS = """
(function() {
    // Hide navigator.webdriver
    try {
        Object.defineProperty(navigator, 'webdriver', {
            get: () => undefined,
            configurable: true
        });
    } catch(e) {}

    // Patch navigator.plugins to look non-empty
    try {
        if (navigator.plugins.length === 0) {
            Object.defineProperty(navigator, 'plugins', {
                get: () => [
                    {name: 'PDF Viewer', filename: 'internal-pdf-viewer',
                     description: 'Portable Document Format'},
                    {name: 'Chrome PDF Viewer', filename: 'internal-pdf-viewer',
                     description: ''},
                ],
                configurable: true
            });
        }
    } catch(e) {}

    // Patch navigator.languages to match accept-language
    try {
        Object.defineProperty(navigator, 'languages', {
            get: () => ['en-US', 'en'],
            configurable: true
        });
    } catch(e) {}

    // Remove Selenium-injected properties
    try {
        delete window.cdc_adoQpoasnfa76pfcZLmcfl_Array;
        delete window.cdc_adoQpoasnfa76pfcZLmcfl_Promise;
        delete window.cdc_adoQpoasnfa76pfcZLmcfl_Symbol;
    } catch(e) {}

    // Patch permissions API
    try {
        const origQuery = window.navigator.permissions.query;
        window.navigator.permissions.query = function(params) {
            if (params.name === 'notifications') {
                return Promise.resolve({state: Notification.permission});
            }
            return origQuery.call(this, params);
        };
    } catch(e) {}
})();
"""


def apply_stealth_js(driver):
    """Execute JavaScript patches to hide automation signals.

    Should be called after each page navigation to re-apply patches
    (they do not persist across page loads).
    """
    try:
        driver.execute_script(_STEALTH_JS)
    except Exception as e:
        logger.debug("Stealth JS injection failed (non-fatal): %s", e)


# ============================================================================
# HUMAN-LIKE TIMING
# ============================================================================

def human_delay(min_s=1.5, max_s=5.0, mean=None, sigma=None):
    """Sleep for a human-like duration using Gaussian distribution.

    Unlike uniform random, Gaussian produces delays clustered around a
    natural center point with occasional longer pauses -- closer to how
    humans actually behave.

    Returns:
        The actual delay used (in seconds).
    """
    if mean is None:
        mean = (min_s + max_s) / 2.0
    if sigma is None:
        sigma = (max_s - min_s) / 4.0

    delay = random.gauss(mean, sigma)
    delay = max(min_s, min(max_s, delay))
    time.sleep(delay)
    return delay


def human_type(element, text, min_char_delay=0.04, max_char_delay=0.18):
    """Type text into a Selenium element with human-like character delays.

    Simulates natural typing speed with occasional pauses (as if thinking)
    and slight speed variations per character.
    """
    for char in text:
        element.send_keys(char)
        if random.random() < 0.08:
            time.sleep(random.uniform(0.3, 0.7))
        else:
            time.sleep(random.uniform(min_char_delay, max_char_delay))


def random_scroll(driver, min_scrolls=2, max_scrolls=5):
    """Perform human-like scroll behavior on the current page.

    Scrolls down in variable increments with occasional scroll-ups,
    random pauses, and natural speed variation.
    """
    num_scrolls = random.randint(min_scrolls, max_scrolls)

    for _ in range(num_scrolls):
        if random.random() < 0.8:
            distance = random.randint(200, 600)
        else:
            distance = -random.randint(100, 300)

        try:
            driver.execute_script("window.scrollBy(0, %d);" % distance)
        except Exception:
            pass

        time.sleep(random.uniform(0.4, 1.8))

    time.sleep(random.uniform(0.5, 1.2))


# ============================================================================
# PROXY SUPPORT
# ============================================================================

@dataclass
class ProxyConfig:
    """Parsed proxy configuration."""
    scheme: str
    host: str
    port: int
    username: str = ""
    password: str = ""


def parse_proxy_url(proxy_url):
    """Parse a proxy URL string into a ProxyConfig.

    Supported formats:
        socks5://host:port
        socks5://user:pass@host:port
        http://host:port
    """
    parsed = urlparse(proxy_url)

    if parsed.scheme not in ('socks5', 'socks4', 'http', 'https'):
        raise ValueError(
            "Unsupported proxy scheme '%s'. Use socks5://, http://, or https://"
            % parsed.scheme
        )

    if not parsed.hostname or not parsed.port:
        raise ValueError(
            "Invalid proxy URL: %s. Expected scheme://[user:pass@]host:port"
            % proxy_url
        )

    return ProxyConfig(
        scheme=parsed.scheme,
        host=parsed.hostname,
        port=parsed.port,
        username=parsed.username or "",
        password=parsed.password or "",
    )


def apply_proxy(options, proxy_url):
    """Apply proxy settings to Firefox options.

    Args:
        options: selenium.webdriver.firefox.options.Options instance.
        proxy_url: Proxy URL (e.g., 'socks5://user:pass@host:port').
    """
    config = parse_proxy_url(proxy_url)

    if config.scheme in ('socks5', 'socks4'):
        options.set_preference("network.proxy.type", 1)
        options.set_preference("network.proxy.socks", config.host)
        options.set_preference("network.proxy.socks_port", config.port)
        socks_version = 5 if config.scheme == 'socks5' else 4
        options.set_preference("network.proxy.socks_version", socks_version)
        options.set_preference("network.proxy.socks_remote_dns", True)
        logger.info("Proxy: SOCKS%d via %s:%d", socks_version, config.host, config.port)
    else:
        options.set_preference("network.proxy.type", 1)
        options.set_preference("network.proxy.http", config.host)
        options.set_preference("network.proxy.http_port", config.port)
        options.set_preference("network.proxy.ssl", config.host)
        options.set_preference("network.proxy.ssl_port", config.port)
        options.set_preference("network.proxy.no_proxies_on", "localhost,127.0.0.1")
        logger.info("Proxy: HTTP(S) via %s:%d", config.host, config.port)

    if config.username:
        logger.info("Proxy: using authentication (user: %s)", config.username)


# ============================================================================
# SELF-TEST
# ============================================================================

if __name__ == "__main__":
    print("=" * 60)
    print("STEALTH MODULE - Self Test")
    print("=" * 60)

    print("\n--- User-Agent Pool ---")
    for _ in range(5):
        print("  %s" % get_random_user_agent())

    print("\n--- Viewport Pool ---")
    for _ in range(5):
        w, h = get_random_viewport()
        print("  %dx%d" % (w, h))

    print("\n--- Human Delay (5 samples) ---")
    for _ in range(5):
        d = human_delay(1.0, 4.0)
        print("  %.2fs" % d)

    print("\n--- Proxy Parsing ---")
    test_urls = [
        "socks5://127.0.0.1:9050",
        "socks5://user:pass@proxy.example.com:1080",
        "http://proxy.example.com:8080",
    ]
    for url in test_urls:
        cfg = parse_proxy_url(url)
        auth = "yes" if cfg.username else "no"
        print("  %s -> %s://%s:%d (auth: %s)" % (url, cfg.scheme, cfg.host, cfg.port, auth))

    print("\n[+] All tests passed")
