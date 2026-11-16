import fs from 'node:fs/promises';
import path from 'node:path';
import { baselineRootFilesystem, captureRootFilesystem } from '../filesystem-archive/archive.js';
import { awsArchiveObjectKey, decodeAwsArchiveBase } from '../../../src/shared/aws-archive.js';
import type { RootfsArchiveDescriptor } from '../../../src/shared/rootfs-archive.js';
import type { EnvironmentBuildArchiveUpload } from '../../../src/shared/environment-build-archive.js';

export type BuilderArchiveClient = {
  prepareArchiveUpload(
    descriptor: RootfsArchiveDescriptor,
    signal: AbortSignal
  ): Promise<EnvironmentBuildArchiveUpload>;
  completeArchiveUpload(signal: AbortSignal): Promise<void>;
};
export type FilesystemBuildArchive = {
  baseline(this: void): Promise<void>;
  captureAndUpload(): Promise<void>;
  dispose(): Promise<void>;
};

/** Archive transport grants authorize one immutable object; no AWS role credential enters the builder. */
export async function createAwsFilesystemBuildArchive(input: {
  identity: { environmentId: string; buildId: string; allocationId: string };
  baseImage: string;
  root: string;
  signal: AbortSignal;
  client: BuilderArchiveClient;
  send?: (url: URL, init: RequestInit) => Promise<Response>;
}): Promise<FilesystemBuildArchive> {
  const send = input.send ?? ((url, init) => fetch(url, init));
  const base = decodeAwsArchiveBase(input.baseImage);
  if (!base) throw new Error('Environment archive base is invalid');
  const scratch = await fs.mkdtemp('/tmp/kilo-environment-archive-');
  const location = {
    root: input.root,
    baseImage: input.baseImage,
    signal: input.signal,
    baselinePath: path.join(scratch, 'baseline.json'),
    archivePath: path.join(scratch, 'environment.tar'),
  };
  return {
    baseline: () => baselineRootFilesystem(location),
    async captureAndUpload() {
      try {
        const descriptor = await captureRootFilesystem(location);
        const grant = await input.client.prepareArchiveUpload(descriptor, input.signal);
        input.signal.throwIfAborted();
        const url = new URL(grant.url);
        const checksum = Buffer.from(descriptor.sha256, 'hex').toString('base64');
        if (
          url.protocol !== 'https:' ||
          url.host !== `${base.bucket}.s3.${base.region}.amazonaws.com` ||
          url.username ||
          url.password ||
          url.hash ||
          url.pathname !== '/' + awsArchiveObjectKey(input.identity) ||
          grant.headers['x-amz-checksum-sha256'] !== checksum
        )
          throw new Error('Invalid archive upload capability');
        const file = Bun.file(location.archivePath);
        if (file.size !== descriptor.size) throw new Error('Environment archive changed');
        let accepted = false;
        // A lost PUT reply is safe to retry: the same checksum/key is reserved and every PUT requires absence.
        for (let attempt = 0; attempt < 3; attempt++) {
          input.signal.throwIfAborted();
          let response: Response;
          try {
            response = await send(url, {
              method: 'PUT',
              headers: grant.headers,
              body: file,
              redirect: 'error',
              signal: input.signal,
            });
          } catch {
            if (attempt === 2) throw new Error('Environment archive upload failed');
            continue;
          }
          await response.body?.cancel();
          if (response.ok || response.status === 412) {
            accepted = true;
            break;
          }
          if (response.status !== 408 && response.status !== 429 && response.status < 500) break;
        }
        if (!accepted) throw new Error('Environment archive upload failed');
        // HEAD verification reconciles a lost success/412 reply and checks the stored checksum and size.
        await input.client.completeArchiveUpload(input.signal);
        input.signal.throwIfAborted();
      } catch {
        throw new Error('Environment archive capture or upload failed');
      }
    },
    async dispose() {
      await fs.rm(scratch, { recursive: true, force: true });
    },
  };
}
