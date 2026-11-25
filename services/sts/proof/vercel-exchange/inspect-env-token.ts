// Operator check (merge gate, README step 3): what a person's `vercel env pull` token claims, and
// what it still claims after the custom-audience exchange STS would see. Run it against the
// THROWAWAY proof project only, never a real project: the pull writes that environment's values
// to a 0700 temp directory, removed at once. For the pulled and the exchanged token it prints
// `environment`, `custom_environment_id`, whether `user_id` is present, the `act` shape and the
// `scope` value; never a token. Node 24, no imports from this directory, so `node` runs it as is;
// `--cwd` is a directory linked (`vercel link`) to the proof project:
//   node inspect-env-token.ts --cwd <dir linked to the proof project> preview production staging
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const EXCHANGE_URL = 'https://oidc.vercel.com/~token';
/** Not an STS issuer, so the exchanged token can never be presented to STS. */
const AUDIENCE = 'https://sts-proof.invalid';

/** The token's claims, unverified; `{}` when it is missing or not a JWT. */
function claimsOf(token: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')
    );
    return typeof parsed === 'object' && parsed !== null ? { ...parsed } : {};
  } catch {
    return {};
  }
}

/** `act`'s shape without values beyond its audience: missing, its keys, and whether it nests. */
function actShape(act: unknown) {
  if (act === undefined) return 'missing';
  if (typeof act !== 'object' || act === null || Array.isArray(act)) return typeof act;
  return {
    keys: Object.keys(act).sort(),
    aud: 'aud' in act ? act.aud : null,
    nested: 'act' in act,
  };
}

type TokenFacts = {
  environment: unknown;
  custom_environment_id: unknown;
  userIdPresent: boolean;
  act: unknown;
  scope: unknown;
};

function facts(claims: Record<string, unknown>): TokenFacts {
  return {
    environment: claims.environment ?? null,
    custom_environment_id: claims.custom_environment_id ?? null,
    userIdPresent: 'user_id' in claims,
    act: actShape(claims.act),
    scope: claims.scope ?? null,
  };
}

async function exchange(
  token: string
): Promise<{ status: number | 'network_error'; claims: TokenFacts | null }> {
  let response: Response;
  try {
    response = await fetch(EXCHANGE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ token, aud: AUDIENCE, jti: randomUUID() }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return { status: 'network_error', claims: null };
  }
  const text = await response.text();
  if (!response.ok) return { status: response.status, claims: null };
  let exchanged: unknown;
  try {
    const parsed: unknown = JSON.parse(text);
    exchanged =
      typeof parsed === 'object' && parsed !== null && 'token' in parsed ? parsed.token : null;
  } catch {
    exchanged = null;
  }
  return {
    status: response.status,
    claims: typeof exchanged === 'string' ? facts(claimsOf(exchanged)) : null,
  };
}

const { values, positionals } = parseArgs({
  options: { cwd: { type: 'string' } },
  allowPositionals: true,
});
if (values.cwd === undefined || positionals.length === 0) {
  throw new Error(
    'usage: node inspect-env-token.ts --cwd <dir linked to the proof project> preview production staging'
  );
}

for (const environment of positionals) {
  // mkdtemp creates the directory with mode 0700; it is removed with the pulled file.
  const directory = mkdtempSync(join(tmpdir(), 'vercel-env-'));
  let token = '';
  try {
    const file = join(directory, '.env');
    execFileSync(
      'vercel',
      ['env', 'pull', file, `--environment=${environment}`, '--yes', '--cwd', values.cwd],
      { stdio: ['ignore', 'ignore', 'inherit'] }
    );
    const line = readFileSync(file, 'utf8')
      .split('\n')
      .find(entry => entry.startsWith('VERCEL_OIDC_TOKEN='));
    token = line?.slice('VERCEL_OIDC_TOKEN='.length).replace(/^"|"$/g, '') ?? '';
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  if (token === '') {
    console.log(JSON.stringify({ pulled: environment, tokenIssued: false }));
    continue;
  }
  const pulled = facts(claimsOf(token));
  const exchanged = await exchange(token);
  // Merge gate: either no token, or both the pulled and the exchanged token carry user_id. A
  // refused exchange (not 429) issues no exchanged token, so only the pulled one counts; a 429 or
  // a network failure proves nothing and the step is rerun after 70 s.
  const gate =
    exchanged.status === 429 || exchanged.status === 'network_error'
      ? 'inconclusive'
      : pulled.userIdPresent && (exchanged.claims === null || exchanged.claims.userIdPresent)
        ? 'holds'
        : 'stops';
  console.log(
    JSON.stringify({ pulled: environment, tokenIssued: true, pulledToken: pulled, exchanged, gate })
  );
}
