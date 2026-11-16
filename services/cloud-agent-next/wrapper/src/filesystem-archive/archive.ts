import { spawn } from 'node:child_process';
import { z } from 'zod';
import { ROOTFS_ARCHIVE_PYTHON } from '../../../src/shared/rootfs-archive-python.js';
import {
  rootfsArchiveConfiguration,
  rootfsArchiveDescriptorSchema,
  type RootfsArchiveDescriptor,
} from '../../../src/shared/rootfs-archive.js';

const errorCode = z.enum([
  'unsupported_platform',
  'invalid_archive',
  'base_mismatch',
  'limit_exceeded',
  'filesystem_changed',
  'unsupported_metadata',
  'restore_failed',
  'operation_failed',
]);
export class RootfsArchiveError extends Error {
  constructor(readonly code: z.infer<typeof errorCode>) {
    super(`Filesystem archive failed (${code})`);
    this.name = 'RootfsArchiveError';
  }
}
type ArchiveLocation = {
  root: string;
  baseImage: string;
  signal: AbortSignal;
};

async function execute(
  input: ArchiveLocation,
  operation: Record<string, unknown>
): Promise<unknown> {
  if (process.platform !== 'linux') throw new RootfsArchiveError('unsupported_platform');
  if (!input.root.startsWith('/') || !input.baseImage)
    throw new RootfsArchiveError('operation_failed');
  return new Promise((resolve, reject) => {
    const environment: Record<string, string | undefined> = {
      PATH: '/usr/local/bin:/usr/bin:/bin',
      LANG: 'C.UTF-8',
    };
    const child = spawn('/usr/bin/python3', ['-c', ROOTFS_ARCHIVE_PYTHON], {
      env: environment,
      signal: input.signal,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 32_768) {
        failed = true;
        child.kill('SIGTERM');
      } else chunks.push(chunk);
    });
    child.once('error', () => {
      failed = true;
    });
    child.once('close', code => {
      try {
        const reply = z
          .object({ ok: z.boolean(), code: errorCode.optional(), result: z.unknown().optional() })
          .parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        if (failed || code !== 0 || !reply.ok)
          reject(new RootfsArchiveError(reply.code ?? 'operation_failed'));
        else resolve(reply.result);
      } catch {
        reject(new RootfsArchiveError('operation_failed'));
      }
    });
    child.stdin.on('error', () => {
      failed = true;
      child.kill('SIGTERM');
    });
    child.stdin.end(
      JSON.stringify({
        ...rootfsArchiveConfiguration(),
        root: input.root,
        baseImage: input.baseImage,
        ...operation,
      })
    );
  });
}
export async function baselineRootFilesystem(
  input: ArchiveLocation & { baselinePath: string }
): Promise<void> {
  await execute(input, { action: 'baseline', baselinePath: input.baselinePath });
}
export async function captureRootFilesystem(
  input: ArchiveLocation & { baselinePath: string; archivePath: string }
): Promise<RootfsArchiveDescriptor> {
  return rootfsArchiveDescriptorSchema.parse(
    await execute(input, {
      action: 'capture',
      baselinePath: input.baselinePath,
      archivePath: input.archivePath,
    })
  );
}
/** Any failure leaves this allocation unusable. The caller must terminate it without a fresh-image fallback. */
export async function restoreRootFilesystem(
  input: ArchiveLocation & { archivePath: string; expected: RootfsArchiveDescriptor }
): Promise<void> {
  await execute(input, {
    action: 'restore',
    archivePath: input.archivePath,
    expected: rootfsArchiveDescriptorSchema.parse(input.expected),
  });
}
