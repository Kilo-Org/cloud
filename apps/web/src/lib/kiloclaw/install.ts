import crypto from 'node:crypto';
import { z } from 'zod';
import { INSTALL_SOURCES, type InstallSource } from './install-sources';

/**
 * Ed25519 signature verification for install payloads.
 *
 * The signed envelope and key-id derivation match the signer's exact shape
 * in kilocode-landing's `src/lib/crabbytes-signing.ts`. If you change either
 * side (envelope fields, key order, kid derivation), update both files
 * together — otherwise verification will silently fail.
 */
const SUPPORTED_SIGNATURE_VERSION = 1;

// Reject signatures older than this. Prevents an attacker who manages to
// capture a one-time signed payload from replaying it indefinitely after a
// later key rotation or content takedown. 30 days is generous; tighten if
// the byte catalog churns frequently.
const MAX_SIGNATURE_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const installPayloadSchema = z.object({
  slug: z.string().min(1).max(200),
  title: z.string().max(500),
  description: z.string().max(2000),
  prompt: z.string().min(1).max(32000),
  tagline: z.string().max(500).optional(),
  category: z.string().max(100).optional(),
  tags: z.array(z.string().max(100)).max(50).optional(),
  // Signature fields. All four are required — an unsigned payload fails
  // Zod parsing before reaching the crypto verify step.
  signature: z.string().min(1).max(200), // base64 Ed25519 sig (~88 chars)
  signatureKeyId: z.string().min(1).max(64),
  signedAt: z.string().datetime(),
  signatureVersion: z.number().int().positive(),
});

export type InstallPayload = z.infer<typeof installPayloadSchema>;

function getPublicKey(): crypto.KeyObject {
  const raw = process.env.CLAWBYTE_SIGNING_PUBLIC_KEY;
  if (!raw) {
    throw new Error(
      'CLAWBYTE_SIGNING_PUBLIC_KEY is not configured — install payloads cannot be verified'
    );
  }
  const pem = raw.replace(/\\n/g, '\n').trim();
  return crypto.createPublicKey({ key: pem, format: 'pem' });
}

function deriveKeyId(publicKey: crypto.KeyObject): string {
  const der = publicKey.export({ type: 'spki', format: 'der' });
  return crypto.createHash('sha256').update(der).digest('base64url').slice(0, 16);
}

function canonicalEnvelopeString(payload: InstallPayload): string {
  // MUST match the signer's exact key order. Append-only if the envelope
  // evolves; bump SUPPORTED_SIGNATURE_VERSION alongside the change.
  return JSON.stringify({
    v: payload.signatureVersion,
    kid: payload.signatureKeyId,
    slug: payload.slug,
    title: payload.title,
    description: payload.description,
    prompt: payload.prompt,
    signedAt: payload.signedAt,
  });
}

type VerifyOk = { ok: true };
type VerifyErr = { ok: false; reason: string };

function verifySignedPayload(payload: InstallPayload): VerifyOk | VerifyErr {
  if (payload.signatureVersion !== SUPPORTED_SIGNATURE_VERSION) {
    return {
      ok: false,
      reason: `unsupported signature version ${payload.signatureVersion} (expected ${SUPPORTED_SIGNATURE_VERSION})`,
    };
  }

  const ageMs = Date.now() - Date.parse(payload.signedAt);
  if (!Number.isFinite(ageMs)) {
    return { ok: false, reason: 'signedAt is not a valid date' };
  }
  if (ageMs > MAX_SIGNATURE_AGE_MS) {
    return { ok: false, reason: `signature too old (signedAt=${payload.signedAt})` };
  }
  if (ageMs < -5 * 60 * 1000) {
    // Allow ~5 min of clock skew either way; anything further in the future
    // is suspicious.
    return { ok: false, reason: `signedAt is in the future (signedAt=${payload.signedAt})` };
  }

  const publicKey = getPublicKey();
  const expectedKid = deriveKeyId(publicKey);
  if (payload.signatureKeyId !== expectedKid) {
    return {
      ok: false,
      reason: `signature key id mismatch (payload=${payload.signatureKeyId}, pinned=${expectedKid})`,
    };
  }

  const canonical = canonicalEnvelopeString(payload);
  const sigBytes = Buffer.from(payload.signature, 'base64');
  const valid = crypto.verify(null, Buffer.from(canonical, 'utf8'), publicKey, sigBytes);
  if (!valid) {
    return { ok: false, reason: 'Ed25519 signature did not verify against pinned public key' };
  }

  return { ok: true };
}

export async function fetchInstallPayload(
  source: InstallSource,
  slug: string
): Promise<InstallPayload | null> {
  const url = INSTALL_SOURCES[source].urlTemplate.replace('{slug}', encodeURIComponent(slug));
  const res = await fetch(url, { next: { revalidate: 300 } });

  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`fetchInstallPayload(${source}, ${slug}): ${res.status} ${res.statusText}`);
  }

  const json = await res.json();
  const payload = installPayloadSchema.parse(json);

  const verify = verifySignedPayload(payload);
  if (!verify.ok) {
    // Treat verification failure as a hard reject — the caller surfaces
    // this as an install-not-allowed error to the user. Logging the reason
    // server-side so on-call can distinguish "byte deleted upstream" (404)
    // from "byte tampered or key rotated" (verify failure).
    console.error(
      `[install] signature verification failed for ${source}/${slug}: ${verify.reason}`
    );
    return null;
  }

  return payload;
}
