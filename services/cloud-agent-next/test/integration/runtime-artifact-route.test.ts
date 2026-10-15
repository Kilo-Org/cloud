import { env, SELF, reset } from 'cloudflare:test';
import jwt from 'jsonwebtoken';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveSecret } from '../../src/auth.js';
import {
  decodeCloudflareProviderRef,
  encodeCloudflareProviderRef,
} from '../../src/sandbox-control/cloudflare-provider.js';
import { mintRuntimeArtifactGrant } from '../../src/sandbox-control/runtime-artifact-grant.js';
import {
  ArtifactConflictError,
  publishImmutableObject,
  r2ArtifactObjectStore,
  runtimeArtifactObjectKey,
  sha256Hex,
  type ArtifactObjectStore,
} from '../../src/sandbox-control/runtime-artifact-store.js';
import {
  loadRuntimeRelease,
  RuntimeInstallerError,
  type RuntimeArtifactReader,
  type RuntimeInstallerFailureReason,
} from '../../src/sandbox-control/runtime-release-loader.js';
import {
  runtimeArtifactHttpPath,
  type RuntimeInventoryEntry,
  type RuntimeReleaseDescriptor,
} from '../../src/shared/runtime-release.js';
import type { Env } from '../../src/types.js';

const CLI_SHA = 'a'.repeat(64);
const CONTROL_SHA = 'b'.repeat(64);
const OTHER_SHA = 'c'.repeat(64);
const bytes = new TextEncoder().encode('runtime cli payload');

const bindings = env as Env;

function objectUrl(sha256: string): string {
  return `https://example.com${runtimeArtifactHttpPath(sha256)}`;
}

async function grantHeader(hashes: [string, string] = [CLI_SHA, CONTROL_SHA]): Promise<string> {
  const secret = await resolveSecret(bindings.NEXTAUTH_SECRET);
  if (!secret) throw new Error('Test signing secret unavailable');
  return `Bearer ${mintRuntimeArtifactGrant({ hashes }, secret)}`;
}

beforeEach(async () => {
  await env.RUNTIME_RELEASE_BUCKET.put(runtimeArtifactObjectKey(CLI_SHA), bytes, {
    httpMetadata: { contentType: 'application/gzip' },
  });
});

afterEach(async () => {
  await env.RUNTIME_RELEASE_BUCKET.delete(runtimeArtifactObjectKey(CLI_SHA));
  await env.RUNTIME_RELEASE_BUCKET.delete(runtimeArtifactObjectKey(CONTROL_SHA));
  await reset();
});

describe('runtime artifact read route', () => {
  it('serves a granted hash from the object store', async () => {
    const response = await SELF.fetch(objectUrl(CLI_SHA), {
      headers: { Authorization: await grantHeader() },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  });

  it('reads release bytes even when the same key exists in session storage', async () => {
    const key = runtimeArtifactObjectKey(CLI_SHA);
    await env.R2_BUCKET.put(key, new TextEncoder().encode('session storage bytes'));
    try {
      const response = await SELF.fetch(objectUrl(CLI_SHA), {
        headers: { Authorization: await grantHeader() },
      });
      expect(response.status).toBe(200);
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    } finally {
      await env.R2_BUCKET.delete(key);
    }
  });

  it('never falls back to session storage when a release object is missing', async () => {
    const key = runtimeArtifactObjectKey(CLI_SHA);
    await env.RUNTIME_RELEASE_BUCKET.delete(key);
    await env.R2_BUCKET.put(key, bytes);
    try {
      const response = await SELF.fetch(objectUrl(CLI_SHA), {
        headers: { Authorization: await grantHeader() },
      });
      expect(response.status).toBe(404);
      expect(await env.R2_BUCKET.head(key)).not.toBeNull();
    } finally {
      await env.R2_BUCKET.delete(key);
    }
  });

  it('accepts a real provider-ref grant minted from the decoded allocation identity', async () => {
    // D measured the real encoded ref at 184 bytes; the grant schema caps
    // `allocationId` at 128, so the raw ref makes every real GET 401 (the C2
    // defect). The decoded instanceId is the one allocation identity.
    const encoded = encodeCloudflareProviderRef({
      sandboxId: 'sbx__workspace_11111111-1111-1111-1111-111111111111',
      containment: true,
      instanceId: '22222222-2222-2222-2222-222222222222',
    });
    expect(encoded.length).toBeGreaterThan(128);
    const decoded = decodeCloudflareProviderRef(encoded);
    const secret = await resolveSecret(bindings.NEXTAUTH_SECRET);
    const good = `Bearer ${mintRuntimeArtifactGrant({ hashes: [CLI_SHA, CONTROL_SHA], allocationId: decoded!.instanceId }, secret!)}`;
    const accepted = await SELF.fetch(objectUrl(CLI_SHA), { headers: { Authorization: good } });
    expect(accepted.status).toBe(200);

    const bad = `Bearer ${mintRuntimeArtifactGrant({ hashes: [CLI_SHA, CONTROL_SHA], allocationId: encoded }, secret!)}`;
    const rejected = await SELF.fetch(objectUrl(CLI_SHA), { headers: { Authorization: bad } });
    expect(rejected.status).toBe(401);
  });

  it('rejects a log-upload token and a missing grant', async () => {
    const secret = await resolveSecret(bindings.NEXTAUTH_SECRET);
    const logToken = jwt.sign({ type: 'control_log_upload' }, secret!, {
      algorithm: 'HS256',
      audience: 'cloud-agent-control-log-upload',
      expiresIn: 60,
    });
    const withLog = await SELF.fetch(objectUrl(CLI_SHA), {
      headers: { Authorization: `Bearer ${logToken}` },
    });
    expect(withLog.status).toBe(401);
    const anonymous = await SELF.fetch(objectUrl(CLI_SHA));
    expect(anonymous.status).toBe(401);
  });

  it('rejects a hash outside the two signed hashes', async () => {
    const response = await SELF.fetch(objectUrl(OTHER_SHA), {
      headers: { Authorization: await grantHeader() },
    });
    expect(response.status).toBe(403);
  });

  it('does not serve a granted hash that is not stored', async () => {
    const response = await SELF.fetch(objectUrl(CONTROL_SHA), {
      headers: { Authorization: await grantHeader() },
    });
    expect(response.status).toBe(404);
  });

  it('rejects traversal, extra path components, and a non-hash segment', async () => {
    const header = await grantHeader();
    for (const url of [
      'https://example.com/sandbox-artifacts/v1/objects/..%2f..%2fsecret',
      'https://example.com/sandbox-artifacts/v1/objects/aaaaaaaaaaaaaaaa',
      'https://example.com/sandbox-artifacts/v1/objects/' + CLI_SHA + '/extra',
      'https://example.com/sandbox-artifacts/v2/objects/' + CLI_SHA,
    ]) {
      const response = await SELF.fetch(url, { headers: { Authorization: header } });
      expect(response.status).toBe(404);
    }
  });

  it('rejects an expired grant', async () => {
    const secret = await resolveSecret(bindings.NEXTAUTH_SECRET);
    const expired = jwt.sign(
      { type: 'runtime_artifact_read', hashes: [CLI_SHA, CONTROL_SHA] },
      secret!,
      {
        algorithm: 'HS256',
        audience: 'cloud-agent-runtime-artifact-read',
        expiresIn: -10,
      }
    );
    const response = await SELF.fetch(objectUrl(CLI_SHA), {
      headers: { Authorization: `Bearer ${expired}` },
    });
    expect(response.status).toBe(401);
  });
});

describe('concurrent artifact publication on Miniflare R2', () => {
  const store = r2ArtifactObjectStore(env.RUNTIME_RELEASE_BUCKET);

  it('lets equivalent concurrent publishers succeed with exactly one create', async () => {
    const payload = new TextEncoder().encode('shared control bundle');
    const sha256 = await sha256Hex(payload);
    const key = runtimeArtifactObjectKey(sha256);
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        publishImmutableObject(store, {
          key,
          bytes: payload,
          expectedSha256: sha256,
          contentType: 'application/gzip',
        })
      )
    );
    expect(results).toHaveLength(4);
    expect(results.filter(result => result.created)).toHaveLength(1);
    expect(await store.getBytes(key)).toEqual(payload);
  });

  it('fails when a stored object conflicts with the published bytes', async () => {
    const payload = new TextEncoder().encode('expected bytes');
    const sha256 = await sha256Hex(payload);
    const key = runtimeArtifactObjectKey(sha256);
    await env.RUNTIME_RELEASE_BUCKET.put(key, new TextEncoder().encode('conflicting bytes'));
    await expect(
      publishImmutableObject(store, {
        key,
        bytes: payload,
        expectedSha256: sha256,
        contentType: 'application/gzip',
      })
    ).rejects.toBeInstanceOf(ArtifactConflictError);
  });

  it('re-reads a malicious successful put and rejects different stored bytes', async () => {
    const payload = new TextEncoder().encode('expected bytes');
    const sha256 = await sha256Hex(payload);
    const encoder = new TextEncoder();
    const lyingStore: ArtifactObjectStore = {
      async putIfAbsent() {
        return true;
      },
      async getBytes() {
        return encoder.encode('different bytes');
      },
    };
    await expect(
      publishImmutableObject(lyingStore, {
        key: runtimeArtifactObjectKey(sha256),
        bytes: payload,
        expectedSha256: sha256,
        contentType: 'application/gzip',
      })
    ).rejects.toBeInstanceOf(ArtifactConflictError);
  });
});

/**
 * Small genuine gzip tar fixtures, embedded as base64 so the loader is exercised
 * against real object payloads through Miniflare R2. The loader only hashes the
 * bytes; it does not decompress, so the archive contents are proof of a real
 * payload rather than a synthetic string.
 */
const CLI_TAR_BASE64 =
  'H4sIAHxHz2oAA+2ab2/SQBzHuyXGiI/18Rl9ZtLdtfenNdkDnCZDt6hj8c8jUqDbcNAilAXfiPH53oKPfeAr8wpUHIUVFu6m3O+TNAXS9toe37sPP2rXuuenllowxoIxNFpzPlpjh47X49cuIszhLqcuExRh4lBOLIQVn9eIQT8JevJUwovTMPq6eDu52cnJNccZXwr6s/5fuPPwrrVtWYdBA72poo9oQvqZdU8ujly+yCV9f7ncIcvHx0eTl+ke3+Vyf2aTrennDxpxxw663XZod3vxRRgFUSO0tratyx8/n/z6ljxbw0UCi3gbDPfDoBn2dtSNA4X5J3gm/9TBwkJDRedzBcPz72LUSVqdcJcIn/jcJ9Szue9zgYnLSkygg8rz8tHefuX9S3sYJEnPnhfX3fK7SjkW1aevDl9/aL6IS9RHVbnTwafrdvor46Xbvg+mIlO/o7qNovyneZmZ/10i889Un1iK4flP+9+u1VuRwjZW9z9XfgHA/7QA/mc0af6nDqhmHLiB/wkG/qeFBf7nc8/FLvjfxpPmX6ZeqQOu7n8u5uB/Whj7X7tVV9jGTfzPEeB/WgD/M5qr/qdmHCjMPxY5/+Mu+J8OHD/vfwJzzikXoH+bT5p/mfp/z/8Y+J8Osv63a404Snpx2/7cX3cb8n5wSlfxPzaq/4L/aQD8z2iy/E8dcP3jQGH+c/U/gSkD/9PBvPqf9D+PYuZ5IIAbT5Z/dbN/cf5l3mfnf4Lh/z8tTPod1QdRsx1CDE1j6v+tqBkObyX/ef+ngnLIvxbA/40m7//rHwcK85+r/3KGHfB/HSyq/8o+gPqvAWT5Vzf7L+H/Tm7+Zw6D+V8Hnbg5kLEMh924l/TRLiKQRZPInv+xa+etdqymDbzy8x+UcKj/6wH832iy/E/9f/3jQGH+c/V/JgjU/7Uwv/4vjczxKIcfABtPln91s/8Sz3/INzPPfwgK878WHj8adX//rBQ2zmKUfg0giwAAAAbwG5LQIpEARgAA';
const CONTROL_TAR_BASE64 =
  'H4sIAHxHz2oAAyvITtfPyUzS14tPzs8rKcrP0csqZqAyMDAwMDMxUQDR5mZmYNrACMI3gLCNFQxNjcyMzUyMTc1NFAwMTY0NzRkUDKjtEGygtLgksQjolNSy9NS8StzqgMrS0vCYA/GKApweKoBVjJ2BiYHBNzFZwT9YIUIBCkBiDJxAbATEhUAM4i8mzkjHkJAgKBOkYwYQc6MpYUSIiybn5+olFhTkpOoVFOWXpeYl5iWnMjAyMSzesk/l0LQSKyp4chTgAgXQ/B+QWOGRmpiSWqRP/XKAYP43NEDL/+YGJqYMChXUcgA+MMLzv7GBQm5JZm6qraG5paGlmaWhiYWeuYGZhYmBqYUFl6m5go+nk2OQs4dnmKteRWJJSZEetuxq6xjo6ZhvHqzt5esdnuKSz2ViqRAM1OQTiU8TUh7nGuhwGKkAlv9pV/sTzv/A/I5e/xsaGI7W//QA0HhXSCrNS8lJHc2Go2AUjIJRMFIAAMZofT0AEAAA';

function decodeBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

type LoaderFixture = {
  descriptor: RuntimeReleaseDescriptor;
  descriptorJson: string;
  cliBytes: Uint8Array;
  controlBytes: Uint8Array;
};

async function loaderFixture(): Promise<LoaderFixture> {
  const cliBytes = decodeBase64(CLI_TAR_BASE64);
  const controlBytes = decodeBase64(CONTROL_TAR_BASE64);
  const inventoryHash = (value: string) => sha256Hex(new TextEncoder().encode(value));
  const inventory: RuntimeInventoryEntry[] = [
    ['cli', 'pkg/bin/kilo', 0o100755, 30, await inventoryHash('kilo')],
    ['cli', 'pkg/lib/index.js', 0o100644, 20, await inventoryHash('index')],
    ['control', 'usr/local/bin/kilocode-wrapper.js', 0o100755, 20, await inventoryHash('wrapper')],
  ];
  const descriptor: RuntimeReleaseDescriptor = {
    format: 1,
    bootstrap: 1,
    platform: { os: 'linux', arch: 'x64', libc: 'glibc', cpu: 'baseline' },
    abi: 'kilo-runtime-base-v1',
    cliVersion: '7.8.1',
    cliExecutable: 'pkg/bin/kilo',
    wrapperSdkVersion: '7.8.1',
    protocol: 'control-plane-v1',
    artifacts: [
      {
        role: 'cli',
        sha256: await sha256Hex(cliBytes),
        transferBytes: cliBytes.byteLength,
        expandedBytes: 50,
        fileCount: 2,
      },
      {
        role: 'control',
        sha256: await sha256Hex(controlBytes),
        transferBytes: controlBytes.byteLength,
        expandedBytes: 20,
        fileCount: 1,
      },
    ],
    caps: { maxTransferBytes: 1_000_000, maxExpandedBytes: 1_000_000, maxFileCount: 100 },
    inventory,
  };
  return { descriptor, descriptorJson: JSON.stringify(descriptor), cliBytes, controlBytes };
}

async function loaderReasonOf(run: () => Promise<unknown>): Promise<RuntimeInstallerFailureReason> {
  try {
    await run();
  } catch (error) {
    if (!(error instanceof RuntimeInstallerError)) throw error;
    return error.reason;
  }
  throw new Error('expected the runtime release loader to fail');
}

describe('runtime release loader', () => {
  const keys = new Set<string>();

  afterEach(async () => {
    for (const key of keys) await env.RUNTIME_RELEASE_BUCKET.delete(key);
    keys.clear();
  });

  async function store(bytes: Uint8Array): Promise<string> {
    const sha = await sha256Hex(bytes);
    const key = runtimeArtifactObjectKey(sha);
    await env.RUNTIME_RELEASE_BUCKET.put(key, bytes);
    keys.add(key);
    return sha;
  }

  it('returns the verified release for a present descriptor and matching objects', async () => {
    const { descriptor, descriptorJson, cliBytes, controlBytes } = await loaderFixture();
    await store(cliBytes);
    await store(controlBytes);
    const loaded = await loadRuntimeRelease({
      reader: env.RUNTIME_RELEASE_BUCKET,
      descriptor: descriptorJson,
      deadlineAt: Date.now() + 5_000,
    });
    expect(loaded).toEqual(descriptor);
  });

  it('returns the explicit baked selection when the descriptor is absent', async () => {
    const loaded = await loadRuntimeRelease({
      reader: env.RUNTIME_RELEASE_BUCKET,
      descriptor: undefined,
      deadlineAt: Date.now() + 5_000,
    });
    expect(loaded).toBeNull();
  });

  it('fails a descriptor above the 64 KiB cap instead of returning the baked path', async () => {
    const reason = await loaderReasonOf(() =>
      loadRuntimeRelease({
        reader: env.RUNTIME_RELEASE_BUCKET,
        descriptor: 'a'.repeat(70_000),
        deadlineAt: Date.now() + 5_000,
      })
    );
    expect(reason).toBe('runtime_artifact_integrity');
  });

  it('fails a present descriptor that violates the release schema', async () => {
    const { descriptor } = await loaderFixture();
    const malformed = JSON.stringify({ ...descriptor, artifacts: [descriptor.artifacts[0]] });
    const reason = await loaderReasonOf(() =>
      loadRuntimeRelease({
        reader: env.RUNTIME_RELEASE_BUCKET,
        descriptor: malformed,
        deadlineAt: Date.now() + 5_000,
      })
    );
    expect(reason).toBe('runtime_artifact_integrity');
  });

  it('fails when the stored object size is not the declared transfer size', async () => {
    const { descriptor, controlBytes } = await loaderFixture();
    await store(controlBytes);
    const wrong = new TextEncoder().encode('too small');
    const wrongSha = await store(wrong);
    const descriptorJson = JSON.stringify({
      ...descriptor,
      artifacts: [{ ...descriptor.artifacts[0], sha256: wrongSha }, descriptor.artifacts[1]],
    });
    const reason = await loaderReasonOf(() =>
      loadRuntimeRelease({
        reader: env.RUNTIME_RELEASE_BUCKET,
        descriptor: descriptorJson,
        deadlineAt: Date.now() + 5_000,
      })
    );
    expect(reason).toBe('runtime_artifact_integrity');
  });

  it('fails when the stored object is missing', async () => {
    const { descriptorJson } = await loaderFixture();
    const reason = await loaderReasonOf(() =>
      loadRuntimeRelease({
        reader: env.RUNTIME_RELEASE_BUCKET,
        descriptor: descriptorJson,
        deadlineAt: Date.now() + 5_000,
      })
    );
    expect(reason).toBe('runtime_artifact_missing');
  });

  it('fails at the absolute deadline instead of checking the next object', async () => {
    const { descriptor, descriptorJson } = await loaderFixture();
    const reader: RuntimeArtifactReader = {
      async head() {
        await new Promise(resolve => setTimeout(resolve, 30));
        return { size: descriptor.artifacts[0].transferBytes };
      },
    };
    const reason = await loaderReasonOf(() =>
      loadRuntimeRelease({ reader, descriptor: descriptorJson, deadlineAt: Date.now() + 10 })
    );
    expect(reason).toBe('runtime_artifact_deadline');
  });

  it('checks both payloads by metadata only, without reading either body', async () => {
    const { descriptor, descriptorJson, cliBytes, controlBytes } = await loaderFixture();
    const cliKey = runtimeArtifactObjectKey(descriptor.artifacts[0].sha256);
    const events: string[] = [];
    const reader = {
      async head(key: string) {
        const role = key === cliKey ? 'cli' : 'control';
        events.push(`${role}:head`);
        return { size: role === 'cli' ? cliBytes.byteLength : controlBytes.byteLength };
      },
      async get(): Promise<never> {
        events.push('get');
        throw new Error('the preflight must not read a payload body');
      },
    };
    const loaded = await loadRuntimeRelease({
      reader,
      descriptor: descriptorJson,
      deadlineAt: Date.now() + 5_000,
    });
    expect(loaded).toEqual(descriptor);
    expect(events).toEqual(['cli:head', 'control:head']);
  });
});
