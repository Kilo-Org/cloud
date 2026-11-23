import { rejects } from 'node:assert/strict';
import { describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { awsByocConfigurationSchema } from '@kilocode/worker-utils/aws-byoc';
import { awsArchiveBaseImage, awsArchiveObjectKey } from '../../../src/shared/aws-archive.js';
import type { RootfsArchiveDescriptor } from '../../../src/shared/rootfs-archive.js';
import { createAwsFilesystemBuildArchive } from './aws-archive.js';

const identity = {
  environmentId: '11111111-1111-4111-8111-111111111111',
  buildId: '22222222-2222-4222-8222-222222222222',
  allocationId: '33333333-3333-4333-8333-333333333333',
};
const configuration = awsByocConfigurationSchema.parse({
  region: 'us-east-1',
  roleArn: 'arn:aws:iam::123456789012:role/customer',
  externalId: 'synthetic-external-id-000000000000000000000',
  stackId: 'arn:aws:cloudformation:us-east-1:123456789012:stack/customer/12345678-abcd',
  bucket: 'customer-artifacts',
  imageIdentifier: 'arn:aws:lambda:us-east-1:123456789012:microvm-image:kilo',
  imageVersion: '1.0',
  connectorArn: 'arn:aws:lambda:us-east-1:123456789012:network-connector:customer:1',
  templateVersion: 2,
  proxyProtocolVersion: 1,
});

async function fixture() {
  const root = await mkdtemp('/tmp/aws-builder-upload-test-');
  await writeFile(path.join(root, 'base-marker'), 'base');
  let descriptor: RootfsArchiveDescriptor | undefined;
  let stored: Buffer | undefined;
  let requests = 0;
  let prepares = 0;
  let verified = false;
  let grantHost = 'customer-artifacts.s3.us-east-1.amazonaws.com';
  let failVerification = false;
  let cancelAfterVerification = false;
  const controller = new AbortController();
  const archive = await createAwsFilesystemBuildArchive({
    identity,
    baseImage: awsArchiveBaseImage('44444444-4444-4444-8444-444444444444', configuration),
    root,
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]),
    client: {
      async prepareArchiveUpload(value) {
        descriptor = value;
        prepares++;
        return {
          url: `https://${grantHost}/${awsArchiveObjectKey(identity)}?synthetic-signature=${prepares}`,
          headers: {
            'content-type': 'application/x-tar',
            'if-none-match': '*',
            'x-amz-checksum-sha256': Buffer.from(value.sha256, 'hex').toString('base64'),
          },
        };
      },
      async completeArchiveUpload() {
        if (failVerification) throw new Error('Synthetic HEAD verification failure');
        expect(stored).toBeDefined();
        if (!stored || !descriptor) throw new Error('Missing stored object');
        expect(stored.length).toBe(descriptor.size);
        expect(createHash('sha256').update(stored).digest('hex')).toBe(descriptor.sha256);
        verified = true;
        if (cancelAfterVerification) controller.abort(new Error('synthetic build cancelled'));
      },
    },
    async send(url, init) {
      requests++;
      const request = new Request(url, init);
      expect(request.headers.get('if-none-match')).toBe('*');
      expect(request.redirect).toBe('error');
      // Only the latest capability is still valid; storage rejects an expired signature.
      if (url.searchParams.get('synthetic-signature') !== String(prepares))
        return new Response(null, { status: 403 });
      if (stored) return new Response(null, { status: 412 });
      stored = Buffer.from(await request.arrayBuffer());
      // Storage committed the object, but the reply did not reach the builder.
      throw new Error('Synthetic lost upload reply');
    },
  });
  await archive.baseline();
  await mkdir(path.join(root, 'usr/bin'), { recursive: true });
  await writeFile(path.join(root, 'usr/bin/prepared-tool'), '#!/bin/sh\nprintf prepared', {
    mode: 0o755,
  });
  return {
    archive,
    requests: () => requests,
    prepares: () => prepares,
    verified: () => verified,
    stored: () => stored,
    descriptor: () => descriptor,
    foreignGrant() {
      grantHost = 'foreign-bucket.s3.us-east-1.amazonaws.com';
    },
    cancelAfterVerification() {
      cancelAfterVerification = true;
    },
    failVerification() {
      failVerification = true;
    },
    async close() {
      await archive.dispose();
      await rm(root, { recursive: true, force: true });
    },
  };
}

describe.skipIf(process.platform !== 'linux')('AWS builder archive upload', () => {
  it('does not report ready when cancellation arrives during final verification', async () => {
    const f = await fixture();
    try {
      f.cancelAfterVerification();
      await rejects(f.archive.captureAndUpload(), {
        message: 'Environment archive capture or upload failed (synthetic build cancelled)',
      });
      expect(f.verified()).toBe(true);
      expect(f.stored()).toBeDefined();
    } finally {
      await f.close();
    }
  });
  it('captures real files and reconciles an immutable PUT after a lost success reply', async () => {
    const f = await fixture();
    try {
      await f.archive.captureAndUpload();
      expect(f.requests()).toBe(2);
      // The retry signs a fresh capability, so a PUT that outlived the first one still lands.
      expect(f.prepares()).toBe(2);
      expect(f.verified()).toBe(true);
      expect(f.descriptor()?.fileCount).toBeGreaterThan(0);
      expect(f.stored()?.includes(Buffer.from('prepared-tool'))).toBe(true);
    } finally {
      await f.close();
    }
  });
  it('refuses a capability for another bucket before sending archive bytes', async () => {
    const f = await fixture();
    try {
      f.foreignGrant();
      await rejects(f.archive.captureAndUpload(), {
        message: 'Environment archive capture or upload failed (Invalid archive upload capability)',
      });
      expect(f.requests()).toBe(0);
      expect(f.stored()).toBeUndefined();
      expect(f.verified()).toBe(false);
    } finally {
      await f.close();
    }
  });
  it('does not report a ready archive when authoritative metadata verification fails', async () => {
    const f = await fixture();
    try {
      f.failVerification();
      await rejects(f.archive.captureAndUpload(), {
        message:
          'Environment archive capture or upload failed (Synthetic HEAD verification failure)',
      });
      expect(f.stored()).toBeDefined();
      expect(f.verified()).toBe(false);
    } finally {
      await f.close();
    }
  });
});
