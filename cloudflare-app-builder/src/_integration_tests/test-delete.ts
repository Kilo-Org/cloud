#!/usr/bin/env npx ts-node

/**
 * Integration Tests for Delete Endpoint
 *
 * Tests project deletion and verification that operations fail afterwards.
 *
 * Prerequisites:
 * - App builder running at http://localhost:8790
 * - Set AUTH_TOKEN environment variable
 *
 * Usage:
 *   cd cloudflare-app-builder
 *   AUTH_TOKEN=dev-token-change-this-in-production npx ts-node src/_integration_tests/test-delete.ts
 */

import { execSync } from 'child_process';
import { mkdtempSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// --- Configuration ---
const APP_BUILDER_URL = process.env.APP_BUILDER_URL || 'http://localhost:8790';
const AUTH_TOKEN = process.env.AUTH_TOKEN || 'dev-token-change-this-in-production';

// --- Types ---
type TokenResponse = {
  success: true;
  token: string;
  expires_at: string;
  permission: 'full' | 'ro';
};

type InitSuccessResponse = {
  success: true;
  app_id: string;
  git_url: string;
};

type DeleteResponse = {
  success?: boolean;
  error?: string;
  message?: string;
};

type InitResponse = {
  success: true;
  app_id: string;
  git_url: string;
};

type ErrorResponse = {
  error: string;
  message?: string;
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

async function generateGitToken(appId: string, permission: 'full' | 'ro'): Promise<TokenResponse> {
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

async function deleteProjectRaw(
  projectId: string
): Promise<{ status: number; body: DeleteResponse }> {
  const endpoint = `${APP_BUILDER_URL}/apps/${encodeURIComponent(projectId)}`;

  const response = await fetch(endpoint, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${AUTH_TOKEN}`,
    },
  });

  const body = (await response.json()) as DeleteResponse;
  return { status: response.status, body };
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

// --- Test Cases ---

async function testBasicDelete() {
  log('\n=== Test: Basic Project Deletion ===');

  const testId = `test-delete-basic-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // Initialize project
  await initProject(testId);

  // Delete project
  const result = await deleteProjectRaw(testId);

  if (result.status === 200 && result.body.success === true) {
    logSuccess('Delete returns 200 with success: true');
    return true;
  }

  logFailure(`Expected 200 with success, got ${result.status} - ${JSON.stringify(result.body)}`);
  return false;
}

async function testDeleteWithoutAuth() {
  log('\n=== Test: Delete Without Authorization ===');

  const testId = `test-delete-noauth-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  try {
    await initProject(testId);

    const endpoint = `${APP_BUILDER_URL}/apps/${encodeURIComponent(testId)}`;

    const response = await fetch(endpoint, {
      method: 'DELETE',
      // No Authorization header
    });

    if (response.status === 401) {
      logSuccess('Delete without auth returns 401');
      return true;
    }

    logFailure(`Expected 401, got ${response.status}`);
    return false;
  } finally {
    // Cleanup - delete with auth
    await deleteProjectRaw(testId);
  }
}

async function testDeleteWithInvalidAuth() {
  log('\n=== Test: Delete With Invalid Auth Token ===');

  const testId = `test-delete-badauth-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  try {
    await initProject(testId);

    const endpoint = `${APP_BUILDER_URL}/apps/${encodeURIComponent(testId)}`;

    const response = await fetch(endpoint, {
      method: 'DELETE',
      headers: {
        Authorization: 'Bearer invalid-token-xyz',
      },
    });

    if (response.status === 401) {
      logSuccess('Delete with invalid auth returns 401');
      return true;
    }

    logFailure(`Expected 401, got ${response.status}`);
    return false;
  } finally {
    await deleteProjectRaw(testId);
  }
}

async function testCloneFailsAfterDelete(tempDir: string) {
  log('\n=== Test: Clone Fails After Delete ===');

  const testId = `test-delete-clone-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // Initialize and get token
  const initResult = await initProject(testId);
  const tokenResult = await generateGitToken(testId, 'full');
  const gitUrl = buildGitUrlWithToken(initResult.git_url, tokenResult.token);

  // Verify clone works before delete
  const cloneDir1 = join(tempDir, 'clone-before-delete');
  mkdirSync(cloneDir1, { recursive: true });

  const beforeResult = runGitCommand(tempDir, `git clone "${gitUrl}" clone-before-delete`);
  if (!beforeResult.success) {
    logFailure('Clone failed even before delete');
    await deleteProjectRaw(testId);
    return false;
  }

  // Delete the project
  await deleteProjectRaw(testId);

  // Try to clone again - should fail
  const cloneDir2 = join(tempDir, 'clone-after-delete');
  mkdirSync(cloneDir2, { recursive: true });

  const afterResult = runGitCommand(tempDir, `git clone "${gitUrl}" clone-after-delete`);

  // Git reports authentication failures as "Authentication failed" or the server's error message
  if (
    !afterResult.success &&
    (afterResult.output.includes('404') ||
      afterResult.output.includes('not found') ||
      afterResult.output.includes('401') ||
      afterResult.output.includes('Unauthorized') ||
      afterResult.output.includes('Authentication failed'))
  ) {
    logSuccess('Clone fails after project deletion');
    return true;
  }

  logFailure('Clone should fail after deletion but it succeeded or failed with unexpected error');
  return false;
}

async function testTokenGenerationFailsAfterDelete() {
  log('\n=== Test: Token Generation Fails After Delete ===');

  const testId = `test-delete-token-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // Initialize project
  await initProject(testId);

  // Verify token generation works
  const token1 = await generateGitToken(testId, 'full').catch(() => null);
  if (!token1) {
    logFailure('Token generation failed even before delete');
    await deleteProjectRaw(testId);
    return false;
  }

  // Delete project
  await deleteProjectRaw(testId);

  // Try to generate token - should fail with 404
  const endpoint = `${APP_BUILDER_URL}/apps/${encodeURIComponent(testId)}/token`;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${AUTH_TOKEN}`,
    },
    body: JSON.stringify({ permission: 'full' }),
  });

  if (response.status === 404) {
    const body = (await response.json()) as ErrorResponse;
    if (body.error === 'not_found') {
      logSuccess('Token generation returns 404 after project deletion');
      return true;
    }
  }

  logFailure(`Expected 404 not_found, got ${response.status}`);
  return false;
}

async function testFilesApiFailsAfterDelete() {
  log('\n=== Test: Files API Fails After Delete ===');

  const testId = `test-delete-files-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // Initialize project
  await initProject(testId);

  // Verify tree works before delete
  const treeBefore = await fetch(
    `${APP_BUILDER_URL}/apps/${encodeURIComponent(testId)}/tree/HEAD`,
    {
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
    }
  );

  if (treeBefore.status !== 200) {
    logFailure('Tree endpoint failed even before delete');
    await deleteProjectRaw(testId);
    return false;
  }

  // Delete project
  await deleteProjectRaw(testId);

  // Try tree endpoint - should fail
  const treeAfter = await fetch(`${APP_BUILDER_URL}/apps/${encodeURIComponent(testId)}/tree/HEAD`, {
    headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
  });

  if (treeAfter.status === 404) {
    logSuccess('Tree endpoint returns 404 after project deletion');
    return true;
  }

  logFailure(`Expected 404, got ${treeAfter.status}`);
  return false;
}

async function testReInitAfterDelete() {
  log('\n=== Test: Re-Initialize After Delete ===');

  const testId = `test-delete-reinit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // Initialize, delete, then re-initialize
  await initProject(testId);
  await deleteProjectRaw(testId);

  // Re-initialize should work
  const endpoint = `${APP_BUILDER_URL}/apps/${encodeURIComponent(testId)}/init`;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${AUTH_TOKEN}`,
    },
  });

  if (response.status === 201) {
    const body = (await response.json()) as InitResponse;
    if (body.success === true && body.app_id === testId) {
      logSuccess('Re-initialization after delete succeeds with 201');
      await deleteProjectRaw(testId); // Cleanup
      return true;
    }
  }

  logFailure(`Expected 201 on re-init, got ${response.status}`);
  await deleteProjectRaw(testId); // Cleanup attempt
  return false;
}

async function testDeleteNonExistentProject() {
  log('\n=== Test: Delete Non-Existent Project ===');

  const nonExistentId = `non-existent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const result = await deleteProjectRaw(nonExistentId);

  // Deleting non-existent project should either succeed (idempotent) or return 404
  // The current implementation appears to return 200 (idempotent delete)
  if (result.status === 200 || result.status === 404) {
    logSuccess(`Delete non-existent project returns ${result.status} (acceptable)`);
    return true;
  }

  logFailure(`Unexpected status ${result.status} for delete of non-existent project`);
  return false;
}

async function testPushFailsAfterDelete(tempDir: string) {
  log('\n=== Test: Push Fails After Delete ===');

  const testId = `test-delete-push-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // Initialize, clone, and prepare for push
  const initResult = await initProject(testId);
  const tokenResult = await generateGitToken(testId, 'full');
  const gitUrl = buildGitUrlWithToken(initResult.git_url, tokenResult.token);

  const cloneDir = join(tempDir, 'clone-for-push');
  mkdirSync(cloneDir, { recursive: true });

  runGitCommand(tempDir, `git clone "${gitUrl}" clone-for-push`);
  runGitCommand(cloneDir, 'git config user.email "test@example.com"');
  runGitCommand(cloneDir, 'git config user.name "Test User"');
  runGitCommand(cloneDir, 'echo "test" > new-file.txt');
  runGitCommand(cloneDir, 'git add new-file.txt');
  runGitCommand(cloneDir, 'git commit -m "Test commit"');

  // Delete the project
  await deleteProjectRaw(testId);

  // Try to push - should fail
  const pushResult = runGitCommand(cloneDir, 'git push origin main');

  // Git reports authentication failures as "Authentication failed" or the server's error message
  if (
    !pushResult.success &&
    (pushResult.output.includes('404') ||
      pushResult.output.includes('401') ||
      pushResult.output.includes('rejected') ||
      pushResult.output.includes('not found') ||
      pushResult.output.includes('Unauthorized') ||
      pushResult.output.includes('Authentication failed'))
  ) {
    logSuccess('Push fails after project deletion');
    return true;
  }

  logFailure('Push should fail after deletion');
  return false;
}

// --- Main Test Runner ---

async function runTests() {
  const tempDir = mkdtempSync(join(tmpdir(), 'app-builder-delete-test-'));
  let passed = 0;
  let failed = 0;

  log('Starting delete endpoint tests', {
    tempDir,
    appBuilderUrl: APP_BUILDER_URL,
  });

  try {
    const tests: Array<() => Promise<boolean>> = [
      testBasicDelete,
      testDeleteWithoutAuth,
      testDeleteWithInvalidAuth,
      () => testCloneFailsAfterDelete(tempDir),
      testTokenGenerationFailsAfterDelete,
      testFilesApiFailsAfterDelete,
      testReInitAfterDelete,
      testDeleteNonExistentProject,
      () => testPushFailsAfterDelete(tempDir),
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
