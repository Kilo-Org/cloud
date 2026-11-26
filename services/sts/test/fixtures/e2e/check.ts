// Local end-to-end check of service tokens (README "Tests"). Start both test Workers first:
//   wrangler dev -c test/fixtures/e2e/wrangler.probe.jsonc -c test/fixtures/e2e/wrangler.sts.jsonc
// then run this script with tsx from services/sts. It mints through the probe's SecretsBroker
// binding, verifies each token with @kilocode/verify against the served key set, checks that a
// forged, an expired and a wrong-audience token are refused with the design section 7 statuses,
// and waits for the issued and denied events on the audit queue. Exits 1 on the first failure.
import type { MintResult } from '@kilocode/sts-contracts';
import { setTimeout as sleep } from 'node:timers/promises';
import { SignJWT, decodeJwt, decodeProtectedHeader, generateKeyPair } from 'jose';
import { createVerifier, httpJwksSource } from '../../../../../packages/verify/src/index';
import { E2E_SCOPES } from './scopes';

const BASE = 'http://localhost:8827';
const ISSUER = BASE;

function check(condition: boolean, what: string, detail: unknown = ''): void {
  console.log(
    `${condition ? 'PASS' : 'FAIL'} ${what}`,
    detail === '' ? '' : JSON.stringify(detail)
  );
  if (!condition) process.exit(1);
}

async function mint(audiences: string[]): Promise<MintResult> {
  const response = await fetch(`${BASE}/probe/mint?audiences=${audiences.join(',')}`);
  return (await response.json()) as MintResult;
}

function verifierFor(audience: string) {
  return createVerifier({
    audience,
    resourceMetadataUrl: `${BASE}/.well-known/oauth-protected-resource`,
    sts: { issuer: ISSUER, jwks: httpJwksSource(ISSUER), scopeRegistry: E2E_SCOPES },
  });
}

const context = { waitUntil: (promise: Promise<unknown>) => void promise };

async function verify(audience: string, token: string) {
  return await verifierFor(audience).verify(
    `Bearer ${token}`,
    { issuer: 'sts', scope: `${audience}:probe.read` },
    context
  );
}

const jwks = await fetch(`${BASE}/.well-known/jwks.json`);
check(jwks.status === 200, 'GET /.well-known/jwks.json answers 200', {
  cacheControl: jwks.headers.get('cache-control'),
});
console.log('key set', JSON.stringify(await jwks.json()));

const minted = await mint(['e2e-alpha', 'e2e-beta']);
check(
  minted.status === 'ok' && minted.tokens.every(token => token.status === 'issued'),
  'mint of 2 tokens through SecretsBroker issues both',
  minted.status === 'ok' ? minted.tokens.map(token => token.status) : minted
);
if (minted.status !== 'ok') process.exit(1);
const [alpha, beta] = minted.tokens;
if (alpha.status !== 'issued' || beta.status !== 'issued') process.exit(1);
console.log('alpha header', JSON.stringify(decodeProtectedHeader(alpha.token)));
console.log('alpha claims', JSON.stringify(decodeJwt(alpha.token)));

for (const [audience, token] of [
  ['e2e-alpha', alpha.token],
  ['e2e-beta', beta.token],
] as const) {
  const result = await verify(audience, token);
  check(
    result.ok,
    `@kilocode/verify accepts the ${audience} token`,
    result.ok ? result.caller : result
  );
}

const wrongAudience = await verify('e2e-beta', alpha.token);
check(
  !wrongAudience.ok && wrongAudience.status === 403,
  'a token for e2e-alpha presented to e2e-beta is refused 403',
  wrongAudience.ok ? wrongAudience : { status: wrongAudience.status, error: wrongAudience.error }
);

const { privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519' });
const forged = await new SignJWT(decodeJwt(alpha.token))
  .setProtectedHeader({ alg: 'EdDSA', typ: 'at+jwt', kid: decodeProtectedHeader(alpha.token).kid })
  .sign(privateKey);
const forgedResult = await verify('e2e-alpha', forged);
check(
  !forgedResult.ok && forgedResult.status === 401,
  'the same claims and kid signed with another key are refused 401',
  forgedResult.ok ? forgedResult : { status: forgedResult.status, error: forgedResult.error }
);

const denied = await mint(['e2e-alpha', 'e2e-gamma']);
check(
  denied.status === 'ok' &&
    denied.tokens[0].status === 'issued' &&
    denied.tokens[1].status === 'denied' &&
    denied.tokens[1].reason === 'audience_not_allowed',
  'an audience outside the policy is denied, the other token issued',
  denied.status === 'ok'
    ? denied.tokens.map(token => (token.status === 'denied' ? token.reason : token.status))
    : denied
);

// The token lives 300 s and the verifier allows 60 s of skew: present it once that has passed.
const waitMs = (alpha.expiresAt + 61) * 1000 - Date.now();
console.log(`waiting ${Math.ceil(waitMs / 1000)} s for the alpha token to expire`);
await sleep(Math.max(0, waitMs));
const expired = await verify('e2e-alpha', alpha.token);
check(
  !expired.ok && expired.status === 401,
  'the alpha token presented after exp + skew is refused 401',
  expired.ok ? expired : { status: expired.status, error: expired.error }
);

type SeenEvent = { stream: string; type: string; attributes: Record<string, unknown> };
let events: SeenEvent[] = [];
for (let attempt = 0; attempt < 30; attempt += 1) {
  events = (await (await fetch(`${BASE}/probe/audit`)).json()) as SeenEvent[];
  if (events.some(event => event.type === 'ai.kilo.sts.token.denied')) break;
  await sleep(5_000);
}
const issued = events.filter(event => event.type === 'ai.kilo.sts.token.issued');
const deniedEvents = events.filter(event => event.type === 'ai.kilo.sts.token.denied');
check(issued.length === 2, 'two token.issued events reached the audit queue', issued);
check(
  deniedEvents.length === 1 && deniedEvents[0].attributes.audience === 'e2e-gamma',
  'one token.denied event for e2e-gamma reached the audit queue',
  deniedEvents
);
console.log(
  'audit streams and types',
  JSON.stringify(events.map(event => `${event.stream} ${event.type}`))
);
