import { describe, expect, it } from 'vitest';
import type { ImageMCPTokenClaims } from '../auth/jwt';
import type { R2Client, R2Object } from '../r2/client';
import { getImage } from './get-image';
import { transferImage } from './transfer-image';

const CLAIMS: ImageMCPTokenClaims = {
  src_bucket: 'attachments',
  src_prefix: 'user-1/app-builder/',
  dst_bucket: 'assets',
  dst_prefix: 'user_1/proj-1/',
  project_id: 'proj-1',
  user_id: 'user-1',
};

const SOURCE_PATH = 'msg-1/img-1.png';
const SOURCE_KEY = 'user-1/app-builder/msg-1/img-1.png';

const REJECTED_SOURCE_PATHS = [
  '',
  '/msg-1/img-1.png',
  '../img-1.png',
  'msg-1/../../img-1.png',
  'msg-1%2fimg-1.png',
  '%2e%2e/img-1.png',
  '.%2e/img-1.png',
  '%2E./img-1.png',
  'msg-1\\img-1.png',
  'msg-1\u0000img-1.png',
];

function createFakeR2(sourceObject: R2Object | null) {
  const reads: Array<{ bucket: string; key: string }> = [];
  const writes: Array<{ bucket: string; key: string }> = [];

  const r2: R2Client = {
    async getObject(bucket, key) {
      reads.push({ bucket, key });
      return sourceObject;
    },
    async putObject(bucket, key) {
      writes.push({ bucket, key });
    },
    async listObjects() {
      throw new Error('listObjects is not used by the image tools');
    },
  };

  return { r2, reads, writes };
}

function createSourceObject(): R2Object {
  return {
    body: new Response(new Uint8Array([1, 2, 3])).body as ReadableStream,
    contentType: 'image/png',
    contentLength: 3,
  };
}

describe('getImage', () => {
  it('reads the object behind the source path', async () => {
    const { r2, reads } = createFakeR2(createSourceObject());

    const content = await getImage({ sourcePath: SOURCE_PATH, claims: CLAIMS, r2 });

    expect(reads).toEqual([{ bucket: 'attachments', key: SOURCE_KEY }]);
    expect(content).toEqual({
      type: 'image',
      data: Buffer.from([1, 2, 3]).toString('base64'),
      mimeType: 'image/png',
    });
  });

  it('reads nothing for any other source path', async () => {
    for (const sourcePath of REJECTED_SOURCE_PATHS) {
      const { r2, reads } = createFakeR2(createSourceObject());

      await expect(
        getImage({ sourcePath, claims: CLAIMS, r2 }),
        `sourcePath: ${JSON.stringify(sourcePath)}`
      ).rejects.toThrow('Access denied: invalid source path');
      expect(reads, `sourcePath: ${JSON.stringify(sourcePath)}`).toEqual([]);
    }
  });
});

describe('transferImage', () => {
  it('copies the object to the destination prefix and returns its public URL', async () => {
    const { r2, reads, writes } = createFakeR2(createSourceObject());

    const url = await transferImage({
      sourcePath: SOURCE_PATH,
      claims: CLAIMS,
      r2,
      bucketPublicUrls: { assets: 'https://assets.example' },
    });

    expect(reads).toEqual([{ bucket: 'attachments', key: SOURCE_KEY }]);
    expect(writes).toEqual([{ bucket: 'assets', key: 'user_1/proj-1/img-1.png' }]);
    expect(url).toBe('https://assets.example/user_1/proj-1/img-1.png');
  });

  it('reads and writes nothing for any other source path', async () => {
    for (const sourcePath of REJECTED_SOURCE_PATHS) {
      const { r2, reads, writes } = createFakeR2(createSourceObject());

      await expect(
        transferImage({
          sourcePath,
          claims: CLAIMS,
          r2,
          bucketPublicUrls: { assets: 'https://assets.example' },
        }),
        `sourcePath: ${JSON.stringify(sourcePath)}`
      ).rejects.toThrow('Access denied: invalid source path');
      expect(reads, `sourcePath: ${JSON.stringify(sourcePath)}`).toEqual([]);
      expect(writes, `sourcePath: ${JSON.stringify(sourcePath)}`).toEqual([]);
    }
  });
});
