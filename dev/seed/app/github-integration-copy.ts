import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { computeDatabaseUrl } from '@kilocode/db';
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

// This tool relocates real credentials, so "dev-only" must be enforced, not
// advisory. Same guard as dev/seed/cost-insights/spend-evidence.ts.
function assertLocalDatabaseTarget(): void {
  if (process.env.USE_PRODUCTION_DB === 'true') {
    throw new Error('app:github-integration-copy refuses to run with USE_PRODUCTION_DB=true.');
  }
  const databaseUrl = new URL(computeDatabaseUrl());
  const localHostnames = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
  if (!localHostnames.has(databaseUrl.hostname)) {
    throw new Error(
      `app:github-integration-copy requires a loopback database host; received ${databaseUrl.hostname}.`
    );
  }
}

// Rows this tool writes carry a 13-digit id with an 8 prefix; stub seeds use a
// 9 prefix and 13 digits. Real GitHub ids are shorter. Only synthetic rows may
// be deleted or overwritten — a real developer's connection never may be.
function isSyntheticGithubUserId(githubUserId: string): boolean {
  return /^[89]\d{12}$/.test(githubUserId);
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
  console.log('Caveats: the copy carries only the donor access token, validated live');
  console.log('against GitHub before copying. Its refresh token is a dummy (a real one');
  console.log("would rotate and kill the donor's), so the copy has a bounded life: once");
  console.log('the access token nears expiry the service tries to refresh, that refresh');
  console.log('is rejected, and the copy row is marked revoked. The tool reports the');
  console.log('usable-until time; run the copy again to replace a revoked row.');
  console.log('');
  console.log("BLAST RADIUS — the copy shares the donor developer's OAuth GRANT, not");
  console.log('just a token. Disconnecting GitHub on the copied account (in the app, or');
  console.log("in a scenario that exercises disconnect) revokes the DONOR's GitHub");
  console.log('authorization: that developer must re-authorize the App by hand, and');
  console.log('re-running this copy cannot repair it. Never run disconnect scenarios on');
  console.log('a copied account. Commits pushed through the copy are attributed to');
  console.log('<synthetic-id>+<donor-login>@users.noreply.github.com, so they show the');
  console.log("donor's login with an id GitHub does not know.");
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

  assertLocalDatabaseTarget();
  const db = getSeedDb();
  const trimmedEmail = toEmail.trim();
  const normalizedEmail = normalizeSeedEmail(trimmedEmail);
  // normalized_email is nullable on older rows; fall back to the sign-in email.
  // A dead database must fail with the fix, not a driver stack trace: agents
  // running this burn a lot of turns guessing at raw ECONNREFUSED output.
  let target: { id: string } | undefined;
  try {
    // Exact sign-in email first: normalized_email is not unique, so an
    // unordered OR could pick a different account that normalizes the same.
    [target] = await db
      .select({ id: kilocode_users.id })
      .from(kilocode_users)
      .where(eq(kilocode_users.google_user_email, trimmedEmail))
      .limit(1);
    if (!target) {
      [target] = await db
        .select({ id: kilocode_users.id })
        .from(kilocode_users)
        .where(eq(kilocode_users.normalized_email, normalizedEmail))
        .limit(1);
    }
  } catch (error) {
    // The driver throws an AggregateError whose per-address causes carry the
    // code, so check codes and nested errors, not just the top message.
    const codes: string[] = [];
    const collect = (value: unknown): void => {
      if (!(value instanceof Error)) return;
      codes.push(value.message);
      const code = (value as Error & { code?: string }).code;
      if (code) codes.push(code);
      const nested = (value as AggregateError).errors;
      if (Array.isArray(nested)) nested.forEach(collect);
      if (value.cause) collect(value.cause);
    };
    collect(error);
    if (/ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT|timeout/i.test(codes.join(' '))) {
      throw new Error(
        'Cannot reach the local database — start the stack first (pnpm dev:start), then re-run this command.'
      );
    }
    throw error;
  }
  if (!target) {
    throw new Error(
      `No user with email ${toEmail} — sign in on the device first, or pnpm dev:seed app:create-user`
    );
  }

  if (remove) {
    // Deletes only a SYNTHETIC row (a copy this tool wrote, or a stub seed),
    // so a mistyped email cannot destroy a real developer's connection in the
    // shared dev database. Reports exactly what was removed.
    const [existing] = await db
      .select({
        githubUserId: user_github_app_tokens.github_user_id,
        githubLogin: user_github_app_tokens.github_login,
      })
      .from(user_github_app_tokens)
      .where(
        and(
          eq(user_github_app_tokens.kilo_user_id, target.id),
          eq(user_github_app_tokens.github_app_type, 'standard')
        )
      )
      .limit(1);
    if (!existing) {
      return { targetEmail: toEmail, removedRows: 0, removed: 'nothing' };
    }
    if (!isSyntheticGithubUserId(existing.githubUserId)) {
      throw new Error(
        `Refusing to delete: ${toEmail} holds a REAL GitHub connection (${existing.githubLogin}, id ${existing.githubUserId}), not a copy or a stub seed. Disconnect it in the app if that is really what you want.`
      );
    }
    const deleted = await db
      .delete(user_github_app_tokens)
      .where(
        and(
          eq(user_github_app_tokens.kilo_user_id, target.id),
          eq(user_github_app_tokens.github_app_type, 'standard'),
          eq(user_github_app_tokens.github_user_id, existing.githubUserId)
        )
      )
      .returning({ id: user_github_app_tokens.id });
    return {
      targetEmail: toEmail,
      removedRows: deleted.length,
      removed:
        deleted.length > 0
          ? `${existing.githubLogin} (${existing.githubUserId})`
          : 'nothing — the row changed while this command ran',
    };
  }

  // Never overwrite a real connection the target account made itself: the
  // ciphertext is unrecoverable once replaced. Synthetic rows are ours.
  const [targetRow] = await db
    .select({
      githubUserId: user_github_app_tokens.github_user_id,
      githubLogin: user_github_app_tokens.github_login,
    })
    .from(user_github_app_tokens)
    .where(
      and(
        eq(user_github_app_tokens.kilo_user_id, target.id),
        eq(user_github_app_tokens.github_app_type, 'standard')
      )
    )
    .limit(1);
  if (targetRow && !isSyntheticGithubUserId(targetRow.githubUserId)) {
    throw new Error(
      `${toEmail} already holds a REAL GitHub connection (${targetRow.githubLogin}, id ${targetRow.githubUserId}); a copy would destroy it. Use a different account, or disconnect that connection in the app first.`
    );
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
        // The copy is usable only until git-token-service decides to refresh
        // it, which it does once the ACCESS token is inside a 5-minute
        // buffer. The copy's refresh token is a dummy, so that refresh fails
        // and revokes the copy. Require a real working window (35 minutes
        // leaves 30 usable) instead of handing back a copy that dies in
        // minutes.
        gt(user_github_app_tokens.access_token_expires_at, sql`now() + interval '35 minutes'`),
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
  for (const row of candidates) {
    let candidateToken: string;
    try {
      candidateToken = decryptKeyedEnvelope(
        row.access_token_encrypted,
        TOKEN_SCHEME,
        { active: { keyId, privateKeyPem } },
        tokenAad(row.kilo_user_id, row.github_user_id, 'access')
      );
    } catch {
      // Encrypted under a retired key — not usable as a donor; try the next.
      continue;
    }
    // Database metadata cannot prove a token still works: a rotation or a
    // GitHub-side revocation leaves the row looking fresh. Ask GitHub.
    let probe: Response;
    try {
      probe = await fetch('https://api.github.com/user', {
        headers: {
          authorization: `Bearer ${candidateToken}`,
          'user-agent': 'kilo-dev-seed-integration-copy',
        },
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      // No internet is an environment problem, not a dead donor: say so once
      // instead of walking the whole candidate list and reporting BLOCKED.
      throw new Error(
        'Cannot reach api.github.com to validate the donor token — check network access, then re-run this command.'
      );
    }
    if (!probe.ok) {
      console.log(
        `  skipping donor ${row.github_login}: GitHub rejected its access token (${probe.status})`
      );
      continue;
    }
    accessToken = candidateToken;
    source = row;
    break;
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

  // The copy carries a DUMMY refresh token on purpose: GitHub refresh tokens
  // rotate on use, so a copy holding the real one would kill the donor's
  // stored refresh token and poison every later copy. The cost is a bounded
  // lifetime — git-token-service refreshes once the access token is inside
  // its 5-minute buffer, that refresh is rejected, and the copy row is
  // marked revoked. That is the expected end state; run the copy again to
  // replace the revoked row (the upsert clears revoked_at).
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
      'e2e-copy-never-refreshes',
      TOKEN_SCHEME,
      { keyId, publicKeyPem },
      tokenAad(target.id, syntheticGithubUserId, 'refresh')
    ),
    refresh_token_expires_at: new Date(Date.now() - 1000).toISOString(),
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
      // The pre-check above is not atomic: a real OAuth callback can land
      // between it and this write. Re-assert synthetic-only here, so the
      // update itself can never destroy a real connection.
      setWhere: sql`${user_github_app_tokens.github_user_id} ~ '^[89][0-9]{12}$'`,
    })
    .returning({ id: user_github_app_tokens.id })
    .then(rows => {
      if (rows.length === 0) {
        throw new Error(
          `${toEmail} gained a REAL GitHub connection while this copy ran; nothing was written. Use a different account.`
        );
      }
    });

  // Usable until the service's refresh buffer opens, not until expiry.
  const usableUntil = new Date(
    new Date(source.access_token_expires_at).getTime() - 5 * 60 * 1000
  ).toISOString();
  return {
    targetEmail: toEmail,
    donorLogin: source.github_login,
    usableUntil,
    afterThat: 'the copy is revoked — run this command again',
  };
}
