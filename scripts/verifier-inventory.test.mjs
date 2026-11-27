// Phase 4 surface inventory. SURFACES below is design section 9.6 (decision Q1,
// updated 2026-11-26), in its order: 25 entries, without the retired
// `services/images-mcp` and `services/db-proxy`. The scan (verifier-inventory.mjs)
// reads the tracked production source of every workspace; a credential check outside the
// listed surfaces fails the test until a decision lists it or an exact file
// exception below records why it is not a Kilo verifier.
//
// Limits of the scan: it matches source patterns, not a syntax tree.
// - Paths and languages: only tracked JavaScript and TypeScript sources under
//   the pnpm workspace roots; shell, container, Python and Go code, generated or
//   untracked files, and code in other repositories (Pages) are not read. Test
//   code is skipped by path: `.d.ts`, `*.test.*`, `*.spec.*` and `*.stories.*`
//   files, any directory named `test`, `tests`, `__tests__`, `__mocks__`,
//   `fixtures`, `e2e` or `scripts`, and `*test-setup*`, `vitest.config*`,
//   `vitest.setup*` and `playwright.config*` files.
// - Comments: a line that starts with `//`, `/*` or `*` is skipped; a block
//   comment that starts mid-line, or a block line without a leading `*`, is read
//   as code, and code after `*/` on a skipped line is not read.
// - Plain comparisons: only `===` or `!==` against an `env.*_SECRET|TOKEN|KEY`
//   binding, beside an inbound header or bearer read; any other hand-rolled
//   comparison is missed.
// - Re-exports and indirection: a verifier reached through `export *` from a
//   helper module, `require()`, a dynamic `import()`, or `crypto.subtle` under
//   another name is missed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  fileSignals,
  inventoryViolations,
  isProductionFile,
  scanLiveRepository,
  scanRepository,
  workspaceDirs,
  workspacePatterns,
} from './verifier-inventory.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const readRepoFile = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

// `dir` rows are live workspaces with hits the scan must still find. The other
// rows record what the source shows for a surface that has no workspace here.
const SURFACES = [
  {
    entry: 'apps/web',
    dir: 'apps/web',
    evidence: [
      ['apps/web/src/lib/internal-api-auth.ts', 'primitive'],
      ['apps/web/src/app/(app)/integrations/slack/reinstall/route.ts', 'helper-call'],
    ],
  },
  {
    entry: 'apps/ai-gateway',
    dir: 'apps/ai-gateway',
    evidence: [
      ['apps/ai-gateway/src/app/api/v1/models/route.ts', 'web-shared-import'],
      [
        'apps/ai-gateway/src/app/api/v1/internal/auto-routing/denied-models/route.ts',
        'web-shared-import',
      ],
    ],
  },
  {
    entry: 'apps/ai-gateway-secure-proxy',
    dir: 'apps/ai-gateway-secure-proxy',
    evidence: [['apps/ai-gateway-secure-proxy/src/lib/secure-proxy.ts', 'primitive']],
  },
  {
    entry: 'services/ai-attribution',
    dir: 'services/ai-attribution',
    evidence: [['services/ai-attribution/src/util/auth.ts', 'helper-call']],
  },
  {
    entry: 'services/auto-routing',
    dir: 'services/auto-routing',
    evidence: [
      ['services/auto-routing/src/caller-auth.ts', 'helper-call'],
      ['services/auto-routing/src/auth.ts', 'helper-call'],
    ],
  },
  {
    entry: 'services/auto-routing-benchmark',
    dir: 'services/auto-routing-benchmark',
    evidence: [
      ['services/auto-routing-benchmark/src/auth.ts', 'helper-call'],
      ['services/auto-routing-benchmark/src/case-inference-capability.ts', 'helper-call'],
    ],
  },
  {
    entry: 'services/cloud-agent-next',
    dir: 'services/cloud-agent-next',
    evidence: [
      ['services/cloud-agent-next/src/validate-kilo-token.ts', 'helper-call'],
      ['services/cloud-agent-next/src/server.ts', 'primitive'],
    ],
  },
  {
    entry: 'services/git-token-service',
    dir: 'services/git-token-service',
    evidence: [['services/git-token-service/src/index.ts', 'helper-call']],
  },
  {
    entry: 'services/kilo-chat',
    dir: 'services/kilo-chat',
    evidence: [
      ['services/kilo-chat/src/auth.ts', 'helper-call'],
      ['services/kilo-chat/src/auth-bot.ts', 'primitive'],
    ],
  },
  {
    entry: 'services/event-service',
    dir: 'services/event-service',
    evidence: [['services/event-service/src/auth.ts', 'helper-call']],
  },
  {
    entry: 'services/notifications',
    dir: 'services/notifications',
    evidence: [
      ['services/notifications/src/auth.ts', 'helper-call'],
      ['services/notifications/src/index.ts', 'primitive'],
    ],
  },
  {
    entry: 'services/session-sync',
    dir: 'services/session-sync',
    evidence: [
      ['services/session-sync/src/auth.ts', 'helper-call'],
      ['services/session-sync/src/internal.ts', 'primitive'],
    ],
  },
  {
    entry: 'services/session-ingest',
    dir: 'services/session-ingest',
    evidence: [
      ['services/session-ingest/src/middleware/kilo-jwt-auth.ts', 'helper-call'],
      ['services/session-ingest/src/app.ts', 'primitive'],
    ],
  },
  {
    entry: 'services/user-data-export',
    dir: 'services/user-data-export',
    evidence: [['services/user-data-export/src/index.ts', 'helper-call']],
  },
  {
    entry: 'services/usage-ingest',
    dir: 'services/usage-ingest',
    evidence: [['services/usage-ingest/src/publish-auth.ts', 'primitive']],
  },
  {
    entry: 'services/o11y',
    dir: 'services/o11y',
    evidence: [['services/o11y/src/admin-middleware.ts', 'primitive']],
  },
  {
    entry: 'services/pages',
    // The verifier runs in nteract/nteract; this repository holds the pin and
    // the web app's side of the exchange (section 9.1).
    external: {
      dir: 'services/pages',
      pin: 'services/pages/source.json',
      repository: 'nteract/nteract',
      webSide: ['apps/web/src/lib/pages-auth/pages-auth-clients.ts', 'primitive'],
    },
  },
  {
    entry: 'services/kilo-mcp',
    dir: 'services/kilo-mcp',
    evidence: [['services/kilo-mcp/src/index.ts', 'oauth-provider']],
  },
  {
    entry: 'services/security-auto-analysis',
    dir: 'services/security-auto-analysis',
    evidence: [['services/security-auto-analysis/src/index.ts', 'primitive']],
  },
  {
    entry: 'services/webhook-agent-ingest',
    dir: 'services/webhook-agent-ingest',
    evidence: [
      ['services/webhook-agent-ingest/src/util/auth.ts', 'primitive'],
      ['services/webhook-agent-ingest/src/routes/callbacks.ts', 'helper-call'],
    ],
  },
  {
    entry: 'services/model-eval-ingest',
    dir: 'services/model-eval-ingest',
    evidence: [['services/model-eval-ingest/src/index.ts', 'primitive']],
  },
  {
    entry: 'services/security-sync',
    dir: 'services/security-sync',
    evidence: [['services/security-sync/src/index.ts', 'primitive']],
  },
  {
    entry: 'services/deploy-infra and app-builder',
    removedInSource: {
      paths: ['services/deploy-infra', 'services/app-builder'],
      removedBy: '726db206d4bf (#8317, 2026-10-22)',
    },
  },
  {
    entry: 'services/kilo-ops',
    // Its only check is the Cloudflare Access JWT (see EXCEPTIONS), which Kilo
    // does not issue: a discrepancy with decision Q1, kept as listed.
    noKiloCheck: 'services/kilo-ops',
  },
  {
    entry: 'packages/mcp-gateway',
    removedInSource: {
      paths: ['packages/mcp-gateway', 'services/mcp-gateway'],
      removedBy: '0763ba3c3df2 (#8156, 2026-10-19)',
    },
  },
];

// KiloClaw keeps its current credentials until it retires (decision Q12), so
// its workspaces, the nested controller and plugins included, are excluded.
const EXCLUDED_DIRS = ['services/kiloclaw'];

// Every file outside the listed surfaces and KiloClaw that has hits: the exact
// count of each kind, and for a third-party check the issuer or header it pins.
// The third-party workspaces of section 9.6 (scim-sync, gmail-push,
// kiloclaw-inbound-email) have no other allowance.
const sharedWeb = 'Shared web code that runs only in apps/web and apps/ai-gateway (rows 1 and 2)';
const sharedWorker = 'Definition of a shared legacy verifier; its callers are classified';
const EXCEPTIONS = {
  'apps/storybook/src/components/TrialStateSlider.tsx': {
    reason: 'Storybook (no requests): organization trial helpers from web-shared',
    signals: { 'web-shared-import': 1 },
    pins: ["'@kilocode/web-shared/lib/organizations/trial-utils'"],
  },
  'apps/storybook/src/mockData/organizations.ts': {
    reason: 'Storybook (no requests): organization schema from web-shared',
    signals: { 'web-shared-import': 1 },
    pins: ["'@kilocode/web-shared/lib/organizations/organization-types'"],
  },
  'apps/storybook/src/mockData/providers.ts': {
    reason: 'Storybook (no requests): OpenRouter model schema from web-shared',
    signals: { 'web-shared-import': 1 },
    pins: ["'@kilocode/web-shared/lib/ai-gateway/providers/openrouter/openrouter-types'"],
  },
  'apps/extension/src/shared/local-agents/encoding.ts': {
    reason: 'Browser extension: MAC of the local agent pairing, checked on the client',
    signals: { primitive: 1 },
    pins: ['verifyHubMac'],
  },
  'packages/auto-routing-contracts/src/custom-router.ts': {
    reason: 'Definition of verifyAutoDecision (decision token); called from web-shared',
    signals: { 'helper-call': 1, primitive: 1 },
    pins: ['export async function verifyAutoDecision('],
  },
  'packages/encryption/src/timing-safe-equal.ts': {
    reason: 'Definition of timingSafeEqual',
    signals: { primitive: 1 },
    pins: ['export function timingSafeEqual('],
  },
  'packages/verify/src/jws.ts': {
    reason: 'The shared verification library of design section 7',
    signals: { primitive: 1 },
  },
  'packages/verify/src/pat.ts': {
    reason: 'The shared verification library of design section 7',
    signals: { primitive: 1 },
  },
  'packages/web-shared/src/lib/ai-gateway/auto-model/auto-decision.ts': {
    reason: sharedWeb,
    signals: { 'helper-call': 1, 'helper-import': 1 },
  },
  'packages/web-shared/src/lib/ai-gateway/benchmark-case-admission.ts': {
    reason: sharedWeb,
    signals: { 'helper-call': 1, 'helper-import': 1 },
  },
  'packages/web-shared/src/lib/ai-gateway/gateway-account-rate-limit.ts': {
    reason: sharedWeb,
    signals: { 'helper-call': 1, 'helper-import': 1 },
  },
  'packages/web-shared/src/lib/ai-gateway/handlers/auto-routing-denied-models.ts': {
    reason: sharedWeb,
    signals: { primitive: 1 },
  },
  'packages/web-shared/src/lib/ai-gateway/handlers/benchmark-case-inference.ts': {
    reason: sharedWeb,
    signals: { primitive: 1 },
  },
  'packages/web-shared/src/lib/ai-gateway/handlers/benchmark-usage-receipts.ts': {
    reason: sharedWeb,
    signals: { primitive: 1 },
  },
  'packages/web-shared/src/lib/ai-gateway/handlers/embedding-models.ts': {
    reason: sharedWeb,
    signals: { 'helper-call': 1, 'helper-import': 1 },
  },
  'packages/web-shared/src/lib/ai-gateway/handlers/fim-completions.ts': {
    reason: sharedWeb,
    signals: { 'helper-call': 1, 'helper-import': 1 },
  },
  'packages/web-shared/src/lib/ai-gateway/handlers/llm-proxy.ts': {
    reason: sharedWeb,
    signals: { 'helper-call': 1, 'helper-import': 1 },
  },
  'packages/web-shared/src/lib/ai-gateway/handlers/model-validation.ts': {
    reason: sharedWeb,
    signals: { 'helper-call': 1, 'helper-import': 1 },
  },
  'packages/web-shared/src/lib/ai-gateway/handlers/models-by-provider.ts': {
    reason: sharedWeb,
    signals: { 'helper-call': 1, 'helper-import': 1 },
  },
  'packages/web-shared/src/lib/ai-gateway/handlers/models.ts': {
    reason: sharedWeb,
    signals: { 'helper-call': 1, 'helper-import': 1 },
  },
  'packages/web-shared/src/lib/ai-gateway/handlers/transcription-models.ts': {
    reason: sharedWeb,
    signals: { 'helper-call': 1, 'helper-import': 1 },
  },
  'packages/web-shared/src/lib/ai-gateway/handlers/usage-endpoint-pipeline.ts': {
    reason: sharedWeb,
    signals: { 'helper-call': 1, 'helper-import': 1 },
  },
  'packages/web-shared/src/lib/ai-gateway/typesafe/handler.ts': {
    reason: sharedWeb,
    signals: { 'helper-call': 1, 'helper-import': 1 },
  },
  'packages/web-shared/src/lib/tokens.ts': {
    reason: sharedWeb,
    signals: { 'helper-call': 1, primitive: 1, 'auth-library-import': 1 },
  },
  'packages/web-shared/src/lib/trpc/init.ts': {
    reason: sharedWeb,
    signals: { 'helper-call': 1, 'helper-import': 1 },
  },
  'packages/web-shared/src/lib/user/server.ts': {
    reason: sharedWeb,
    signals: { 'helper-call': 6, 'helper-import': 3, 'auth-library-import': 1 },
  },
  'packages/worker-utils/src/backend-auth-middleware.ts': {
    reason: sharedWorker,
    signals: { 'helper-call': 1, primitive: 1 },
  },
  'packages/worker-utils/src/callback-token.ts': {
    reason: sharedWorker,
    signals: { 'helper-call': 1 },
  },
  'packages/worker-utils/src/kilo-token-auth.ts': {
    reason: sharedWorker,
    signals: { 'helper-call': 4 },
  },
  'packages/worker-utils/src/kilo-token-policy.ts': {
    reason: sharedWorker,
    signals: { 'helper-call': 5 },
  },
  'packages/worker-utils/src/kilo-token-verification.ts': {
    reason: sharedWorker,
    signals: { 'helper-call': 1, primitive: 1, 'auth-library-import': 1 },
  },
  'packages/worker-utils/src/kilo-token.ts': {
    reason: sharedWorker,
    signals: { 'helper-call': 2 },
  },
  'packages/worker-utils/src/runtime-authorization.ts': {
    reason: sharedWorker,
    signals: { 'helper-call': 2, primitive: 1, 'auth-library-import': 1 },
  },
  'packages/worker-utils/src/runtime-proxy-attestation.ts': {
    reason: sharedWorker,
    signals: { 'helper-call': 2 },
  },
  'services/audit-relay/src/relay/signing.ts': {
    reason: 'Audit relay: Ed25519 signature of its own checkpoints, not a request credential',
    signals: { primitive: 1 },
    pins: ['export async function verifyEd25519('],
  },
  'services/code-review-infra/src/index.ts': {
    reason:
      'Outside decision Q1: backendAuthMiddleware on BACKEND_AUTH_TOKEN, a Kilo shared secret; recorded for a decision, not converted',
    signals: { 'helper-call': 1, 'helper-import': 1 },
    pins: ['BACKEND_AUTH_TOKEN'],
  },
  'services/gmail-push/src/auth/oidc.ts': {
    reason: 'Third party (section 9.6): Google OIDC push token',
    signals: { primitive: 1, 'auth-library-import': 1 },
    pins: ['https://accounts.google.com', 'https://www.googleapis.com/oauth2/v3/certs'],
  },
  'services/kilo-ops/src/cf-access.middleware.ts': {
    reason: 'Third party: Cloudflare Access JWT of the team domain',
    signals: { primitive: 1, 'auth-library-import': 1 },
    pins: ['.cloudflareaccess.com', '/cdn-cgi/access/certs'],
  },
  'services/sts/src/identity/verify.ts': {
    reason: 'STS workload identity: Fly, GitHub Actions and Vercel OIDC tokens',
    signals: { primitive: 1, 'auth-library-import': 1 },
    pins: [
      'https://oidc.fly.io/',
      'https://token.actions.githubusercontent.com',
      'return `${VERCEL_ISSUER_PREFIX}${identity.teamSlug}`;',
    ],
  },
  'services/sts/src/infisical/webhook.ts': {
    reason: 'STS: Infisical webhook signature',
    signals: { primitive: 1 },
    pins: ['x-infisical-signature'],
  },
  'services/sts/proof/vercel-exchange/lib/exchange.ts': {
    reason:
      'STS proof harness for the Vercel OIDC exchange (design section 4.4): gated by a temporary proof-project key, not a product credential',
    signals: { primitive: 1 },
    pins: ['const expected = process.env.PROOF_SHARED_SECRET;', 'https://oidc.vercel.com/~token'],
  },
  'services/uts/src/oauth/dpop.ts': {
    reason:
      'UTS, the issuer (design section 5): checks a client DPoP proof (RFC 9449) against the key the proof embeds; it mints the tokens phase 4 verifiers accept',
    signals: { primitive: 1, 'auth-library-import': 1 },
    pins: ['jwtVerify(value, EmbeddedJWK', 'typ: DPOP_TYPE'],
  },
  'services/uts/src/account/bearer.ts': {
    reason:
      'UTS, the issuer (design section 5): its account API checks the access tokens UTS itself signs, under its own signer keys, for the uts audience; not a phase 4 verifier',
    signals: { primitive: 1, 'auth-library-import': 1 },
    pins: ['audience: UTS_ACCOUNT_AUDIENCE', 'issuer: config.endpoints.issuer'],
  },
  'services/uts/src/signin/providers/exchange.ts': {
    reason:
      'Third party: UTS provider sign-in checks the ID token of an upstream OIDC provider under that provider key set and issuers (src/signin/providers/specs.ts)',
    signals: { primitive: 1, 'auth-library-import': 1 },
    pins: ['keySet(spec.endpoints.jwks)', 'issuer: [...spec.endpoints.issuers]'],
  },
  'services/uts/src/bff/client-auth.ts': {
    reason:
      'UTS, the issuer (design section 5.1): kilo-web client authentication at UTS endpoints, an RFC 7523 private_key_jwt assertion under the KILO_WEB_CLIENT_JWKS keys; not a phase 4 verifier',
    signals: { primitive: 1, 'auth-library-import': 1 },
    pins: ['issuer: KILO_WEB_CLIENT_ID', 'KILO_WEB_CLIENT_JWKS'],
  },
  'services/uts/src/exchange/endpoint.ts': {
    reason:
      'UTS, the issuer (design section 5.9): the RFC 8693 broker exchange checks its subject token, an access token UTS itself signs, under its own signer keys; not a phase 4 verifier',
    signals: { primitive: 1, 'auth-library-import': 1 },
    pins: ['issuer: config.endpoints.issuer', 'typ: UTS_ACCESS_TOKEN_TYPE'],
  },
  'services/uts/src/dev-clients.ts': {
    reason:
      'UTS development entry only (src/dev.ts): stand-in check of STS caller tokens from the local fake STS signer for the local end-to-end run',
    signals: { primitive: 1, 'auth-library-import': 1 },
    pins: ["const DEVELOPMENT_STS_ISSUER = 'http://localhost:8825';", 'DEV_STS_JWKS_URL'],
  },
  'packages/trpc/src/agent-profiles-mobile.ts': {
    reason: 'Mobile tRPC router composition: createTRPCRouter only; requests run in apps/web',
    signals: { 'web-shared-import': 1 },
    pins: ["import { createTRPCRouter } from '@kilocode/web-shared/lib/trpc/init';"],
  },
  'packages/trpc/src/mobile.ts': {
    reason: 'Mobile tRPC router composition: createTRPCRouter only; requests run in apps/web',
    signals: { 'web-shared-import': 1 },
    pins: ["import { createTRPCRouter } from '@kilocode/web-shared/lib/trpc/init';"],
  },
};

const live = scanLiveRepository(root);
const surfaceDirs = SURFACES.filter(surface => surface.dir).map(surface => surface.dir);
const hasHit = ([file, kind]) =>
  live.signals.some(signal => signal.file === file && signal.kind === kind);

test('every live surface of section 9.6 still has its evidence', () => {
  for (const { dir, evidence } of SURFACES.filter(surface => surface.dir)) {
    assert.ok(live.workspaces.includes(dir), `${dir} is a workspace`);
    for (const item of evidence) {
      assert.ok(hasHit(item), `${item[0]}: no ${item[1]} hit; update the evidence`);
    }
  }
});

test('the rows removed in source stay removed', () => {
  for (const { entry, removedInSource } of SURFACES.filter(surface => surface.removedInSource)) {
    for (const path of removedInSource.paths) {
      assert.deepEqual(
        live.files.filter(file => file.startsWith(`${path}/`)),
        [],
        `${entry}: ${path} is back (removed by ${removedInSource.removedBy}); review its checks against the inventory`
      );
    }
  }
});

test('services/pages is verified in the pinned nteract/nteract source', () => {
  const { external } = SURFACES.find(surface => surface.external);
  const pin = JSON.parse(readRepoFile(external.pin));
  assert.equal(pin.repository, external.repository);
  assert.match(pin.tag, /^pages-[0-9a-f]{12}$/);
  assert.match(pin.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(
    live.files.filter(file => file.startsWith(`${external.dir}/`) && isProductionFile(file)),
    [],
    'the Pages service source lives in the pinned repository'
  );
  assert.ok(hasHit(external.webSide), 'the web app still checks the Pages exchange secret');
});

test('every credential check outside the listed surfaces is classified', () => {
  assert.deepEqual(
    inventoryViolations({
      signals: live.signals,
      surfaceDirs,
      excludedDirs: EXCLUDED_DIRS,
      exceptions: EXCEPTIONS,
      readFile: readRepoFile,
    }),
    []
  );
});

// Pattern regressions: the smallest source for each rule.
const kinds = text => fileSignals(text).map(signal => signal.kind);

test('a credential that is only sent, or a bearer only tested for presence, is no hit', () => {
  assert.deepEqual(
    kinds(`await fetch(url, { headers: { 'x-internal-api-key': env.INTERNAL_API_SECRET } });
const bearer = extractBearerToken(request.headers.get('authorization'));
if (!bearer) return deny();`),
    []
  );
});

test('a comment line is no hit', () => {
  assert.deepEqual(
    kinds('// getUserFromAuth(opts)\n/* jwtVerify(t) */\n * timingSafeEqual(a, b)'),
    []
  );
});

test('a copied WebCrypto check is a hit', () => {
  assert.deepEqual(kinds("const ok = await crypto.subtle.verify('HMAC', key, mac, data);"), [
    'primitive',
  ]);
});

test('a check against any key set is a hit, a UTS or STS set included', () => {
  assert.deepEqual(
    kinds(`const jwks = createRemoteJWKSet(new URL('https://uts.kiloapps.io/.well-known/jwks.json'));
const { payload } = await jwtVerify(token, jwks, { issuer: 'https://uts.kiloapps.io' });
const jws = await compactVerify(token, key);`),
    ['primitive', 'primitive']
  );
});

test('an HS256 check under an unknown secret is a hit', () => {
  assert.deepEqual(kinds('const claims = jwt.verify(token, env.REPORTS_SECRET);'), ['primitive']);
});

test('a shared helper is a hit when called', () => {
  assert.deepEqual(kinds('const claims = await unsealRuntimeAuthorization(sealed, secret);'), [
    'helper-call',
  ]);
  assert.deepEqual(kinds('export const auth = backendAuthMiddleware<HonoEnv>(c => c.env.X);'), [
    'helper-call',
  ]);
});

test('a helper imported from its package root under an alias is a hit', () => {
  assert.deepEqual(
    fileSignals(
      "import {\n  resError,\n  verifyCallbackToken as check,\n} from '@kilocode/worker-utils';\nawait check(params);"
    ),
    [{ kind: 'helper-import', line: 1, detail: 'verifyCallbackToken from @kilocode/worker-utils' }]
  );
});

test('a value import of the verify library is a hit, a type import is not', () => {
  assert.deepEqual(kinds("import { createVerifier } from '@kilocode/verify';"), ['verify-library']);
  assert.deepEqual(kinds("import type { Verifier } from '@kilocode/verify';"), []);
});

test('every value import of web-shared is a hit outside web-shared itself', () => {
  assert.deepEqual(
    kinds(`import { schema } from '@kilocode/web-shared';
export { handleX as POST } from '@kilocode/web-shared/lib/ai-gateway/handlers/x';
import { handleY } from '@kilocode/web-shared/lib/ai-gateway/handlers/media/y';
import type { User } from '@kilocode/web-shared/lib/user/server';`),
    ['web-shared-import', 'web-shared-import', 'web-shared-import']
  );
  const source = "import { x } from '@kilocode/web-shared/lib/y';\n";
  assert.deepEqual(
    scanRepository({
      files: ['packages/web-shared/src/a.ts', 'apps/other/src/b.ts'],
      readFile: () => source,
      workspaces: ['packages/web-shared', 'apps/other'],
    }).map(signal => signal.file),
    ['apps/other/src/b.ts']
  );
});

test('an import that can verify a token is a hit, a sign-only import is not', () => {
  assert.deepEqual(
    kinds(`import { jwt } from 'hono/jwt';
import { bearerAuth } from 'hono/bearer-auth';
import { basicAuth } from 'hono/basic-auth';
import { jwk } from 'hono/jwk';
import { verify } from 'hono/utils/jwt';
import { verify as verifyJws } from 'hono/utils/jwt/jwt';
import token from 'jsonwebtoken';
import * as jsonwebtoken from 'jsonwebtoken';
import { verify as check } from 'jsonwebtoken';
import * as jose from 'jose';
import { jwtVerify as checkJwt, SignJWT } from 'jose';
import { compactDecrypt } from 'jose';`),
    Array(12).fill('auth-library-import')
  );
  assert.deepEqual(
    kinds(`import { sign } from 'jsonwebtoken';
import { SignJWT, decodeJwt, base64url } from 'jose';
import type { JWTPayload } from 'jose';
import { cors } from 'hono/cors';`),
    []
  );
});

test('an own OAuth server is a hit', () => {
  assert.deepEqual(kinds('const provider = new OAuthProvider<Env>({ apiRoute: "/mcp" });'), [
    'oauth-provider',
  ]);
});

test('a plain comparison with an env secret counts only beside an inbound credential', () => {
  const compare = 'if (presented !== c.env.REPORTS_SHARED_SECRET) return deny();';
  assert.deepEqual(kinds(`const presented = c.req.header('authorization');\n${compare}`), [
    'plain-secret-compare',
  ]);
  assert.deepEqual(kinds(compare), []);
  assert.deepEqual(
    kinds(
      "const p = c.req.header('authorization');\nif (c.env.REPORTS_TOKEN === undefined || typeof env.X_KEY === 'string') return;"
    ),
    []
  );
});

test('only production sources are scanned', () => {
  assert.deepEqual(
    [
      'services/x/src/auth.ts',
      'apps/web/src/app/api/route.tsx',
      'services/x/src/auth.test.ts',
      'services/x/test/fixtures/auth.ts',
      'services/x/scripts/deploy.mjs',
      'services/x/worker-configuration.d.ts',
      'services/x/src/test-setup.ts',
      'services/x/README.md',
    ].filter(isProductionFile),
    ['services/x/src/auth.ts', 'apps/web/src/app/api/route.tsx']
  );
});

test('workspace patterns cover nested globs and reject unsupported forms', () => {
  const patterns = workspacePatterns(
    "packages:\n  - apps/*\n  - 'services/kiloclaw/plugins/*'\n  - services/cloud-agent-next/wrapper\n\ncatalog:\n  x: 1\n"
  );
  assert.deepEqual(
    workspaceDirs(patterns, [
      'apps/one/package.json',
      'apps/one/deep/package.json',
      'services/kiloclaw/plugins/briefing/package.json',
      'services/cloud-agent-next/wrapper/package.json',
      'tools/package.json',
    ]),
    ['apps/one', 'services/cloud-agent-next/wrapper', 'services/kiloclaw/plugins/briefing']
  );
  assert.throws(() => workspacePatterns('packages:\n  - services/**\n'), /unsupported/);
  assert.throws(() => workspacePatterns("packages:\n  - '!apps/legacy'\n"), /unsupported/);
});

// Mutation cases: each change below must fail the live classification.
const fixtureSources = {
  'services/new-worker/src/auth.ts': 'export const ok = (t, s) => verifyKiloToken(t, s);\n',
  'services/gmail-push/src/auth/oidc.ts': `${readRepoFile('services/gmail-push/src/auth/oidc.ts')}\nconst again = await jwtVerify(t, k);\n`,
  'services/kilo-ops/src/cf-access.middleware.ts': readRepoFile(
    'services/kilo-ops/src/cf-access.middleware.ts'
  ).replaceAll('.cloudflareaccess.com', '.example.com'),
  'apps/loose/auth.ts': 'if (!timingSafeEqual(a, b)) deny();\n',
};

function mutatedViolations(changed) {
  const files = Object.keys(changed);
  const signals = live.signals.filter(signal => !files.includes(signal.file));
  signals.push(
    ...scanRepository({
      files,
      readFile: file => changed[file],
      workspaces: [...live.workspaces, 'services/new-worker'],
    })
  );
  return inventoryViolations({
    signals,
    surfaceDirs,
    excludedDirs: EXCLUDED_DIRS,
    exceptions: EXCEPTIONS,
    readFile: file => changed[file] ?? readRepoFile(file),
  });
}

test('a new verifier workspace fails', () => {
  const [violation] = mutatedViolations({
    'services/new-worker/src/auth.ts': fixtureSources['services/new-worker/src/auth.ts'],
  });
  assert.match(
    violation,
    /^services\/new-worker checks a credential \(services\/new-worker\/src\/auth\.ts:1 helper-call verifyKiloToken\)/
  );
});

test('a second check in an excepted third-party file fails', () => {
  assert.match(
    mutatedViolations({
      'services/gmail-push/src/auth/oidc.ts':
        fixtureSources['services/gmail-push/src/auth/oidc.ts'],
    }).join('\n'),
    /^services\/gmail-push\/src\/auth\/oidc\.ts: hits \{"primitive":2,"auth-library-import":1\} differ/
  );
});

test('an excepted file that drops its pinned issuer fails', () => {
  assert.deepEqual(
    mutatedViolations({
      'services/kilo-ops/src/cf-access.middleware.ts':
        fixtureSources['services/kilo-ops/src/cf-access.middleware.ts'],
    }),
    ['services/kilo-ops/src/cf-access.middleware.ts: no longer contains .cloudflareaccess.com']
  );
});

test('a check outside every workspace fails, and an exception without hits is stale', () => {
  assert.deepEqual(
    mutatedViolations({
      'apps/loose/auth.ts': fixtureSources['apps/loose/auth.ts'],
      'services/sts/src/infisical/webhook.ts': 'export const none = 1;\n',
    }),
    [
      'apps/loose/auth.ts checks a credential outside every workspace (apps/loose/auth.ts:1 primitive timingSafeEqual)',
      'services/sts/src/infisical/webhook.ts: the exception matches no hit; remove it',
    ]
  );
});
