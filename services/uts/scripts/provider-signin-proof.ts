/**
 * Proof that a deployed issuer offers its sign-in providers as configured, with no credentials
 * (README, "Production sign-in providers"). It reads `/signin/passkeys` and checks that the page
 * offers exactly the expected providers, then calls each provider's start without following the
 * redirect and checks it (`scripts/provider-start.ts`). It never completes a sign-in, so it shows
 * only what UTS sends, the authorization URL it builds from the client id, not what the provider
 * accepts; a completed sign-in per provider after the deploy (README, "Production sign-in
 * providers") proves the provider side.
 *
 * Each start stores one sign-in flow row, which expires unused after 10 minutes, and takes one
 * anonymous sign-in write slot of the caller's address. It prints the public client ids and
 * endpoints, never a state, challenge, nonce or cookie value, and exits with status 1 on any
 * failure. A failure the issuer may not repeat (a network error, 429 or 5xx) is marked retryable.
 *
 *   UTS_PROOF_ISSUER     https://uts-staging.kiloapps.io or https://uts.kiloapps.io
 *   UTS_PROOF_PROVIDERS  <provider>=<client id>,... : every provider the issuer must offer
 */
import { utsProviderStartPath } from '@kilocode/uts-contracts';
import { z } from 'zod';
import {
  PROOF_ISSUERS,
  pageProblems,
  parseExpectedProviders,
  providersOnPage,
  startProblems,
  startSummary,
  type StartAnswer,
} from './provider-start';

const environment = z
  .object({
    UTS_PROOF_ISSUER: z.enum(PROOF_ISSUERS),
    UTS_PROOF_PROVIDERS: z.string().default(''),
  })
  .parse(process.env);
const issuer = environment.UTS_PROOF_ISSUER;
const expected = parseExpectedProviders(environment.UTS_PROOF_PROVIDERS);

const REQUEST_TIMEOUT_MS = 10_000;
const RETURN_TO = '/signin/passkeys';

let failed = 0;

function report(check: string, problems: readonly string[], summary: string): void {
  if (problems.length === 0) {
    console.log(`PASS ${check}: ${summary}`);
    return;
  }
  failed += 1;
  for (const problem of problems) console.log(`FAIL ${check}: ${problem}`);
}

const isRetryable = (status: number) => status === 429 || status >= 500;

/** One GET without credentials or redirects; null with a logged failure when it did not answer. */
async function get(check: string, path: string): Promise<Response | null> {
  try {
    return await fetch(new URL(path, issuer), {
      redirect: 'manual',
      headers: { accept: 'text/html' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.name : 'unknown error';
    report(check, [`no answer (${reason}); retryable`], '');
    return null;
  }
}

console.log(`issuer ${issuer}`);
console.log(
  `expected ${[...expected].map(([provider, clientId]) => `${provider}=${clientId}`).join(', ') || 'no provider'}`
);

const page = await get('page', RETURN_TO);
if (page !== null) {
  if (page.status !== 200) {
    const retryable = isRetryable(page.status) ? '; retryable' : '';
    report('page', [`${RETURN_TO} answers ${page.status}; expected 200${retryable}`], '');
  } else {
    const listed = providersOnPage(await page.text());
    report('page', pageProblems(listed, expected), `offers ${listed.join(', ') || 'no provider'}`);
  }
}

for (const [provider, clientId] of expected) {
  const query = new URLSearchParams({ return_to: RETURN_TO }).toString();
  const response = await get(provider, `${utsProviderStartPath(provider)}?${query}`);
  if (response === null) continue;
  const answer: StartAnswer = {
    status: response.status,
    location: response.headers.get('location'),
    // Iteration yields each Set-Cookie header on its own (Fetch standard); the Workers types this
    // package compiles against declare no `getSetCookie`.
    setCookies: [...response.headers]
      .filter(([name]) => name === 'set-cookie')
      .map(([, value]) => value),
  };
  const problems = startProblems(issuer, provider, clientId, answer);
  const retryable = isRetryable(answer.status) ? ['retryable'] : [];
  report(
    provider,
    problems.length === 0 ? [] : [...problems, ...retryable],
    problems.length === 0 ? startSummary(answer) : ''
  );
}

if (failed > 0) {
  console.log(`${failed} check(s) failed`);
  process.exitCode = 1;
} else {
  console.log(`all ${expected.size + 1} checks passed`);
}
