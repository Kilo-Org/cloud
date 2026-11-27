import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  matchesKiloPermissionPattern,
  resolveCommandGuardBashPermission,
  scopedReviewPermissions,
} from './command-guard.js';

it.each(['github', 'gitlab', 'bitbucket'] as const)(
  '%s permits a workspace commit while the remote ref stays fixed',
  platform => {
    const root = mkdtempSync(join(tmpdir(), 'review-workspace-'));
    const remote = join(root, 'origin.git');
    const checkout = join(root, 'checkout');
    const env = {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'Review',
      GIT_COMMITTER_NAME: 'Review',
      GIT_AUTHOR_EMAIL: 'review@example.com',
      GIT_COMMITTER_EMAIL: 'review@example.com',
    };
    const git = (args: string[], cwd = root) =>
      execFileSync('git', args, {
        cwd,
        env,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    try {
      git(['init', '-b', 'main', checkout]);
      git(['commit', '--allow-empty', '-m', 'Initial'], checkout);
      git(['clone', '--bare', checkout, remote]);
      git(['remote', 'add', 'origin', remote], checkout);
      const original = git(['rev-parse', 'HEAD'], remote);
      const permissions = scopedReviewPermissions(platform, checkout, 'review-1');
      const bash = permissions.bash;
      const edit = permissions.edit;
      if (typeof bash !== 'object' || typeof edit !== 'object')
        throw new Error('Expected review rules');
      const resolvesEdit = (path: string) =>
        Object.entries(edit)
          .filter(([pattern]) => matchesKiloPermissionPattern(path, pattern))
          .at(-1)?.[1];
      expect(resolvesEdit('finding.md')).toBe('allow');
      expect(resolvesEdit('../other/finding.md')).toBe('deny');
      expect(resolvesEdit('.git/config')).toBe('deny');
      for (const command of [
        "cat > finding.md <<'REVIEW'\n<details>Review</details>\nREVIEW",
        'git add finding.md',
        'git commit -m Finding',
      ]) {
        expect(resolveCommandGuardBashPermission(bash, command)).toBe('allow');
        execFileSync('/bin/sh', ['-c', command], { cwd: checkout, env });
      }
      expect(git(['show', 'HEAD:finding.md'], checkout)).toBe('<details>Review</details>');
      expect(git(['rev-parse', 'HEAD'], checkout)).not.toBe(original);
      expect(git(['rev-parse', 'refs/heads/main'], remote)).toBe(original);
      expect(resolveCommandGuardBashPermission(bash, 'git push origin main')).toBe('deny');
      expect(resolveCommandGuardBashPermission(bash, 'env')).toBe('deny');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
);
