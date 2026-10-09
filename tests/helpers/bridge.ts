/**
 * Test helper for the extension session bridge.
 *
 * `serveSessionFromExtension` binds asynchronously, so a fixed `sleep()` before
 * the first POST is inherently flaky on a loaded machine. Poll instead: retry
 * only on a connection error, so a successful POST is never duplicated.
 */
export async function postSession(
  port: number,
  body: unknown,
  attempts = 60,
): Promise<Response> {
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetch(`http://127.0.0.1:${port}/session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch {
      // Not listening yet.
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error(`bridge on 127.0.0.1:${port} never accepted a connection`);
}

/** Wait until the bridge has bound its port (any HTTP reply counts). */
export async function waitForPort(port: number, attempts = 60): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      await fetch(`http://127.0.0.1:${port}/`, { method: 'GET' });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error(`bridge on 127.0.0.1:${port} never started listening`);
}
