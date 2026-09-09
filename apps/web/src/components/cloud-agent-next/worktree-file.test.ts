import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

it('passes the saved-file ESM parser, state, and Markdown regressions', () => {
  const result = spawnSync(
    process.execPath,
    ['--conditions=import', '--import', 'tsx', '--test', join(__dirname, 'worktree-file.test.mts')],
    { timeout: 25_000, stdio: 'ignore' }
  );
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
}, 30_000);
