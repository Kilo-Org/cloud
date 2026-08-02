import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { user_github_app_tokens, kilocode_users } from '@kilocode/db/schema';
import { decryptKeyedEnvelope, encryptKeyedEnvelope } from '@kilocode/encryption';
import { and, desc, eq, gt, isNull, lt, ne, notLike, sql } from 'drizzle-orm';

import { getSeedDb } from '../lib/db';
import { normalizeSeedEmail } from '../lib/email';
import type { SeedResult } from '../index';

export const usage = '<to-email> | --remove <to-email>';

// Must match the single-source-of-truth helper in
// apps/web/src/lib/integrations/platforms/github/user-token-envelope.ts and
// git-token-service's TOKEN_SCHEME/AAD — the copied row has to stay
// decryptable by git-token-service.
const TOKEN_SCHEME = 'github-user-token-rsa-aes-256-gcm';

function tokenAad(kiloUserId: string, githubUserId: string, kind: 'access' | 'refresh'): string {
  return `github-user-authorization:v1:${kiloUserId}:standard:${githubUserId}:${kind}`;
}

function printUsage(): void {
  console.log(`Usage: pnpm dev:seed app:github-integration-copy ${usage}`);
  console.log('');
  console.log('Dev-only. Copies a valid real GitHub integration (user_github_app_tokens');
  console.log('row) from any user in the shared dev database onto the given E2E account,');
  console.log('re-encrypting the tokens for the target user. Scenarios that need a real');
  console.log('GitHub integration (e.g. cloud agents) run against the copy; when no valid');
  console.log('integration exists in the database, E2E requiring one is BLOCKED.');
  console.log('');
  console.log('Caveats: the copy shares the donor token. GitHub refresh tokens are');
  console.log("single-use, so whichever row refreshes first invalidates the other row's");
  console.log('refresh token — re-run this copy when that happens.');
  console.log('');
  console.log("The copy occupies the account's one token row, which the PR-review stub");
  console.log('(github-stub.sh) also needs. Use different accounts for the two, or');
  console.log('remove the copy first: --remove <to-email>.');
}

// The private key never leaves git-token-service in production; locally its
// Secrets Store binding lands in the service's .dev.vars, which is exactly as
// dev-only as this script.
function readServiceDevVars(): Record<string, string> {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const devVarsPath = join(repoRoot, 'services', 'git-token-service', '.dev.vars');
  let content: string;
  try {
    content = readFileSync(devVarsPath, 'utf8');
  } catch {
    throw new Error(
      `Cannot read ${devVarsPath} — run: pnpm dev:env -y cloudflare-git-token-service`
    );
  }
  const vars: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const match = /^([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/.exec(line);
    if (match) vars[match[1]] = match[2];
  }
  return vars;
}

function decodePem(encoded: string, label: string): string {
  const pem = Buffer.from(encoded, 'base64').toString('utf8');
  if (!pem.includes('KEY')) throw new Error(`${label} does not decode to a PEM key`);
  return pem;
}

export async function run(...args: string[]): Promise<SeedResult | void> {
  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return;
  }
  let remove = false;
  let positional = args;
  if (args[0] === '--remove') {
    remove = true;
    positional = args.slice(1);
  }
  const [toEmail, ...rest] = positional;
  if (!toEmail || rest.length > 0) {
    printUsage();
    throw new Error('exactly one argument expected: the target account email');
  }

  const db = getSeedDb();
  const normalizedEmail = normalizeSeedEmail(toEmail.trim());
  const [target] = await db
    .select({ id: kilocode_users.id })
    .from(kilocode_users)
    .where(eq(kilocode_users.normalized_email, normalizedEmail))
    .limit(1);
  if (!target) {
    throw new Error(
      `No user with email ${toEmail} — sign in on the device first, or pnpm dev:seed app:create-user`
    );
  }

  if (remove) {
    // Deletes whatever token row the account holds — the copy this tool
    // wrote, or a stub seed — so github-stub.sh or a fresh copy can start
    // clean. Never touches any other account's row.
    const deleted = await db
      .delete(user_github_app_tokens)
      .where(
        and(
          eq(user_github_app_tokens.kilo_user_id, target.id),
          eq(user_github_app_tokens.github_app_type, 'standard')
        )
      )
      .returning({ id: user_github_app_tokens.id });
    return { targetEmail: toEmail, removedRows: deleted.length };
  }

  const devVars = readServiceDevVars();
  const keyId = devVars.USER_GITHUB_APP_TOKEN_ACTIVE_KEY_ID;
  const privateKeyEncoded = devVars.USER_GITHUB_APP_TOKEN_ACTIVE_PRIVATE_KEY;
  const publicKeyEncoded = devVars.USER_GITHUB_APP_TOKEN_ACTIVE_PUBLIC_KEY;
  if (!keyId || !privateKeyEncoded || !publicKeyEncoded) {
    throw new Error(
      'git-token-service .dev.vars is missing the USER_GITHUB_APP_TOKEN_ACTIVE_* keys — run: pnpm dev:env -y cloudflare-git-token-service'
    );
  }
  const privateKeyPem = decodePem(privateKeyEncoded, 'private key');
  const publicKeyPem = Buffer.from(publicKeyEncoded, 'base64');

  // Newest first: the most recently updated integration is the most likely to
  // still be valid at GitHub. Fakes are never donors: seeded rows carry
  // kilo-stub* logins and far-future (year 9999) expiries, while a real
  // GitHub refresh token expires within months — the expiry bound excludes
  // every synthetic row regardless of what it is named.
  const candidates = await db
    .select()
    .from(user_github_app_tokens)
    .where(
      and(
        eq(user_github_app_tokens.github_app_type, 'standard'),
        isNull(user_github_app_tokens.revoked_at),
        notLike(user_github_app_tokens.github_login, 'kilo-stub%'),
        ne(user_github_app_tokens.kilo_user_id, target.id),
        gt(user_github_app_tokens.refresh_token_expires_at, sql`now()`),
        lt(user_github_app_tokens.refresh_token_expires_at, sql`now() + interval '2 years'`),
        // Synthetic ids (stub seeds and earlier copies) are 13 digits; real
        // GitHub user ids are shorter. A copy must never donate: revocation
        // lands on the real row only, so a surviving copy could hand out
        // dead credentials as a fresh success.
        sql`length(${user_github_app_tokens.github_user_id}) < 13`
      )
    )
    .orderBy(desc(user_github_app_tokens.updated_at))
    .limit(10);

  let source: (typeof candidates)[number] | undefined;
  let accessToken = '';
  let refreshToken = '';
  for (const row of candidates) {
    try {
      accessToken = decryptKeyedEnvelope(
        row.access_token_encrypted,
        TOKEN_SCHEME,
        { active: { keyId, privateKeyPem } },
        tokenAad(row.kilo_user_id, row.github_user_id, 'access')
      );
      refreshToken = decryptKeyedEnvelope(
        row.refresh_token_encrypted,
        TOKEN_SCHEME,
        { active: { keyId, privateKeyPem } },
        tokenAad(row.kilo_user_id, row.github_user_id, 'refresh')
      );
      source = row;
      break;
    } catch {
      // Encrypted under a retired key — not usable as a donor; try the next.
    }
  }
  if (!source) {
    throw new Error(
      'No valid GitHub integration found in the database — E2E scenarios that need one are BLOCKED'
    );
  }

  // The copy needs its own github_user_id: (github_user_id, app_type) is
  // unique, so the donor's id cannot appear twice. The 8 prefix plus 12
  // digits cannot collide with a real GitHub id or with a stub seed (which
  // uses a 9 prefix); deterministic per target so re-copies update in place.
  const syntheticGithubUserId = `8${createHash('sha256')
    .update(normalizedEmail)
    .digest('hex')
    .replace(/[a-f]/g, '')
    .slice(0, 12)}`;

  const values = {
    kilo_user_id: target.id,
    github_app_type: 'standard' as const,
    github_user_id: syntheticGithubUserId,
    github_login: source.github_login,
    access_token_encrypted: encryptKeyedEnvelope(
      accessToken,
      TOKEN_SCHEME,
      { keyId, publicKeyPem },
      tokenAad(target.id, syntheticGithubUserId, 'access')
    ),
    access_token_expires_at: source.access_token_expires_at,
    refresh_token_encrypted: encryptKeyedEnvelope(
      refreshToken,
      TOKEN_SCHEME,
      { keyId, publicKeyPem },
      tokenAad(target.id, syntheticGithubUserId, 'refresh')
    ),
    refresh_token_expires_at: source.refresh_token_expires_at,
    revoked_at: null,
    revocation_reason: null,
  };

  await db
    .insert(user_github_app_tokens)
    .values(values)
    .onConflictDoUpdate({
      target: [user_github_app_tokens.kilo_user_id, user_github_app_tokens.github_app_type],
      set: {
        github_user_id: values.github_user_id,
        github_login: values.github_login,
        access_token_encrypted: values.access_token_encrypted,
        access_token_expires_at: values.access_token_expires_at,
        refresh_token_encrypted: values.refresh_token_encrypted,
        refresh_token_expires_at: values.refresh_token_expires_at,
        revoked_at: null,
        revocation_reason: null,
        credential_version: sql`${user_github_app_tokens.credential_version} + 1`,
        updated_at: new Date().toISOString(),
      },
    });

  return {
    targetEmail: toEmail,
    donorLogin: source.github_login,
    accessTokenExpiresAt: source.access_token_expires_at,
    refreshTokenExpiresAt: source.refresh_token_expires_at,
  };
}
