import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Integration test for the `LINKEDIN_HTTP=extension` request proxy: the CLI
 * side queues requests on a localhost poll-proxy, an "extension" (played by
 * this test over plain fetch) picks them up and posts responses back.
 *
 * PROXY_PORT is read from the environment at import time, so the env var is
 * set BEFORE dynamically importing the transport — on an isolated port (9788),
 * never the default 8788 the operator's real bridge may already be using.
 * The tests call `extensionRequest` directly: vitest threads share
 * `process.env`, and another test file's `delete process.env.LINKEDIN_HTTP`
 * could otherwise reroute `httpRequest` to plain fetch mid-test.
 */
const PORT = 9788;
const BASE = `http://127.0.0.1:${PORT}`;

process.env.LINKEDIN_EXTENSION_PROXY_PORT = String(PORT);
// Fail fast on a disconnected bridge instead of waiting 35s for a ping.
process.env.LINKEDIN_EXTENSION_CONNECT_TIMEOUT_MS = '0';
const transport = await import('../src/core/transport.js');

/** Wait until the proxy server (started lazily by the first request) binds. */
async function waitForProxy(): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/ping`, { method: 'POST' });
      if (res.status === 200) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('extension proxy did not start listening');
}

/** Poll GET /next-request until the proxy hands out a queued request. */
async function pollNextRequest(): Promise<any> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const res = await fetch(`${BASE}/next-request`);
    if (res.status === 200) return await res.json();
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('no request became available at /next-request');
}

/** Deliver a response back to the proxy (requestId travels in the body). */
async function postResponse(body: unknown): Promise<void> {
  const res = await fetch(`${BASE}/response/x`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
}

beforeAll(async () => {
  // The very first call boots the proxy server but must refuse to send
  // anything until the extension has pinged.
  await expect(
    transport.extensionRequest('https://www.linkedin.com/voyager/api/me', {
      method: 'GET',
      headers: { accept: 'application/json' },
    }),
  ).rejects.toThrow(/Extension not connected/);

  await waitForProxy();
});

afterAll(() => {
  delete process.env.LINKEDIN_EXTENSION_PROXY_PORT;
});

describe('extension proxy transport', () => {
  it('reports connected after a ping', () => {
    expect(transport.isExtensionConnected()).toBe(true);
  });

  it('round-trips a request through the proxying extension', async () => {
    const pending = transport.extensionRequest('https://www.linkedin.com/voyager/api/me', {
      method: 'GET',
      headers: { accept: 'application/json' },
    });

    const sent = await pollNextRequest();
    expect(sent.requestId).toBeTruthy();
    expect(sent.url).toBe('https://www.linkedin.com/voyager/api/me');
    expect(sent.method).toBe('GET');
    expect(sent.headers['accept']).toBe('application/json');

    await postResponse({
      requestId: sent.requestId,
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'application/json' },
      body: '{"firstName":"Ada"}',
    });

    const res = await pending;
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(await res.text()).toBe('{"firstName":"Ada"}');
  });

  it('rejects when the extension reports an error', async () => {
    const pending = transport.extensionRequest('https://www.linkedin.com/voyager/api/fail', {
      method: 'GET',
      headers: {},
    });
    // The rejection is delivered server-side while the response POST is still
    // in flight — attach a handler up front so it cannot surface as an
    // unhandled rejection before the assertion below runs.
    pending.catch(() => {});
    const sent = await pollNextRequest();

    await postResponse({
      requestId: sent.requestId,
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      headers: {},
      body: '',
      error: 'boom from the extension',
    });

    await expect(pending).rejects.toThrow('boom from the extension');
  });

  it('rejects a non-ok extension response with the HTTP status', async () => {
    const pending = transport.extensionRequest('https://www.linkedin.com/voyager/api/missing', {
      method: 'GET',
      headers: {},
    });
    pending.catch(() => {}); // see note above — avoid an unhandled-rejection window
    const sent = await pollNextRequest();

    await postResponse({
      requestId: sent.requestId,
      ok: false,
      status: 404,
      statusText: 'Not Found',
      headers: {},
      body: '',
    });

    await expect(pending).rejects.toThrow('HTTP 404');
  });

  it('rejects on abort', async () => {
    const controller = new AbortController();
    const pending = transport.extensionRequest('https://www.linkedin.com/voyager/api/slow', {
      method: 'GET',
      headers: {},
      signal: controller.signal,
    });
    pending.catch(() => {}); // see note above — avoid an unhandled-rejection window

    const sent = await pollNextRequest();
    expect(sent.url).toContain('/api/slow');

    controller.abort();
    await expect(pending).rejects.toThrow('Request aborted');
  });
});