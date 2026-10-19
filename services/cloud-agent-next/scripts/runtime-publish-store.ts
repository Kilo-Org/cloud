import path from 'node:path';
import { getPlatformProxy } from 'wrangler';
import { AwsClient } from 'aws4fetch';
import { z } from 'zod';
import type { ArtifactObjectStore } from '../src/sandbox-control/runtime-artifact-keys.js';
import {
  RUNTIME_HARD_MAX_TRANSFER_BYTES,
  RUNTIME_DESCRIPTOR_MAX_BYTES,
} from '../src/sandbox-control/runtime-release.js';

export function remoteArtifactStore(options: {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  request?: typeof fetch;
}): ArtifactObjectStore {
  z.string()
    .regex(/^[a-f0-9]{32}$/)
    .parse(options.accountId);
  z.string()
    .regex(/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/)
    .parse(options.bucket);
  const signer = new AwsClient({
    accessKeyId: options.accessKeyId,
    secretAccessKey: options.secretAccessKey,
    service: 's3',
    region: 'auto',
  });
  const request = options.request ?? fetch;
  const send = async (key: string, method: string, bytes?: Uint8Array, contentType?: string) => {
    if (!/^runtime-artifacts\/v1\/[a-z0-9/._-]+$/.test(key) || key.includes('..')) {
      throw new Error('invalid runtime artifact key');
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const signed = await signer.sign(
          `https://${options.accountId}.r2.cloudflarestorage.com/${options.bucket}/${key}`,
          {
            method,
            ...(bytes
              ? {
                  body: new Uint8Array(bytes).buffer,
                  headers: {
                    'If-None-Match': '*',
                    'Content-Type': contentType ?? 'application/json',
                  },
                }
              : {}),
          }
        );
        const response = await request(signed, { signal: AbortSignal.timeout(60_000) });
        if (response.status === 429 || response.status >= 500) {
          await response.body?.cancel();
          if (attempt < 2) continue;
        }
        return response;
      } catch {
        if (attempt === 2) throw new Error(`runtime store ${method} request failed`);
      }
    }
    throw new Error(`runtime store ${method} retry limit reached`);
  };
  return {
    async putIfAbsent(key, bytes, contentType) {
      const existing = await send(key, 'HEAD');
      if (existing.ok) return false;
      if (existing.status !== 404)
        throw new Error(`runtime store HEAD failed (${existing.status})`);
      const response = await send(key, 'PUT', bytes, contentType);
      await response.body?.cancel();
      if (response.status === 412) return false;
      if (!response.ok) throw new Error(`runtime store PUT failed (${response.status})`);
      return true;
    },
    async getBytes(key) {
      const response = await send(key, 'GET');
      if (response.status === 404) {
        await response.body?.cancel();
        return null;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`runtime store GET failed (${response.status})`);
      }
      if (!response.body) throw new Error('runtime store returned no object body');
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      const cap = key.includes('/objects/')
        ? RUNTIME_HARD_MAX_TRANSFER_BYTES
        : RUNTIME_DESCRIPTOR_MAX_BYTES;
      try {
        for (;;) {
          const result = await reader.read();
          if (result.done) break;
          const chunk: unknown = result.value;
          if (!(chunk instanceof Uint8Array))
            throw new Error('runtime store returned a non-binary chunk');
          size += chunk.byteLength;
          if (size > cap) throw new Error('runtime store object exceeds its byte cap');
          chunks.push(chunk);
        }
      } finally {
        await reader.cancel();
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return bytes;
    },
  };
}

/** Use the same private bucket API and persistence as local Wrangler development. */
export async function localR2ArtifactStore(packageRoot: string) {
  const platform = await getPlatformProxy<{ RUNTIME_RELEASE_BUCKET?: R2Bucket }>({
    configPath: path.join(packageRoot, 'wrangler.jsonc'),
    environment: 'dev',
    persist: { path: path.join(packageRoot, '.wrangler/state/v3') },
    remoteBindings: false,
  });
  const bucket = platform.env.RUNTIME_RELEASE_BUCKET;
  if (!bucket) {
    await platform.dispose();
    throw new Error('Local runtime bucket is not configured');
  }
  const store: ArtifactObjectStore = {
    async putIfAbsent(key, bytes, contentType) {
      return (
        (await bucket.put(key, new Uint8Array(bytes), {
          onlyIf: { etagDoesNotMatch: '*' },
          httpMetadata: { contentType },
        })) !== null
      );
    },
    async getBytes(key) {
      const object = await bucket.get(key);
      return object === null ? null : new Uint8Array(await object.arrayBuffer());
    },
  };
  return { store, dispose: platform.dispose };
}
