import crypto from 'node:crypto';

// Generate a real Ed25519 keypair once for the whole test file. Tests sign
// fixtures with the private half and pin the public half via env var.
const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
const PUBLIC_PEM = publicKey.export({ type: 'spki', format: 'pem' }) as string;

// Derive the matching kid the way the signer / verifier do.
const PUBLIC_DER = publicKey.export({ type: 'spki', format: 'der' });
const EXPECTED_KID = crypto
  .createHash('sha256')
  .update(PUBLIC_DER)
  .digest('base64url')
  .slice(0, 16);

// Configure env BEFORE importing the module under test so the install
// fetcher's env lookups see the right key.
process.env.CLAWBYTE_SIGNING_PUBLIC_KEY = PUBLIC_PEM;

// eslint-disable-next-line import/first
import { fetchInstallPayload } from './install';

type RawPayload = {
  slug: string;
  title: string;
  description: string;
  prompt: string;
  signature?: string;
  signatureKeyId?: string;
  signedAt?: string;
  signatureVersion?: number;
};

function signPayload(
  base: Omit<RawPayload, 'signature' | 'signatureKeyId' | 'signedAt' | 'signatureVersion'>,
  overrides: Partial<Pick<RawPayload, 'signatureKeyId' | 'signedAt' | 'signatureVersion'>> = {},
  signWith: crypto.KeyObject = privateKey
): RawPayload {
  const signatureVersion = overrides.signatureVersion ?? 1;
  const signatureKeyId = overrides.signatureKeyId ?? EXPECTED_KID;
  const signedAt = overrides.signedAt ?? new Date().toISOString();
  const envelope = JSON.stringify({
    v: signatureVersion,
    kid: signatureKeyId,
    slug: base.slug,
    title: base.title,
    description: base.description,
    prompt: base.prompt,
    signedAt,
  });
  const signature = crypto.sign(null, Buffer.from(envelope, 'utf8'), signWith).toString('base64');
  return { ...base, signature, signatureKeyId, signedAt, signatureVersion };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const VALID_BASE = {
  slug: 'deep-research',
  title: 'Source Hunter',
  description: 'Deep research that finds primary sources.',
  prompt: 'Research [topic] for me.',
};

describe('fetchInstallPayload', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns the parsed payload for a valid signed response', async () => {
    const signed = signPayload(VALID_BASE);
    jest.spyOn(global, 'fetch').mockResolvedValue(jsonResponse(signed));

    const result = await fetchInstallPayload('byte', 'deep-research');

    expect(result).not.toBeNull();
    expect(result?.slug).toBe('deep-research');
    expect(result?.prompt).toBe('Research [topic] for me.');
    expect(result?.signatureKeyId).toBe(EXPECTED_KID);
  });

  it('reads cached by default and uncached when bypassCache is set', async () => {
    const signed = signPayload(VALID_BASE);
    // Fresh Response per call: a single Response body can only be read once.
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockImplementation(async () => jsonResponse(signed));

    await fetchInstallPayload('byte', 'deep-research');
    await fetchInstallPayload('byte', 'deep-research', { bypassCache: true });

    // Preview: short revalidate window. Dispatch: no-store, so a changed or
    // revoked byte is seen immediately rather than served from cache.
    expect(fetchSpy.mock.calls[0]![1]).toMatchObject({ next: { revalidate: 300 } });
    expect(fetchSpy.mock.calls[1]![1]).toMatchObject({ cache: 'no-store' });
  });

  it('returns null when upstream is 404', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response(null, { status: 404 }));
    const result = await fetchInstallPayload('byte', 'missing-slug');
    expect(result).toBeNull();
  });

  it('throws when upstream is non-OK and non-404', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response('boom', { status: 500 }));
    await expect(fetchInstallPayload('byte', 'deep-research')).rejects.toThrow(/500/);
  });

  it('rejects (does not follow) a redirect from the upstream origin (SSRF)', async () => {
    // With `redirect: 'error'`, the platform fetch rejects rather than
    // following a 3xx — so a compromised/abused trusted origin can't bounce
    // the fetch to an attacker host. Simulate that rejection.
    jest
      .spyOn(global, 'fetch')
      .mockRejectedValue(new TypeError('fetch failed: redirect mode is set to error'));
    await expect(fetchInstallPayload('byte', 'deep-research')).rejects.toThrow(
      /redirects are not followed/
    );
  });

  it('rejects payload signed by a different key (kid mismatch)', async () => {
    const { privateKey: foreignPriv, publicKey: foreignPub } =
      crypto.generateKeyPairSync('ed25519');
    const foreignKid = crypto
      .createHash('sha256')
      .update(foreignPub.export({ type: 'spki', format: 'der' }))
      .digest('base64url')
      .slice(0, 16);
    const signed = signPayload(VALID_BASE, { signatureKeyId: foreignKid }, foreignPriv);
    jest.spyOn(global, 'fetch').mockResolvedValue(jsonResponse(signed));
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const result = await fetchInstallPayload('byte', 'deep-research');

    expect(result).toBeNull();
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('key id mismatch'));
  });

  it('rejects tampered prompt (signature no longer verifies)', async () => {
    const signed = signPayload(VALID_BASE);
    const tampered = { ...signed, prompt: 'MALICIOUS PROMPT' };
    jest.spyOn(global, 'fetch').mockResolvedValue(jsonResponse(tampered));
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const result = await fetchInstallPayload('byte', 'deep-research');

    expect(result).toBeNull();
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('signature did not verify'));
  });

  it('rejects tampered title (signature no longer verifies)', async () => {
    const signed = signPayload(VALID_BASE);
    const tampered = { ...signed, title: 'Different Title' };
    jest.spyOn(global, 'fetch').mockResolvedValue(jsonResponse(tampered));
    jest.spyOn(console, 'error').mockImplementation(() => {});

    const result = await fetchInstallPayload('byte', 'deep-research');
    expect(result).toBeNull();
  });

  it('rejects an unsupported signature version', async () => {
    const signed = signPayload(VALID_BASE, { signatureVersion: 99 });
    jest.spyOn(global, 'fetch').mockResolvedValue(jsonResponse(signed));
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const result = await fetchInstallPayload('byte', 'deep-research');

    expect(result).toBeNull();
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('unsupported signature version'));
  });

  it('rejects a signature older than the TTL', async () => {
    const ancient = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    const signed = signPayload(VALID_BASE, { signedAt: ancient });
    jest.spyOn(global, 'fetch').mockResolvedValue(jsonResponse(signed));
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const result = await fetchInstallPayload('byte', 'deep-research');

    expect(result).toBeNull();
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('too old'));
  });

  it('rejects a signature with signedAt in the future', async () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // +1h
    const signed = signPayload(VALID_BASE, { signedAt: future });
    jest.spyOn(global, 'fetch').mockResolvedValue(jsonResponse(signed));
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const result = await fetchInstallPayload('byte', 'deep-research');

    expect(result).toBeNull();
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('in the future'));
  });

  it('returns null and logs on an unsigned (Zod-invalid) payload', async () => {
    // Treat schema-mismatched upstream responses as "unavailable" rather
    // than throwing — matches the "byte not found" UX so the page can
    // hand a single notFound() to the user.
    jest.spyOn(global, 'fetch').mockResolvedValue(jsonResponse(VALID_BASE));
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const result = await fetchInstallPayload('byte', 'deep-research');

    expect(result).toBeNull();
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('invalid upstream payload'));
  });

  it('rejects when signed payload.slug does not match the requested slug', async () => {
    // A validly-signed byte for a different slug — protects against CDN /
    // upstream swapping byte A's payload for a request targeting byte B.
    const signed = signPayload({ ...VALID_BASE, slug: 'different-byte' });
    jest.spyOn(global, 'fetch').mockResolvedValue(jsonResponse(signed));
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const result = await fetchInstallPayload('byte', 'deep-research');

    expect(result).toBeNull();
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('slug mismatch'));
  });

  it('returns null and logs when CLAWBYTE_SIGNING_PUBLIC_KEY is unset', async () => {
    // Treat missing/unparseable verifier config as a verification failure
    // rather than a thrown 500, so the install page returns a controlled
    // "not available" (the route surfaces null as notFound()) and ops can
    // distinguish it from "byte deleted upstream" via the log line.
    const saved = process.env.CLAWBYTE_SIGNING_PUBLIC_KEY;
    delete process.env.CLAWBYTE_SIGNING_PUBLIC_KEY;
    try {
      const signed = signPayload(VALID_BASE);
      jest.spyOn(global, 'fetch').mockResolvedValue(jsonResponse(signed));
      const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      const result = await fetchInstallPayload('byte', 'deep-research');

      expect(result).toBeNull();
      expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining('CLAWBYTE_SIGNING_PUBLIC_KEY is not configured')
      );
    } finally {
      process.env.CLAWBYTE_SIGNING_PUBLIC_KEY = saved;
    }
  });

  it('rejects an oversize upstream response', async () => {
    // Build a JSON body that exceeds MAX_RESPONSE_BYTES (256 KiB) so the
    // bounded reader bails out before Zod parsing even runs.
    const huge = 'x'.repeat(300 * 1024);
    const signed = signPayload({ ...VALID_BASE, description: huge });
    jest.spyOn(global, 'fetch').mockResolvedValue(jsonResponse(signed));
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const result = await fetchInstallPayload('byte', 'deep-research');

    expect(result).toBeNull();
    expect(errSpy).toHaveBeenCalledWith(expect.stringMatching(/exceeded \d+ bytes|exceeds limit/));
  });
});
