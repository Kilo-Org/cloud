import crypto from 'node:crypto';
import { z } from 'zod';
import { MESSAGE_TEXT_MAX_CHARS } from '@kilocode/kilo-chat';
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

// Bound the upstream response so a malicious or misbehaving source can't
// force us to buffer and parse arbitrarily large JSON before Zod's per-
// field caps fire. 256 KiB is well above any realistic signed byte
// payload (`prompt` is capped at 32k, `description` at 2k, body etc. are
// dropped by Zod) and well below memory-pressure thresholds for a Vercel
// serverless render.
const MAX_RESPONSE_BYTES = 256 * 1024;

// IMPORTANT: this schema intentionally contains ONLY fields that are covered
// by the Ed25519 signature (slug/title/description/prompt — see
// `canonicalEnvelopeString`) plus the signature metadata itself. Marketing-
// only fields the signer leaves unsigned (tagline, category, tags, body,
// ratings, …) are deliberately NOT modelled here: Zod strips them on parse,
// so it is impossible to render unsigned, tamperable content in the install
// preview. Do not add an unsigned field here without also adding it to the
// signed envelope on both the signer (kilocode-landing) and the verifier.
const installPayloadSchema = z.object({
  slug: z.string().min(1).max(200),
  title: z.string().max(500),
  description: z.string().max(2000),
  // Cap matches `MESSAGE_TEXT_MAX_CHARS` in @kilocode/kilo-chat so a valid
  // signed payload can't pass install verification only to fail downstream
  // as `invalid_request` when kilo-chat enforces its per-text-block limit.
  prompt: z.string().min(1).max(MESSAGE_TEXT_MAX_CHARS),
  // Signature fields. All four are required — an unsigned payload fails
  // Zod parsing before reaching the crypto verify step.
  signature: z.string().min(1).max(200), // base64 Ed25519 sig (~88 chars)
  signatureKeyId: z.string().min(1).max(64),
  signedAt: z.string().datetime(),
  signatureVersion: z.number().int().positive(),
});

export type InstallPayload = z.infer<typeof installPayloadSchema>;

function getPublicKey(): crypto.KeyObject | null {
  const raw = process.env.CLAWBYTE_SIGNING_PUBLIC_KEY;
  if (!raw) return null;
  const pem = raw.replace(/\\n/g, '\n').trim();
  try {
    return crypto.createPublicKey({ key: pem, format: 'pem' });
  } catch {
    return null;
  }
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
  if (!publicKey) {
    return {
      ok: false,
      reason:
        'CLAWBYTE_SIGNING_PUBLIC_KEY is not configured or unparseable — verification unavailable',
    };
  }
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

/**
 * Read a response body as text, but bail out if it exceeds `maxBytes`.
 * Returns null on overflow (caller logs and rejects).
 */
async function readBoundedText(res: Response, maxBytes: number): Promise<string | null> {
  if (!res.body) {
    // No streamable body (some Response shims / edge stubs). Still enforce the
    // cap: buffer the whole body, then reject if it overflows.
    const buf = await res.arrayBuffer();
    if (buf.byteLength > maxBytes) return null;
    return new TextDecoder('utf-8').decode(buf);
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        // Free the buffer; we're throwing this body away.
        chunks.length = 0;
        try {
          await reader.cancel();
        } catch {
          // Cancel may reject if the stream is already terminating; safe to ignore.
        }
        return null;
      }
      chunks.push(value);
    }
  }
  // Concatenate and decode as UTF-8.
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder('utf-8').decode(merged);
}

export async function fetchInstallPayload(
  source: InstallSource,
  slug: string,
  opts: { bypassCache?: boolean } = {}
): Promise<InstallPayload | null> {
  const url = INSTALL_SOURCES[source].urlTemplate.replace('{slug}', encodeURIComponent(slug));
  // `redirect: 'error'` is SSRF defense in depth: the host comes from the
  // registry (not user input) and the slug is encoded into a single path
  // segment, so a request can't target an off-registry origin directly. The
  // one residual path would be the trusted origin itself answering 3xx to an
  // attacker host; refusing to follow redirects closes that before the
  // signature check even runs. A redirect now rejects (caught below).
  //
  // Caching: the preview render uses a short revalidate window so repeated
  // page loads are cheap. The CONFIRM-TIME dispatch passes `bypassCache` for an
  // uncached read, so a byte that was changed, revoked, or deleted upstream
  // takes effect immediately (a stale cached payload would otherwise still
  // match the reviewed signature and dispatch within the revalidate window).
  const fetchInit: RequestInit = opts.bypassCache
    ? { cache: 'no-store', redirect: 'error' }
    : { next: { revalidate: 300 }, redirect: 'error' };
  let res: Response;
  try {
    res = await fetch(url, fetchInit);
  } catch (err) {
    throw new Error(
      `fetchInstallPayload(${source}, ${slug}): request failed (redirects are not followed): ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`fetchInstallPayload(${source}, ${slug}): ${res.status} ${res.statusText}`);
  }

  // Fast-path reject when the server tells us the body is too big. Not all
  // upstreams send a reliable Content-Length, so we still bound the body
  // read below.
  const declaredLength = Number(res.headers.get('content-length') ?? '');
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    console.error(
      `[install] upstream Content-Length ${declaredLength} exceeds limit ${MAX_RESPONSE_BYTES} for ${source}/${slug}`
    );
    return null;
  }

  // Read as text with an explicit size cap so we never buffer a runaway
  // body. (`res.text()` would buffer the whole stream first.) Parse JSON
  // ourselves only after the size check passes.
  const text = await readBoundedText(res, MAX_RESPONSE_BYTES);
  if (text === null) {
    console.error(
      `[install] upstream response exceeded ${MAX_RESPONSE_BYTES} bytes for ${source}/${slug}`
    );
    return null;
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `fetchInstallPayload(${source}, ${slug}): upstream returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  // safeParse rather than parse: an unsigned, malformed, or
  // rollout-mismatched upstream payload must not throw a 500 — collapse
  // it into the same null-return path as "not found" so the page surfaces
  // a controlled `notFound()`.
  const parsed = installPayloadSchema.safeParse(json);
  if (!parsed.success) {
    console.error(
      `[install] invalid upstream payload for ${source}/${slug}: ${parsed.error.message}`
    );
    return null;
  }
  const payload = parsed.data;

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

  // The signature covers `payload.slug`, but we also need to bind that slug
  // to the slug the user actually requested. Otherwise a CDN/cache/object-
  // path swap (or a malicious intermediary serving a different validly-
  // signed byte for the requested URL) would let one byte's install
  // dispatch under another byte's name.
  if (payload.slug !== slug) {
    console.error(
      `[install] slug mismatch for ${source}/${slug}: signed payload is for "${payload.slug}"`
    );
    return null;
  }

  return payload;
}
