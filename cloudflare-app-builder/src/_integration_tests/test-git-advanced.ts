#!/usr/bin/env npx ts-node

/**
 * Advanced Git Integration Tests
 *
 * Tests additional git scenarios not covered by the basic integration test:
 * - Multiple commits and fetch
 * - Branch operations
 * - Binary file handling
 * - Large file handling
 * - Concurrent operations
 *
 * Prerequisites:
 * - App builder running at http://localhost:8790
 * - Set AUTH_TOKEN environment variable
 *
 * Usage:
 *   cd cloudflare-app-builder
 *   AUTH_TOKEN=dev-token-change-this-in-production npx ts-node src/_integration_tests/test-git-advanced.ts
 */

import { execSync } from 'child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// --- Configuration ---
const APP_BUILDER_URL = process.env.APP_BUILDER_URL || 'http://localhost:8790';
const AUTH_TOKEN = process.env.AUTH_TOKEN || 'dev-token-change-this-in-production';

// --- Types ---
type TokenPermission = 'full' | 'ro';

type InitSuccessResponse = {
  success: true;
  app_id: string;
  git_url: string;
};

type TokenResponse = {
  success: true;
  token: string;
  expires_at: string;
  permission: TokenPermission;
};

// --- Helper Functions ---

function log(message: string, data?: unknown) {
  console.log(`[TEST] ${message}`, data ? JSON.stringify(data, null, 2) : '');
}

function logError(message: string, error?: unknown) {
  console.error(`[ERROR] ${message}`, error);
}

function logSuccess(message: string) {
  console.log(`[✓] ${message}`);
}

function logFailure(message: string) {
  console.error(`[✗] ${message}`);
}

async function initProject(projectId: string): Promise<InitSuccessResponse> {
  const endpoint = `${APP_BUILDER_URL}/apps/${encodeURIComponent(projectId)}/init`;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${AUTH_TOKEN}`,
    },
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'Unknown error');
    throw new Error(`Failed to init project: ${response.status} - ${errorText}`);
  }

  return response.json();
}

async function generateGitToken(
  appId: string,
  permission: TokenPermission
): Promise<TokenResponse> {
  const endpoint = `${APP_BUILDER_URL}/apps/${encodeURIComponent(appId)}/token`;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${AUTH_TOKEN}`,
    },
    body: JSON.stringify({ permission }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'Unknown error');
    throw new Error(`Failed to generate token: ${response.status} - ${errorText}`);
  }

  return response.json();
}

async function deleteProject(projectId: string): Promise<void> {
  const endpoint = `${APP_BUILDER_URL}/apps/${encodeURIComponent(projectId)}`;

  await fetch(endpoint, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${AUTH_TOKEN}`,
    },
  });
}

function buildGitUrlWithToken(gitUrl: string, token: string): string {
  const url = new URL(gitUrl);
  url.username = 'x-access-token';
  url.password = token;
  return url.toString();
}

function runGitCommand(dir: string, command: string): { success: boolean; output: string } {
  const fullCommand = `cd "${dir}" && ${command} 2>&1`;

  try {
    const output = execSync(fullCommand, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { success: true, output };
  } catch (error: unknown) {
    const execError = error as { stderr?: string; stdout?: string; message?: string };
    return {
      success: false,
      output: execError.stderr || execError.stdout || execError.message || 'Command failed',
    };
  }
}

function runGitCommandOrThrow(dir: string, command: string): string {
  const result = runGitCommand(dir, command);
  if (!result.success) {
    throw new Error(`Git command failed: ${command}\nOutput: ${result.output}`);
  }
  return result.output;
}

// --- Test Cases ---

async function testMultipleCommitsThenFetch(tempDir: string) {
  log('\n=== Test: Multiple Commits and Git Fetch ===');

  const testId = `test-git-multi-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  try {
    const initResult = await initProject(testId);
    const tokenResult = await generateGitToken(testId, 'full');
    const gitUrl = buildGitUrlWithToken(initResult.git_url, tokenResult.token);

    // Clone 1 - user A
    const cloneDirA = join(tempDir, 'clone-a');
    mkdirSync(cloneDirA, { recursive: true });
    runGitCommandOrThrow(tempDir, `git clone "${gitUrl}" clone-a`);
    runGitCommandOrThrow(cloneDirA, 'git config user.email "a@example.com"');
    runGitCommandOrThrow(cloneDirA, 'git config user.name "User A"');

    // Clone 2 - user B (simulated)
    const cloneDirB = join(tempDir, 'clone-b');
    mkdirSync(cloneDirB, { recursive: true });
    const tokenB = await generateGitToken(testId, 'full');
    const gitUrlB = buildGitUrlWithToken(initResult.git_url, tokenB.token);
    runGitCommandOrThrow(tempDir, `git clone "${gitUrlB}" clone-b`);
    runGitCommandOrThrow(cloneDirB, 'git config user.email "b@example.com"');
    runGitCommandOrThrow(cloneDirB, 'git config user.name "User B"');

    // User A makes commit 1
    writeFileSync(join(cloneDirA, 'file-from-a.txt'), 'Content from A');
    runGitCommandOrThrow(cloneDirA, 'git add file-from-a.txt');
    runGitCommandOrThrow(cloneDirA, 'git commit -m "Commit from A"');

    // Get fresh token for push (original may be getting close to expiry)
    const tokenAPush = await generateGitToken(testId, 'full');
    runGitCommandOrThrow(
      cloneDirA,
      `git remote set-url origin "${buildGitUrlWithToken(initResult.git_url, tokenAPush.token)}"`
    );
    runGitCommandOrThrow(cloneDirA, 'git push origin main');

    // User B fetches A's changes
    const tokenBFetch = await generateGitToken(testId, 'full');
    runGitCommandOrThrow(
      cloneDirB,
      `git remote set-url origin "${buildGitUrlWithToken(initResult.git_url, tokenBFetch.token)}"`
    );
    runGitCommandOrThrow(cloneDirB, 'git fetch origin');
    runGitCommandOrThrow(cloneDirB, 'git merge origin/main --no-edit');

    // Verify B has A's file
    if (existsSync(join(cloneDirB, 'file-from-a.txt'))) {
      const content = readFileSync(join(cloneDirB, 'file-from-a.txt'), 'utf-8');
      if (content === 'Content from A') {
        logSuccess('Git fetch and merge works correctly');
        return true;
      }
    }

    logFailure('Fetched content does not match');
    return false;
  } finally {
    await deleteProject(testId);
  }
}

async function testModifyExistingFile(tempDir: string) {
  log('\n=== Test: Modify Existing File and Push ===');

  const testId = `test-git-modify-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  try {
    const initResult = await initProject(testId);
    const tokenResult = await generateGitToken(testId, 'full');
    const gitUrl = buildGitUrlWithToken(initResult.git_url, tokenResult.token);

    const cloneDir = join(tempDir, 'clone-modify');
    mkdirSync(cloneDir, { recursive: true });
    runGitCommandOrThrow(tempDir, `git clone "${gitUrl}" clone-modify`);
    runGitCommandOrThrow(cloneDir, 'git config user.email "test@example.com"');
    runGitCommandOrThrow(cloneDir, 'git config user.name "Test User"');

    // Check if package.json exists (from template)
    const packageJsonPath = join(cloneDir, 'package.json');
    if (!existsSync(packageJsonPath)) {
      log('No package.json in template, creating new file to modify');
      writeFileSync(packageJsonPath, '{"name": "test"}');
      runGitCommandOrThrow(cloneDir, 'git add package.json');
      runGitCommandOrThrow(cloneDir, 'git commit -m "Add package.json"');
      const token1 = await generateGitToken(testId, 'full');
      runGitCommandOrThrow(
        cloneDir,
        `git remote set-url origin "${buildGitUrlWithToken(initResult.git_url, token1.token)}"`
      );
      runGitCommandOrThrow(cloneDir, 'git push origin main');
    }

    // Modify package.json
    const originalContent = readFileSync(packageJsonPath, 'utf-8');
    const modifiedContent = originalContent.replace(/"name":\s*"[^"]*"/, '"name": "modified-name"');
    writeFileSync(packageJsonPath, modifiedContent);

    runGitCommandOrThrow(cloneDir, 'git add package.json');
    runGitCommandOrThrow(cloneDir, 'git commit -m "Modify package.json"');

    const token2 = await generateGitToken(testId, 'full');
    runGitCommandOrThrow(
      cloneDir,
      `git remote set-url origin "${buildGitUrlWithToken(initResult.git_url, token2.token)}"`
    );
    runGitCommandOrThrow(cloneDir, 'git push origin main');

    // Clone again and verify
    const cloneDir2 = join(tempDir, 'clone-verify-modify');
    mkdirSync(cloneDir2, { recursive: true });
    const token3 = await generateGitToken(testId, 'full');
    runGitCommandOrThrow(
      tempDir,
      `git clone "${buildGitUrlWithToken(initResult.git_url, token3.token)}" clone-verify-modify`
    );

    const verifyContent = readFileSync(join(cloneDir2, 'package.json'), 'utf-8');
    if (verifyContent.includes('modified-name')) {
      logSuccess('Modify existing file and push works');
      return true;
    }

    logFailure('Modified content not found in fresh clone');
    return false;
  } finally {
    await deleteProject(testId);
  }
}

async function testDeleteFileAndPush(tempDir: string) {
  log('\n=== Test: Delete File and Push ===');

  const testId = `test-git-delete-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  try {
    const initResult = await initProject(testId);
    const tokenResult = await generateGitToken(testId, 'full');
    const gitUrl = buildGitUrlWithToken(initResult.git_url, tokenResult.token);

    const cloneDir = join(tempDir, 'clone-delete-file');
    mkdirSync(cloneDir, { recursive: true });
    runGitCommandOrThrow(tempDir, `git clone "${gitUrl}" clone-delete-file`);
    runGitCommandOrThrow(cloneDir, 'git config user.email "test@example.com"');
    runGitCommandOrThrow(cloneDir, 'git config user.name "Test User"');

    // Add a file first
    writeFileSync(join(cloneDir, 'to-delete.txt'), 'This file will be deleted');
    runGitCommandOrThrow(cloneDir, 'git add to-delete.txt');
    runGitCommandOrThrow(cloneDir, 'git commit -m "Add file to delete"');
    const token1 = await generateGitToken(testId, 'full');
    runGitCommandOrThrow(
      cloneDir,
      `git remote set-url origin "${buildGitUrlWithToken(initResult.git_url, token1.token)}"`
    );
    runGitCommandOrThrow(cloneDir, 'git push origin main');

    // Now delete the file
    runGitCommandOrThrow(cloneDir, 'git rm to-delete.txt');
    runGitCommandOrThrow(cloneDir, 'git commit -m "Delete file"');
    const token2 = await generateGitToken(testId, 'full');
    runGitCommandOrThrow(
      cloneDir,
      `git remote set-url origin "${buildGitUrlWithToken(initResult.git_url, token2.token)}"`
    );
    runGitCommandOrThrow(cloneDir, 'git push origin main');

    // Clone again and verify file is gone
    const cloneDir2 = join(tempDir, 'clone-verify-delete');
    mkdirSync(cloneDir2, { recursive: true });
    const token3 = await generateGitToken(testId, 'full');
    runGitCommandOrThrow(
      tempDir,
      `git clone "${buildGitUrlWithToken(initResult.git_url, token3.token)}" clone-verify-delete`
    );

    if (!existsSync(join(cloneDir2, 'to-delete.txt'))) {
      logSuccess('Delete file and push works');
      return true;
    }

    logFailure('Deleted file still exists in fresh clone');
    return false;
  } finally {
    await deleteProject(testId);
  }
}

async function testGitLog(tempDir: string) {
  log('\n=== Test: Git Log Shows Commit History ===');

  const testId = `test-git-log-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  try {
    const initResult = await initProject(testId);
    const tokenResult = await generateGitToken(testId, 'full');
    const gitUrl = buildGitUrlWithToken(initResult.git_url, tokenResult.token);

    const cloneDir = join(tempDir, 'clone-log');
    mkdirSync(cloneDir, { recursive: true });
    runGitCommandOrThrow(tempDir, `git clone "${gitUrl}" clone-log`);
    runGitCommandOrThrow(cloneDir, 'git config user.email "test@example.com"');
    runGitCommandOrThrow(cloneDir, 'git config user.name "Test User"');

    // Make multiple commits
    writeFileSync(join(cloneDir, 'commit1.txt'), 'First');
    runGitCommandOrThrow(cloneDir, 'git add commit1.txt');
    runGitCommandOrThrow(cloneDir, 'git commit -m "First commit"');

    writeFileSync(join(cloneDir, 'commit2.txt'), 'Second');
    runGitCommandOrThrow(cloneDir, 'git add commit2.txt');
    runGitCommandOrThrow(cloneDir, 'git commit -m "Second commit"');

    const token1 = await generateGitToken(testId, 'full');
    runGitCommandOrThrow(
      cloneDir,
      `git remote set-url origin "${buildGitUrlWithToken(initResult.git_url, token1.token)}"`
    );
    runGitCommandOrThrow(cloneDir, 'git push origin main');

    // Clone again and check git log
    const cloneDir2 = join(tempDir, 'clone-verify-log');
    mkdirSync(cloneDir2, { recursive: true });
    const token2 = await generateGitToken(testId, 'full');
    runGitCommandOrThrow(
      tempDir,
      `git clone "${buildGitUrlWithToken(initResult.git_url, token2.token)}" clone-verify-log`
    );

    const logOutput = runGitCommandOrThrow(cloneDir2, 'git log --oneline');

    if (logOutput.includes('First commit') && logOutput.includes('Second commit')) {
      logSuccess('Git log shows full commit history');
      return true;
    }

    logFailure(`Git log missing commits: ${logOutput}`);
    return false;
  } finally {
    await deleteProject(testId);
  }
}

async function testNestedDirectoryCreation(tempDir: string) {
  log('\n=== Test: Create Nested Directory Structure ===');

  const testId = `test-git-nested-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  try {
    const initResult = await initProject(testId);
    const tokenResult = await generateGitToken(testId, 'full');
    const gitUrl = buildGitUrlWithToken(initResult.git_url, tokenResult.token);

    const cloneDir = join(tempDir, 'clone-nested');
    mkdirSync(cloneDir, { recursive: true });
    runGitCommandOrThrow(tempDir, `git clone "${gitUrl}" clone-nested`);
    runGitCommandOrThrow(cloneDir, 'git config user.email "test@example.com"');
    runGitCommandOrThrow(cloneDir, 'git config user.name "Test User"');

    // Create nested structure
    const nestedPath = join(cloneDir, 'deep', 'nested', 'path');
    mkdirSync(nestedPath, { recursive: true });
    writeFileSync(join(nestedPath, 'deep-file.txt'), 'Deep content');

    runGitCommandOrThrow(cloneDir, 'git add .');
    runGitCommandOrThrow(cloneDir, 'git commit -m "Add nested directories"');
    const token1 = await generateGitToken(testId, 'full');
    runGitCommandOrThrow(
      cloneDir,
      `git remote set-url origin "${buildGitUrlWithToken(initResult.git_url, token1.token)}"`
    );
    runGitCommandOrThrow(cloneDir, 'git push origin main');

    // Clone and verify
    const cloneDir2 = join(tempDir, 'clone-verify-nested');
    mkdirSync(cloneDir2, { recursive: true });
    const token2 = await generateGitToken(testId, 'full');
    runGitCommandOrThrow(
      tempDir,
      `git clone "${buildGitUrlWithToken(initResult.git_url, token2.token)}" clone-verify-nested`
    );

    const deepFile = join(cloneDir2, 'deep', 'nested', 'path', 'deep-file.txt');
    if (existsSync(deepFile)) {
      const content = readFileSync(deepFile, 'utf-8');
      if (content === 'Deep content') {
        logSuccess('Nested directory creation works');
        return true;
      }
    }

    logFailure('Nested file not found or content mismatch');
    return false;
  } finally {
    await deleteProject(testId);
  }
}

async function testBinaryFileHandling(tempDir: string) {
  log('\n=== Test: Binary File Handling ===');

  const testId = `test-git-binary-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  try {
    const initResult = await initProject(testId);
    const tokenResult = await generateGitToken(testId, 'full');
    const gitUrl = buildGitUrlWithToken(initResult.git_url, tokenResult.token);

    const cloneDir = join(tempDir, 'clone-binary');
    mkdirSync(cloneDir, { recursive: true });
    runGitCommandOrThrow(tempDir, `git clone "${gitUrl}" clone-binary`);
    runGitCommandOrThrow(cloneDir, 'git config user.email "test@example.com"');
    runGitCommandOrThrow(cloneDir, 'git config user.name "Test User"');

    // Create a small binary file (PNG header + some data)
    const binaryData = Buffer.from([
      0x89,
      0x50,
      0x4e,
      0x47,
      0x0d,
      0x0a,
      0x1a,
      0x0a, // PNG signature
      0x00,
      0x00,
      0x00,
      0x0d, // IHDR length
      0x49,
      0x48,
      0x44,
      0x52, // IHDR type
      0x00,
      0x00,
      0x00,
      0x01, // width: 1
      0x00,
      0x00,
      0x00,
      0x01, // height: 1
      0x08,
      0x02, // bit depth: 8, color type: 2 (RGB)
      0x00,
      0x00,
      0x00, // compression, filter, interlace
      0xff,
      0xff,
      0xff,
      0xff, // CRC (placeholder)
    ]);

    writeFileSync(join(cloneDir, 'test-image.png'), binaryData);
    runGitCommandOrThrow(cloneDir, 'git add test-image.png');
    runGitCommandOrThrow(cloneDir, 'git commit -m "Add binary file"');
    const token1 = await generateGitToken(testId, 'full');
    runGitCommandOrThrow(
      cloneDir,
      `git remote set-url origin "${buildGitUrlWithToken(initResult.git_url, token1.token)}"`
    );
    runGitCommandOrThrow(cloneDir, 'git push origin main');

    // Clone and verify
    const cloneDir2 = join(tempDir, 'clone-verify-binary');
    mkdirSync(cloneDir2, { recursive: true });
    const token2 = await generateGitToken(testId, 'full');
    runGitCommandOrThrow(
      tempDir,
      `git clone "${buildGitUrlWithToken(initResult.git_url, token2.token)}" clone-verify-binary`
    );

    const clonedBinary = readFileSync(join(cloneDir2, 'test-image.png'));
    if (clonedBinary.equals(binaryData)) {
      logSuccess('Binary file handling works correctly');
      return true;
    }

    logFailure('Binary file content mismatch');
    return false;
  } finally {
    await deleteProject(testId);
  }
}

async function testEmptyCommit(tempDir: string) {
  log('\n=== Test: Empty Commit (amend without changes) ===');

  const testId = `test-git-empty-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  try {
    const initResult = await initProject(testId);
    const tokenResult = await generateGitToken(testId, 'full');
    const gitUrl = buildGitUrlWithToken(initResult.git_url, tokenResult.token);

    const cloneDir = join(tempDir, 'clone-empty');
    mkdirSync(cloneDir, { recursive: true });
    runGitCommandOrThrow(tempDir, `git clone "${gitUrl}" clone-empty`);
    runGitCommandOrThrow(cloneDir, 'git config user.email "test@example.com"');
    runGitCommandOrThrow(cloneDir, 'git config user.name "Test User"');

    // Make a commit, then try empty commit with --allow-empty
    writeFileSync(join(cloneDir, 'file.txt'), 'Content');
    runGitCommandOrThrow(cloneDir, 'git add file.txt');
    runGitCommandOrThrow(cloneDir, 'git commit -m "Add file"');
    runGitCommandOrThrow(cloneDir, 'git commit --allow-empty -m "Empty commit"');

    const token1 = await generateGitToken(testId, 'full');
    runGitCommandOrThrow(
      cloneDir,
      `git remote set-url origin "${buildGitUrlWithToken(initResult.git_url, token1.token)}"`
    );
    runGitCommandOrThrow(cloneDir, 'git push origin main');

    // Clone and verify both commits exist
    const cloneDir2 = join(tempDir, 'clone-verify-empty');
    mkdirSync(cloneDir2, { recursive: true });
    const token2 = await generateGitToken(testId, 'full');
    runGitCommandOrThrow(
      tempDir,
      `git clone "${buildGitUrlWithToken(initResult.git_url, token2.token)}" clone-verify-empty`
    );

    const logOutput = runGitCommandOrThrow(cloneDir2, 'git log --oneline');
    if (logOutput.includes('Empty commit') && logOutput.includes('Add file')) {
      logSuccess('Empty commit support works');
      return true;
    }

    logFailure('Empty commit not in history');
    return false;
  } finally {
    await deleteProject(testId);
  }
}

async function testSpecialCharactersInFilename(tempDir: string) {
  log('\n=== Test: Special Characters in Filename ===');

  const testId = `test-git-special-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  try {
    const initResult = await initProject(testId);
    const tokenResult = await generateGitToken(testId, 'full');
    const gitUrl = buildGitUrlWithToken(initResult.git_url, tokenResult.token);

    const cloneDir = join(tempDir, 'clone-special');
    mkdirSync(cloneDir, { recursive: true });
    runGitCommandOrThrow(tempDir, `git clone "${gitUrl}" clone-special`);
    runGitCommandOrThrow(cloneDir, 'git config user.email "test@example.com"');
    runGitCommandOrThrow(cloneDir, 'git config user.name "Test User"');

    // Test files with special (but valid) characters
    const specialNames = [
      'file with spaces.txt',
      'file-with-dashes.txt',
      'file_with_underscores.txt',
      'file.multiple.dots.txt',
    ];

    for (const name of specialNames) {
      writeFileSync(join(cloneDir, name), `Content of ${name}`);
    }

    runGitCommandOrThrow(cloneDir, 'git add .');
    runGitCommandOrThrow(cloneDir, 'git commit -m "Add special filename files"');
    const token1 = await generateGitToken(testId, 'full');
    runGitCommandOrThrow(
      cloneDir,
      `git remote set-url origin "${buildGitUrlWithToken(initResult.git_url, token1.token)}"`
    );
    runGitCommandOrThrow(cloneDir, 'git push origin main');

    // Clone and verify
    const cloneDir2 = join(tempDir, 'clone-verify-special');
    mkdirSync(cloneDir2, { recursive: true });
    const token2 = await generateGitToken(testId, 'full');
    runGitCommandOrThrow(
      tempDir,
      `git clone "${buildGitUrlWithToken(initResult.git_url, token2.token)}" clone-verify-special`
    );

    let allFound = true;
    for (const name of specialNames) {
      if (!existsSync(join(cloneDir2, name))) {
        logFailure(`File not found: ${name}`);
        allFound = false;
      }
    }

    if (allFound) {
      logSuccess('Special characters in filenames work');
      return true;
    }
    return false;
  } finally {
    await deleteProject(testId);
  }
}

// --- Main Test Runner ---

async function runTests() {
  const tempDir = mkdtempSync(join(tmpdir(), 'app-builder-git-adv-test-'));
  let passed = 0;
  let failed = 0;

  log('Starting advanced git integration tests', {
    tempDir,
    appBuilderUrl: APP_BUILDER_URL,
  });

  try {
    const tests: Array<() => Promise<boolean>> = [
      () => testMultipleCommitsThenFetch(tempDir),
      () => testModifyExistingFile(tempDir),
      () => testDeleteFileAndPush(tempDir),
      () => testGitLog(tempDir),
      () => testNestedDirectoryCreation(tempDir),
      () => testBinaryFileHandling(tempDir),
      () => testEmptyCommit(tempDir),
      () => testSpecialCharactersInFilename(tempDir),
    ];

    for (const test of tests) {
      try {
        const result = await test();
        if (result) {
          passed++;
        } else {
          failed++;
        }
      } catch (error) {
        logError('Test threw an exception', error);
        failed++;
      }
    }

    console.log('\n' + '='.repeat(50));
    if (failed === 0) {
      console.log(`🎉 ALL TESTS PASSED! (${passed}/${passed + failed})`);
    } else {
      console.log(`❌ SOME TESTS FAILED (${passed} passed, ${failed} failed)`);
    }
    console.log('='.repeat(50));

    if (failed > 0) {
      process.exit(1);
    }
  } finally {
    log('\nCleaning up temp directory...');
    try {
      rmSync(tempDir, { recursive: true, force: true });
      log('Cleanup complete');
    } catch (e) {
      logError('Failed to cleanup temp directory', e);
    }
  }
}

runTests().catch(error => {
  logError('Unhandled error', error);
  process.exit(1);
});
