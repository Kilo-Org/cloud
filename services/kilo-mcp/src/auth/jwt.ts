/**
 * Minimal HS256 (HMAC-SHA256) JWT primitives over WebCrypto — the only
 * asymmetric-free signature the MCP access token needs (the worker both mints
 * and verifies it). Deliberately not a general JWT library: single header,
 * single algorithm, strict parsing.
 */
import { base64UrlDecode, base64UrlEncode, constantTimeBytesEqual } from './pkce';

const JWT_HEADER = { alg: 'HS256', typ: 'JWT' } as const;

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
}

async function signSegments(signingInput: string, secret: string): Promise<Uint8Array> {
  const signature = await crypto.subtle.sign(
    'HMAC',
    await hmacKey(secret),
    new TextEncoder().encode(signingInput)
  );
  return new Uint8Array(signature);
}

/** Compact HS256 JWT for the given claims. Never log the result: it is a bearer token. */
export async function signJwt(claims: Record<string, unknown>, secret: string): Promise<string> {
  const header = base64UrlEncode(new TextEncoder().encode(JSON.stringify(JWT_HEADER)));
  const payload = base64UrlEncode(new TextEncoder().encode(JSON.stringify(claims)));
  const signature = await signSegments(`${header}.${payload}`, secret);
  return `${header}.${payload}.${base64UrlEncode(signature)}`;
}

export type DecodedJwt = {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  signingInput: string;
  signature: Uint8Array;
};

/** Strict compact-JWS parse. Returns null on any shape violation (no throw on hostile input). */
export function decodeJwt(token: string): DecodedJwt | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, signatureB64] = parts;
  const headerBytes = base64UrlDecode(headerB64);
  const payloadBytes = base64UrlDecode(payloadB64);
  const signature = signatureBytes(signatureB64);
  if (!headerBytes || !payloadBytes || !signature) return null;
  let header: unknown;
  let payload: unknown;
  try {
    header = JSON.parse(new TextDecoder().decode(headerBytes));
    payload = JSON.parse(new TextDecoder().decode(payloadBytes));
  } catch {
    return null;
  }
  if (!isPlainObject(header) || !isPlainObject(payload)) return null;
  if (header.alg !== 'HS256' || header.typ !== 'JWT') return null;
  return { header, payload, signingInput: `${headerB64}.${payloadB64}`, signature };
}

/** Recompute the HMAC and compare in constant time. */
export async function verifyJwtSignature(decoded: DecodedJwt, secret: string): Promise<boolean> {
  const expected = await signSegments(decoded.signingInput, secret);
  return constantTimeBytesEqual(expected, decoded.signature);
}

function signatureBytes(value: string): Uint8Array | null {
  // An HS256 signature is exactly 32 bytes; reject anything else before parsing.
  const bytes = base64UrlDecode(value);
  if (!bytes || bytes.length !== 32) return null;
  return bytes;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
