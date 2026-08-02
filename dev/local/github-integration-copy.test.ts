import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const currentDir = dirname(fileURLToPath(import.meta.url));
const seedPath = join(currentDir, '..', 'seed', 'app', 'github-integration-copy.ts');
const { isE2eTargetEmail } = (await import(pathToFileURL(seedPath).href)) as {
  isE2eTargetEmail: (email: string) => boolean;
};

test('isE2eTargetEmail accepts the documented E2E mobile email pattern', () => {
  // apps/mobile/e2e/login.sh: e2e-mobile-<worktree>-<platform>@example.com
  assert.ok(isE2eTargetEmail('e2e-mobile-unify-ios@example.com'));
  assert.ok(isE2eTargetEmail('e2e-mobile-unify-android@example.com'));
  // Worktree slug may contain hyphens.
  assert.ok(isE2eTargetEmail('e2e-mobile-my-worktree-ios@example.com'));
  assert.ok(isE2eTargetEmail('e2e-mobile-foo-bar-android@example.com'));
});

test('isE2eTargetEmail rejects arbitrary @example.com addresses', () => {
  // An arbitrary @example.com address is NOT an E2E target — the guard must be
  // precise, not a domain suffix check.
  assert.ok(!isE2eTargetEmail('developer@example.com'));
  assert.ok(!isE2eTargetEmail('foo@example.com'));
  assert.ok(!isE2eTargetEmail('admin@example.com'));
});

test('isE2eTargetEmail rejects malformed near-matches', () => {
  // Missing worktree and platform suffix.
  assert.ok(!isE2eTargetEmail('e2e-mobile@example.com'));
  // Missing platform suffix.
  assert.ok(!isE2eTargetEmail('e2e-mobile-unify@example.com'));
  // Wrong platform.
  assert.ok(!isE2eTargetEmail('e2e-mobile-unify-web@example.com'));
  // Missing worktree (just platform).
  assert.ok(!isE2eTargetEmail('e2e-mobile-ios@example.com'));
});

test('isE2eTargetEmail rejects non-E2E targets', () => {
  // A real developer sign-in email in the shared dev database.
  assert.ok(!isE2eTargetEmail('real.dev@gmail.com'));
  // A seeded account with a real-looking domain (not @example.com).
  assert.ok(!isE2eTargetEmail('someone@company.com'));
  // A mistyped E2E email missing the domain.
  assert.ok(!isE2eTargetEmail('e2e-mobile@other-example.com'));
  // Edge case: subdomain match is not a suffix match.
  assert.ok(!isE2eTargetEmail('not@sub.example.com'));
  // Edge case: empty string.
  assert.ok(!isE2eTargetEmail(''));
});

test('isE2eTargetEmail is case-sensitive on the local part and domain', () => {
  // The regex is case-sensitive: @EXAMPLE.COM is not @example.com.
  assert.ok(!isE2eTargetEmail('e2e-mobile-unify-ios@EXAMPLE.COM'));
  // Case-insensitive local part doesn't match either.
  assert.ok(!isE2eTargetEmail('E2E-MOBILE-unify-ios@example.com'));
});
