import { generateKeyPairSync } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { byoc_connections, createDrizzleClient, kilocode_users } from '@kilocode/db';
import {
  decryptKeyedEnvelope,
  encryptKeyedEnvelope,
  parseKeyedEnvelope,
} from '@kilocode/encryption';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const readEnv = (name: string) =>
  z.record(z.string(), z.string()).parse(parseEnv(readFileSync(path.join(root, name), 'utf8')));

function patchEnv(name: string, updates: Record<string, string>) {
  const filename = path.join(root, name);
  const lines = existsSync(filename) ? readFileSync(filename, 'utf8').split(/\r?\n/) : [];
  const kept = lines.filter(line => !Object.keys(updates).some(key => line.startsWith(`${key}=`)));
  while (kept.at(-1) === '') kept.pop();
  for (const [key, value] of Object.entries(updates)) kept.push(`${key}=${JSON.stringify(value)}`);
  writeFileSync(filename, `${kept.join('\n')}\n`, { mode: 0o600 });
  // `mode` applies only on creation; the file usually exists already.
  chmodSync(filename, 0o600);
}

class LocalSetupError extends Error {}

async function main() {
  const email = process.argv[2];
  if (!email) throw new LocalSetupError('Usage: setup-local-vercel.ts <local-user-email>');
  const env = readEnv('.env.local');
  const credentials = readEnv('.env.vercel-test.local');
  if (!credentials.VERCEL_TOKEN)
    throw new LocalSetupError('Set VERCEL_TOKEN in .env.vercel-test.local');
  const database = new URL(env.POSTGRES_URL);
  const manifest = z
    .object({ portOffset: z.number().int().nonnegative() })
    .parse(JSON.parse(readFileSync(path.join(root, 'dev/logs/manifest.json'), 'utf8')));
  if (
    !['localhost', '127.0.0.1'].includes(database.hostname) ||
    Number(database.port || 5432) !== 5432 + manifest.portOffset
  ) {
    throw new LocalSetupError('Database must be local and match this worktree port offset');
  }
  const { db, pool } = createDrizzleClient({ connectionString: database.href, ssl: false });
  try {
    const [user] = await db
      .select({ id: kilocode_users.id })
      .from(kilocode_users)
      .where(eq(kilocode_users.google_user_email, email));
    if (!user) throw new LocalSetupError('Local user does not exist');
    const [connection] = await db
      .select()
      .from(byoc_connections)
      .where(and(eq(byoc_connections.user_id, user.id), eq(byoc_connections.provider, 'vercel')));
    if (!connection)
      throw new LocalSetupError('Select a team and project in local Compute settings first');
    const projectId = credentials.VERCEL_PROJECT_ID || connection.config.project_id;
    const teamId = credentials.VERCEL_TEAM_ID || connection.config.team_id;
    if (
      typeof projectId !== 'string' ||
      typeof teamId !== 'string' ||
      projectId !== connection.config.project_id ||
      teamId !== connection.config.team_id
    ) {
      throw new LocalSetupError('Token file selection must match the local Compute settings');
    }
    const url = new URL(`https://api.vercel.com/v9/projects/${encodeURIComponent(projectId)}`);
    if (connection.config.token_scope !== 'project') url.searchParams.set('teamId', teamId);
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${credentials.VERCEL_TOKEN}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok)
      throw new LocalSetupError(`Vercel project access failed: HTTP ${response.status}`);
    const worker = readEnv('services/cloud-agent-next/.dev.vars');
    const keyFile = '.env.vercel-test.keys.local';
    let keys = existsSync(path.join(root, keyFile)) ? readEnv(keyFile) : undefined;
    if (
      worker.AGENT_ENV_VARS_PRIVATE_KEY &&
      worker.AGENT_ENV_VARS_PRIVATE_KEY !== keys?.AGENT_ENV_VARS_PRIVATE_KEY
    ) {
      throw new LocalSetupError('Refusing to replace an existing unrelated worker encryption key');
    }
    if (!keys) {
      const pair = generateKeyPairSync('rsa', {
        modulusLength: 4096,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      });
      keys = {
        AGENT_ENV_VARS_PRIVATE_KEY: pair.privateKey,
        AGENT_ENV_VARS_PUBLIC_KEY: Buffer.from(pair.publicKey).toString('base64'),
      };
      patchEnv(keyFile, keys);
    }
    const scheme = 'byoc-vercel-credential-rsa-aes-256-gcm';
    const aad = `byoc-vercel-credential:v1:user:${user.id}:${connection.id}`;
    const envelope = encryptKeyedEnvelope(
      credentials.VERCEL_TOKEN,
      scheme,
      {
        keyId: 'agent-env-vars-v1',
        publicKeyPem: Buffer.from(keys.AGENT_ENV_VARS_PUBLIC_KEY, 'base64'),
      },
      aad
    );
    const decrypted = decryptKeyedEnvelope(
      envelope,
      scheme,
      {
        active: {
          keyId: 'agent-env-vars-v1',
          privateKeyPem: keys.AGENT_ENV_VARS_PRIVATE_KEY,
        },
      },
      aad
    );
    if (decrypted !== credentials.VERCEL_TOKEN)
      throw new LocalSetupError('Encryption round trip failed');
    const ids = new Set((worker.BYOC_VERCEL_IDS || '').split(',').filter(Boolean));
    ids.add(user.id);
    patchEnv('services/cloud-agent-next/.dev.vars', {
      AGENT_ENV_VARS_PRIVATE_KEY: keys.AGENT_ENV_VARS_PRIVATE_KEY,
      BYOC_VERCEL_IDS: [...ids].join(','),
    });
    patchEnv('apps/web/.env.development.local', {
      AGENT_ENV_VARS_PUBLIC_KEY: keys.AGENT_ENV_VARS_PUBLIC_KEY,
    });
    await db
      .update(byoc_connections)
      .set({
        credentials_encrypted: parseKeyedEnvelope(envelope, scheme),
      })
      .where(eq(byoc_connections.id, connection.id));
    console.log('Project access and encryption round trip passed. Local credential repaired.');
    console.log('Restart nextjs and cloud-agent-next, then click Retry setup in Compute settings.');
  } finally {
    await pool.end();
  }
}

main().catch(error => {
  // Do not print provider responses or database errors, which can include credentials.
  console.error(
    error instanceof LocalSetupError
      ? error.message
      : 'Local Vercel setup failed. Check local configuration and the selected owner.'
  );
  process.exitCode = 1;
});
