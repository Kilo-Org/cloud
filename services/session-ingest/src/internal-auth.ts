import type { Env } from './env';

async function digestSecret(secret: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
}

export async function hasValidInternalSecret(request: Request, env: Env): Promise<boolean> {
  const provided = request.headers.get('X-Internal-Secret');
  const expected = await env.INTERNAL_API_SECRET_PROD.get();
  if (!provided || !expected) return false;

  const [providedDigest, expectedDigest] = await Promise.all([
    digestSecret(provided),
    digestSecret(expected),
  ]);
  return crypto.subtle.timingSafeEqual(providedDigest, expectedDigest);
}
