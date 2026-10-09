import { beforeEach } from 'vitest';

/**
 * Hermetic-test guard.
 *
 * A developer running on the local harness (see README / AGENTS.md) commonly
 * exports `LINKEDIN_HTTP=curl-impersonate` (plus the binary/target overrides)
 * so real Voyager traffic is routed through curl-impersonate instead of Node's
 * TLS-fingerprinted `fetch`. That ambient config must not leak into the unit
 * tests: it flips `useCurlImpersonate()` to `true`, which bypasses the
 * `globalThis.fetch` mocks used across the suite and sends the tests to the
 * real network.
 *
 * Clear the transport-selection env vars before every test so the transport
 * defaults to `fetch`; individual tests that exercise the curl path set them
 * explicitly (and clean up in their own `afterEach`).
 */
beforeEach(() => {
  delete process.env.LINKEDIN_HTTP;
  delete process.env.LINKEDIN_USE_CURL_IMPERSONATE;
  delete process.env.LINKEDIN_CURL_IMPERSONATE_BIN;
  delete process.env.LINKEDIN_CURL_IMPERSONATE_TARGET;
});
