import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { fixtureRuntime } from '../../test/runtime-installer/fixtures.js';
import { loadRuntimeRelease, type RuntimeArtifactReader } from './runtime-release-loader.js';
import { downloadedStartup } from './downloaded-startup.js';
import { RUNTIME_DESCRIPTOR_MAX_BYTES, serializeRuntimeRelease } from './runtime-release.js';
import { runtimeArtifactObjectKey, runtimeArtifactReleaseKey } from './runtime-artifact-keys.js';

async function fixture() {
  const packaged = await fixtureRuntime();
  const bytes = serializeRuntimeRelease(packaged.descriptor);
  const hash = createHash('sha256').update(bytes).digest('hex');
  const reads: string[] = [];
  const heads: string[] = [];
  const reader: RuntimeArtifactReader = {
    async get(key) {
      reads.push(key);
      return {
        size: bytes.byteLength,
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        }),
      };
    },
    async head(key) {
      heads.push(key);
      const artifact = packaged.descriptor.artifacts.find(
        item => runtimeArtifactObjectKey(item.sha256) === key
      );
      return artifact ? { size: artifact.transferBytes } : null;
    },
  };
  return { packaged, bytes, hash, reader, reads, heads };
}

describe('private descriptor references', () => {
  it('verifies descriptor bytes from R2 before checking payload metadata', async () => {
    const f = await fixture();
    await expect(loadRuntimeRelease(f.hash, f.reader)).resolves.toEqual(f.packaged.descriptor);
    expect(f.reads).toEqual([runtimeArtifactReleaseKey(f.hash)]);
    expect(f.heads).toEqual(
      f.packaged.descriptor.artifacts.map(item => runtimeArtifactObjectKey(item.sha256))
    );
  });

  it('renders the full installer descriptor when the configured value is only its hash', async () => {
    const f = await fixture();
    const command = await downloadedStartup({
      env: {
        WORKER_URL: 'https://worker.test',
        NEXTAUTH_SECRET: 'test-secret',
        RUNTIME_RELEASE_BUCKET: f.reader as R2Bucket,
      },
      descriptor: f.hash,
      sandboxId: 'sbx_fixture',
      allocationId: crypto.randomUUID(),
      deadlineAt: Date.now() + 300000,
    });
    // Check only booleans so failed assertions cannot print the short-lived grant.
    expect(command.argv.some(value => value.includes(f.packaged.descriptor.cliExecutable))).toBe(
      true
    );
    expect(f.reads).toEqual([runtimeArtifactReleaseKey(f.hash)]);
  });

  it('rejects a missing or substituted descriptor before payload reads', async () => {
    const f = await fixture();
    await expect(loadRuntimeRelease('c'.repeat(64), f.reader)).rejects.toMatchObject({
      permanentReason: 'invalid_configuration',
    });
    expect(f.heads).toEqual([]);
    await expect(
      loadRuntimeRelease(f.hash, {
        ...f.reader,
        async get() {
          return null;
        },
      })
    ).rejects.toMatchObject({ permanentReason: 'invalid_configuration' });
  });

  it('bounds and cancels an oversized stream even when its reported size is small', async () => {
    const f = await fixture();
    let cancelled = false;
    const reader: RuntimeArtifactReader = {
      ...f.reader,
      async get() {
        return {
          size: 1,
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(RUNTIME_DESCRIPTOR_MAX_BYTES + 1));
            },
            cancel() {
              cancelled = true;
            },
          }),
        };
      },
    };
    await expect(loadRuntimeRelease(f.hash, reader)).rejects.toMatchObject({
      permanentReason: 'invalid_configuration',
    });
    expect(cancelled).toBe(true);
    expect(f.heads).toEqual([]);
  });

  it('keeps descriptor storage errors transient and accepts existing inline allocations', async () => {
    const f = await fixture();
    await expect(
      loadRuntimeRelease(f.hash, {
        ...f.reader,
        async get() {
          throw new Error('storage unavailable');
        },
      })
    ).rejects.toThrow('storage unavailable');
    await expect(
      loadRuntimeRelease(new TextDecoder().decode(f.bytes), { head: key => f.reader.head(key) })
    ).resolves.toEqual(f.packaged.descriptor);
    expect(f.reads).toEqual([]);
  });
});
