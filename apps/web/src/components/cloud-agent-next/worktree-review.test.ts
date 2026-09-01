import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

it('passes the worktree review ESM domain regressions', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--conditions=import',
      '--import',
      'tsx',
      '--test',
      join(__dirname, 'worktree-review.test.mts'),
    ],
    { timeout: 25_000, stdio: 'pipe', encoding: 'utf8' }
  );
  expect(result.error).toBeUndefined();
  expect({ status: result.status, output: result.stdout, error: result.stderr }).toEqual({
    status: 0,
    output: expect.any(String),
    error: '',
  });
}, 30_000);
