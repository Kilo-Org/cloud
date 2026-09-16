import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

it('passes renderer selection, lifecycle, annotation, capture isolation, and readiness regressions', () => {
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', '--test', join(__dirname, 'worktree-review-bindings.renderer.test.mts')],
    { timeout: 25_000, stdio: 'ignore' }
  );
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
}, 30_000);
