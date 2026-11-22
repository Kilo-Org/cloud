/**
 * Mints the sync grant that `authorize` accepts, using only `node:crypto`, so this proof
 * script needs no workspace dependency beyond the SDK it exercises.
 */
import { createHmac } from 'node:crypto';

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url');
}

export function syncGrant(input: {
  secret: string;
  userID: string;
  environment: string;
  ttlSeconds: number;
}): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64url(
    JSON.stringify({
      version: 1,
      tenant: { type: 'user', id: input.userID },
      env: input.environment,
      iss: 'session-sync',
      aud: 'session-sync',
      sub: input.userID,
      iat: now,
      exp: now + input.ttlSeconds,
    })
  );
  const signature = createHmac('sha256', input.secret)
    .update(`${header}.${payload}`)
    .digest('base64url');
  return `${header}.${payload}.${signature}`;
}
