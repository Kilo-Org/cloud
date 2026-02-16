import { z } from 'zod';

export const AgentJWTPayload = z.object({
  agentId: z.string(),
  rigId: z.string(),
  townId: z.string(),
  userId: z.string(),
});

export type AgentJWTPayload = z.infer<typeof AgentJWTPayload>;

export async function verifyAgentJWT(
  token: string,
  secret: string
): Promise<{ success: true; payload: AgentJWTPayload } | { success: false; error: string }> {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) {
      return { success: false, error: 'Malformed JWT' };
    }

    const [headerB64, payloadB64, signatureB64] = parts;

    // Verify signature
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    );

    const signatureBytes = base64UrlDecode(signatureB64);
    const dataBytes = new TextEncoder().encode(`${headerB64}.${payloadB64}`);

    const valid = await crypto.subtle.verify('HMAC', key, signatureBytes, dataBytes);
    if (!valid) {
      return { success: false, error: 'Invalid token signature' };
    }

    // Decode header and check algorithm
    const header = JSON.parse(new TextDecoder().decode(base64UrlDecode(headerB64)));
    if (header.alg !== 'HS256') {
      return { success: false, error: `Unsupported algorithm: ${header.alg}` };
    }

    // Decode and validate payload
    const rawPayload = JSON.parse(new TextDecoder().decode(base64UrlDecode(payloadB64)));

    // Check expiration
    if (typeof rawPayload.exp === 'number' && rawPayload.exp < Math.floor(Date.now() / 1000)) {
      return { success: false, error: 'Token expired' };
    }

    const parsed = AgentJWTPayload.safeParse(rawPayload);
    if (!parsed.success) {
      return { success: false, error: 'Invalid token payload' };
    }

    return { success: true, payload: parsed.data };
  } catch {
    return { success: false, error: 'Token validation failed' };
  }
}

export async function signAgentJWT(
  payload: AgentJWTPayload,
  secret: string,
  expiresInSeconds: number = 3600
): Promise<string> {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);

  const fullPayload = {
    ...payload,
    iat: now,
    exp: now + expiresInSeconds,
  };

  const headerB64 = base64UrlEncode(JSON.stringify(header));
  const payloadB64 = base64UrlEncode(JSON.stringify(fullPayload));

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${headerB64}.${payloadB64}`)
  );

  return `${headerB64}.${payloadB64}.${base64UrlEncodeBuffer(signature)}`;
}

function base64UrlDecode(str: string): Uint8Array {
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function base64UrlEncode(str: string): string {
  const bytes = new TextEncoder().encode(str);
  const base64 = btoa(String.fromCharCode(...bytes));
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlEncodeBuffer(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const base64 = btoa(String.fromCharCode(...bytes));
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
