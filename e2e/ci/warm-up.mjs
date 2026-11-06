// Waits for `next dev`, then requests the routes the tests open so their first (slow) compile
// doesn't eat a test's timeout. Signs in first: signed out, most routes only redirect.
// Usage: node e2e/ci/warm-up.mjs (URL overrides http://localhost:$PORT, as in start-web.mjs)
const baseURL = process.env.URL ?? `http://localhost:${process.env.PORT ?? '3000'}`;
const READY_TIMEOUT_MS = 5 * 60_000;
const ROUTE_TIMEOUT_MS = 3 * 60_000;

const signedOutRoutes = ['/users/sign_in', '/get-started'];
const routes = ['/profile', '/usage', '/admin', '/admin/users'];

/** @typedef {{ method?: string; headers?: Record<string, string>; body?: string | URLSearchParams }} WarmUpRequest */

/** @type {Map<string, string>} */
const cookies = new Map();

/** @param {Response} res */
function remember(res) {
  for (const header of res.headers.getSetCookie()) {
    const [pair = ''] = header.split(';');
    const eq = pair.indexOf('=');
    cookies.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
}
const cookieHeader = () => [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');

/**
 * @param {string} route
 * @param {number} timeoutMs
 * @param {WarmUpRequest} [init]
 */
async function request(route, timeoutMs, init = {}) {
  const res = await fetch(baseURL + route, {
    ...init,
    redirect: 'manual',
    headers: { ...init.headers, cookie: cookieHeader() },
    signal: AbortSignal.timeout(timeoutMs),
  });
  remember(res);
  return res;
}
/**
 * Reads the whole body: Next.js streams pages, so headers arrive before the render finishes.
 * @param {string} route
 * @param {number} timeoutMs
 */
const get = async (route, timeoutMs) => {
  const res = await request(route, timeoutMs);
  await res.arrayBuffer();
  return res.status;
};

async function signIn() {
  const csrfRes = await request('/api/auth/csrf', ROUTE_TIMEOUT_MS);
  const { csrfToken } = csrfRes.ok ? await csrfRes.json() : {};
  if (!csrfToken) throw new Error(`CSRF token request failed with status ${csrfRes.status}`);
  const form = new URLSearchParams({
    csrfToken,
    // `@admin.example.com` makes fake login provision an admin, so /admin pages compile too.
    email: `e2e-warm-up-${Date.now()}@admin.example.com`,
    callbackUrl: '/users/after-sign-in',
    json: 'true',
  });
  const res = await request('/api/auth/callback/fake-login', ROUTE_TIMEOUT_MS, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form,
  });
  const sessionRes = await request('/api/auth/session', ROUTE_TIMEOUT_MS);
  const session = sessionRes.ok ? await sessionRes.json() : null;
  if (!session?.user) {
    throw new Error(`Fake login did not sign in: callback status ${res.status}, session status ${sessionRes.status}`);
  }
  console.log(`fake login: ${res.status}, signed in`);
}

const deadline = Date.now() + READY_TIMEOUT_MS;
for (;;) {
  try {
    if ((await get('/api/auth/csrf', 30_000)) === 200) break;
  } catch {
    // not listening yet
  }
  if (Date.now() > deadline) {
    console.error(`next dev did not become ready at ${baseURL} within ${READY_TIMEOUT_MS / 1000}s`);
    process.exit(1);
  }
  await new Promise(r => setTimeout(r, 2_000));
}
console.log(`ready: ${baseURL}`);

/**
 * Requests one route and logs how long its first (compiling) response took.
 * @param {string} route
 * @param {WarmUpRequest} [init]
 */
async function warm(route, init) {
  const started = Date.now();
  try {
    const res = await request(route, ROUTE_TIMEOUT_MS, init);
    await res.arrayBuffer();
    console.log(`${res.status} ${init?.method ?? 'GET'} ${route} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  } catch (error) {
    // Best effort: report the route and let the tests decide.
    console.log(`ERR ${route}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

for (const route of signedOutRoutes) await warm(route);
try {
  await signIn();
} catch (error) {
  // `::warning::` surfaces it in the Actions UI; the tests' own sign-in fails with the details.
  console.log(
    `::warning::Fake login failed, warming up signed out: ${error instanceof Error ? error.message : String(error)}`,
  );
}
for (const route of routes) await warm(route);
