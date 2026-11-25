// Operator check: which Vercel environment a `vercel env pull` token claims and whether it carries
// `user_id` (STS refuses any Vercel token that does). Prints those two facts per environment and
// never the token. Node 24, no imports from this directory, so `node` runs it as is; `--cwd` is a
// directory linked (`vercel link`) to the project to read:
//   node inspect-env-token.ts --cwd <linked dir> preview production staging
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

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

const { values, positionals } = parseArgs({
  options: { cwd: { type: 'string' } },
  allowPositionals: true,
});
if (values.cwd === undefined || positionals.length === 0) {
  throw new Error('usage: node inspect-env-token.ts --cwd <linked dir> preview production staging');
}

for (const environment of positionals) {
  // mkdtemp creates the directory with mode 0700; it is removed with the pulled file.
  const directory = mkdtempSync(join(tmpdir(), 'vercel-env-'));
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
    const claims = claimsOf(line?.slice('VERCEL_OIDC_TOKEN='.length).replace(/^"|"$/g, '') ?? '');
    console.log(
      JSON.stringify({
        pulled: environment,
        environment: claims.environment ?? null,
        userIdPresent: 'user_id' in claims,
      })
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
