#!/usr/bin/env npx ts-node

/**
 * Integration tests for Git HEAD state and commit history.
 *
 * Specifically targets:
 * - Detached HEAD regressions after clone
 * - Commit history preservation across push/clone cycles
 * - Incremental push correctness
 * - Bidirectional clone→push→clone round-trips
 *
 * Prerequisites:
 * - App builder running at http://localhost:8790
 * - Set AUTH_TOKEN environment variable (or use default dev token)
 *
 * Usage:
 *   cd cloudflare-app-builder
 *   AUTH_TOKEN=dev-token-change-this-in-production pnpm test:git-head
 */

import {
  APP_BUILDER_URL,
  initProject,
  cloneRepo,
  configureGitUser,
  commitAll,
  push,
  createTempDir,
  removeTempDir,
  runGitCommand,
  log,
  logSuccess,
  assertEqual,
  assertFileContent,
  assertFileExists,
  assertNotDetachedHead,
  countCommits,
  getCommitMessages,
  runTestSuite,
  writeFileSync,
  join,
} from './git-test-helpers';

function uniqueId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// =========================================================================
// Test 1: Multiple local commits then push, clone verifies all history
// =========================================================================
async function testMultipleCommitsThenPush() {
  const testId = uniqueId('multi-commit');
  const tempDir = createTempDir();

  try {
    log(`Project: ${testId}`);
    const { git_url: gitUrl } = await initProject(testId);

    // Clone
    const dir1 = await cloneRepo(testId, gitUrl, tempDir, 'work');
    configureGitUser(dir1);

    // First local commit: create file A
    const fileAContent = 'File A — first commit';
    writeFileSync(join(dir1, 'fileA.txt'), fileAContent);
    commitAll(dir1, 'Add file A');

    // Second local commit: modify A + create B
    const fileAUpdated = 'File A — updated in second commit';
    const fileBContent = 'File B — second commit';
    writeFileSync(join(dir1, 'fileA.txt'), fileAUpdated);
    writeFileSync(join(dir1, 'fileB.txt'), fileBContent);
    commitAll(dir1, 'Update A, add B');

    // Push both commits at once
    push(dir1);

    // Clone into a fresh folder
    const dir2 = await cloneRepo(testId, gitUrl, tempDir, 'verify');

    // Assertions
    assertNotDetachedHead(dir2, 'main');

    // 3 commits: initial template + "Add file A" + "Update A, add B"
    const commitCount = countCommits(dir2);
    assertEqual(commitCount, 3, 'commit count');

    const messages = getCommitMessages(dir2);
    assertEqual(messages[0], 'Update A, add B', 'most recent commit message');
    assertEqual(messages[1], 'Add file A', 'second commit message');
    assertEqual(messages[2], 'Initial commit', 'initial commit message');

    assertFileContent(dir2, 'fileA.txt', fileAUpdated, 'fileA.txt content');
    assertFileContent(dir2, 'fileB.txt', fileBContent, 'fileB.txt content');

    // git status should be clean
    const status = runGitCommand(dir2, 'git status --porcelain');
    assertEqual(status.trim(), '', 'git status clean');

    logSuccess('All history and files verified in fresh clone');
  } finally {
    removeTempDir(tempDir);
  }
}

// =========================================================================
// Test 2: Incremental pushes — push, then push again, then clone
// =========================================================================
async function testIncrementalPushes() {
  const testId = uniqueId('incr-push');
  const tempDir = createTempDir();

  try {
    log(`Project: ${testId}`);
    const { git_url: gitUrl } = await initProject(testId);

    // Clone
    const dir1 = await cloneRepo(testId, gitUrl, tempDir, 'work');
    configureGitUser(dir1);

    // First commit + push
    writeFileSync(join(dir1, 'first.txt'), 'first push content');
    commitAll(dir1, 'First push');
    push(dir1);

    // Second commit + push (incremental)
    writeFileSync(join(dir1, 'second.txt'), 'second push content');
    commitAll(dir1, 'Second push');
    push(dir1);

    // Clone into fresh folder
    const dir2 = await cloneRepo(testId, gitUrl, tempDir, 'verify');

    // Assertions
    assertNotDetachedHead(dir2, 'main');

    const commitCount = countCommits(dir2);
    assertEqual(commitCount, 3, 'commit count after 2 incremental pushes');

    assertFileContent(dir2, 'first.txt', 'first push content', 'first.txt content');
    assertFileContent(dir2, 'second.txt', 'second push content', 'second.txt content');

    const messages = getCommitMessages(dir2);
    assertEqual(messages[0], 'Second push', 'latest commit');
    assertEqual(messages[1], 'First push', 'second commit');

    logSuccess('Incremental pushes preserved correctly');
  } finally {
    removeTempDir(tempDir);
  }
}

// =========================================================================
// Test 3: Bidirectional — clone in dir1 push, clone in dir2 push, verify
// =========================================================================
async function testBidirectionalPushes() {
  const testId = uniqueId('bidir');
  const tempDir = createTempDir();

  try {
    log(`Project: ${testId}`);
    const { git_url: gitUrl } = await initProject(testId);

    // Clone into dir1, make changes, push
    const dir1 = await cloneRepo(testId, gitUrl, tempDir, 'dir1');
    configureGitUser(dir1);
    writeFileSync(join(dir1, 'from-dir1.txt'), 'created in dir1');
    commitAll(dir1, 'Commit from dir1');
    push(dir1);

    // Clone into dir2 (simulates cloud-agent picking up the repo)
    const dir2 = await cloneRepo(testId, gitUrl, tempDir, 'dir2');
    assertNotDetachedHead(dir2, 'main');
    configureGitUser(dir2);

    // Verify dir2 has dir1's file
    assertFileContent(dir2, 'from-dir1.txt', 'created in dir1', 'dir1 file in dir2');

    // Make changes in dir2, push
    writeFileSync(join(dir2, 'from-dir2.txt'), 'created in dir2');
    commitAll(dir2, 'Commit from dir2');
    push(dir2);

    // Clone into dir3 (final verification)
    const dir3 = await cloneRepo(testId, gitUrl, tempDir, 'dir3');

    assertNotDetachedHead(dir3, 'main');

    assertFileContent(dir3, 'from-dir1.txt', 'created in dir1', 'dir1 file in dir3');
    assertFileContent(dir3, 'from-dir2.txt', 'created in dir2', 'dir2 file in dir3');

    const commitCount = countCommits(dir3);
    assertEqual(commitCount, 3, 'total commit count (initial + dir1 + dir2)');

    const messages = getCommitMessages(dir3);
    assertEqual(messages[0], 'Commit from dir2', 'latest commit from dir2');
    assertEqual(messages[1], 'Commit from dir1', 'commit from dir1');

    logSuccess('Bidirectional push round-trip verified');
  } finally {
    removeTempDir(tempDir);
  }
}

// =========================================================================
// Test 4: Detached HEAD regression — thorough checks after every clone
// =========================================================================
async function testDetachedHeadRegression() {
  const testId = uniqueId('detached');
  const tempDir = createTempDir();

  try {
    log(`Project: ${testId}`);
    const { git_url: gitUrl } = await initProject(testId);

    // Clone immediately after init (only initial commit exists)
    log('Cloning immediately after init...');
    const dir1 = await cloneRepo(testId, gitUrl, tempDir, 'clone-after-init');
    assertNotDetachedHead(dir1, 'main');
    logSuccess('Clone after init: NOT detached HEAD');

    // Push a commit
    configureGitUser(dir1);
    writeFileSync(join(dir1, 'change.txt'), 'some change');
    commitAll(dir1, 'Add change');
    push(dir1);

    // Clone after first push
    log('Cloning after first push...');
    const dir2 = await cloneRepo(testId, gitUrl, tempDir, 'clone-after-push1');
    assertNotDetachedHead(dir2, 'main');
    logSuccess('Clone after 1st push: NOT detached HEAD');

    // Push another commit
    configureGitUser(dir2);
    writeFileSync(join(dir2, 'change2.txt'), 'another change');
    commitAll(dir2, 'Add change2');
    push(dir2);

    // Clone after second push
    log('Cloning after second push...');
    const dir3 = await cloneRepo(testId, gitUrl, tempDir, 'clone-after-push2');
    assertNotDetachedHead(dir3, 'main');
    logSuccess('Clone after 2nd push: NOT detached HEAD');

    // Verify the full chain is intact
    assertEqual(countCommits(dir3), 3, 'final commit count');

    logSuccess('No detached HEAD detected at any stage');
  } finally {
    removeTempDir(tempDir);
  }
}

// =========================================================================
// Test 5: Clone of fresh repo (only template initial commit)
// =========================================================================
async function testCloneFreshRepo() {
  const testId = uniqueId('fresh');
  const tempDir = createTempDir();

  try {
    log(`Project: ${testId}`);
    const { git_url: gitUrl } = await initProject(testId);

    // Clone immediately — no pushes have occurred yet
    const dir1 = await cloneRepo(testId, gitUrl, tempDir, 'fresh-clone');

    // Should be on main, not detached
    assertNotDetachedHead(dir1, 'main');

    // Should have exactly 1 commit (the initial template commit)
    assertEqual(countCommits(dir1), 1, 'commit count');
    assertEqual(getCommitMessages(dir1)[0], 'Initial commit', 'initial commit message');

    // Template files should exist (at minimum package.json for nextjs-starter)
    assertFileExists(dir1, 'package.json', 'template package.json');

    // Should be able to make changes and push
    configureGitUser(dir1);
    writeFileSync(join(dir1, 'new-file.txt'), 'new content');
    commitAll(dir1, 'First user commit');
    push(dir1);

    // Verify the push took
    const dir2 = await cloneRepo(testId, gitUrl, tempDir, 'verify');
    assertNotDetachedHead(dir2, 'main');
    assertEqual(countCommits(dir2), 2, 'commit count after push');
    assertFileContent(dir2, 'new-file.txt', 'new content', 'new-file.txt content');

    logSuccess('Fresh repo clone + first push verified');
  } finally {
    removeTempDir(tempDir);
  }
}

// =========================================================================
// Main
// =========================================================================

async function main() {
  log('Git HEAD & History Integration Tests', { appBuilderUrl: APP_BUILDER_URL });

  const allPassed = await runTestSuite('Git HEAD & History', [
    { name: 'Multiple commits then push', fn: testMultipleCommitsThenPush },
    { name: 'Incremental pushes', fn: testIncrementalPushes },
    { name: 'Bidirectional push round-trip', fn: testBidirectionalPushes },
    { name: 'Detached HEAD regression', fn: testDetachedHeadRegression },
    { name: 'Clone fresh repo (template only)', fn: testCloneFreshRepo },
  ]);

  process.exit(allPassed ? 0 : 1);
}

main().catch(error => {
  console.error('Unhandled error', error);
  process.exit(1);
});
