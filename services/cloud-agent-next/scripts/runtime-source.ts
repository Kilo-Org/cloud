import { spawnSync } from 'node:child_process';
import { z } from 'zod';

/** Exact-SHA publication and deployment must use a clean source checkout. */
export function verifyRuntimeSourceCheckout(sourceSha: string, cwd: string): void {
  z.string()
    .regex(/^[a-f0-9]{40}$/)
    .parse(sourceSha);
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' });
  const status = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], {
    cwd,
    encoding: 'utf8',
  });
  if (
    head.error ||
    status.error ||
    head.status !== 0 ||
    status.status !== 0 ||
    head.stdout.trim() !== sourceSha ||
    status.stdout.trim() !== ''
  )
    throw new Error('Runtime source checkout is dirty or differs from the exact SHA');
}
