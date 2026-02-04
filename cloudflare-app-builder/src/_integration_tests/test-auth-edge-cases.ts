#!/usr/bin/env npx ts-node

/**
 * Integration Tests for Authentication Edge Cases
 *
 * Tests authentication failures and token validation scenarios.
 *
 * Prerequisites:
 * - App builder running at http://localhost:8790
 * - Set AUTH_TOKEN environment variable
 *
 * Usage:
 *   cd cloudflare-app-builder
 *   AUTH_TOKEN=dev-token-change-this-in-production npx ts-node src/_integration_tests/test-auth-edge-cases.ts
 */

import { execSync } from 'child_process';
import { mkdtempSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// --- Configuration ---
const APP_BUILDER_URL = process.env.APP_BUILDER_URL || 'http://localhost:8790';
const AUTH_TOKEN = process.env.AUTH_TOKEN || 'dev-token-change-this-in-production';

// --- Types ---
type TokenPermission = 'full' | 'ro';

type TokenResponse = {
  success: true;
  token: string;
  expires_at: string;
  permission: TokenPermission;
};

type InitSuccessResponse = {
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

function buildGitUrlWithToken(gitUrl: string, token: string, username = 'x-access-token'): string {
  const url = new URL(gitUrl);
  url.username = username;
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

async function deleteProject(projectId: string): Promise<void> {
  const endpoint = `${APP_BUILDER_URL}/apps/${encodeURIComponent(projectId)}`;

  await fetch(endpoint, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${AUTH_TOKEN}`,
    },
  });
}

// --- Test Cases ---

async function testMissingAuthHeader() {
  log('\n=== Test: Missing Authorization Header ===');

  // Use a valid-length app ID (20+ characters) so route matches
  const testAppId = 'test-missing-auth-header-check';
  const response = await fetch(`${APP_BUILDER_URL}/apps/${testAppId}/init`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
  });

  if (response.status === 401) {
    const body = (await response.json()) as ErrorResponse;
    if (body.error === 'authentication_required') {
      logSuccess('Missing auth header returns 401 with authentication_required error');
      return true;
    }
  }

  logFailure(`Expected 401, got ${response.status}`);
  return false;
}

async function testInvalidBearerToken() {
  log('\n=== Test: Invalid Bearer Token ===');

  // Use a valid-length app ID (20+ characters) so route matches
  const testAppId = 'test-invalid-bearer-token-check';
  const response = await fetch(`${APP_BUILDER_URL}/apps/${testAppId}/init`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer invalid-token-12345',
    },
  });

  if (response.status === 401) {
    const body = (await response.json()) as ErrorResponse;
    if (body.error === 'invalid_token') {
      logSuccess('Invalid bearer token returns 401 with invalid_token error');
      return true;
    }
  }

  logFailure(`Expected 401, got ${response.status}`);
  return false;
}

async function testMalformedBearerToken() {
  log('\n=== Test: Malformed Bearer Header ===');

  // Use a valid-length app ID (20+ characters) so route matches
  const testAppId = 'test-malformed-bearer-header';
  const response = await fetch(`${APP_BUILDER_URL}/apps/${testAppId}/init`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'NotBearer some-token',
    },
  });

  if (response.status === 401) {
    logSuccess('Malformed bearer header returns 401');
    return true;
  }

  logFailure(`Expected 401, got ${response.status}`);
  return false;
}

async function testTokenForWrongRepository(tempDir: string) {
  log('\n=== Test: Token for Wrong Repository ===');

  const testId1 = `test-auth-repo1-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const testId2 = `test-auth-repo2-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  try {
    // Initialize two separate projects
    const initResult1 = await initProject(testId1);
    const initResult2 = await initProject(testId2);

    // Get token for repo1
    const token1 = await generateGitToken(testId1, 'full');

    // Try to use token1 to access repo2
    const cloneDir = join(tempDir, 'wrong-repo-clone');
    mkdirSync(cloneDir, { recursive: true });

    const wrongUrl = buildGitUrlWithToken(initResult2.git_url, token1.token);
    const result = runGitCommand(tempDir, `git clone "${wrongUrl}" wrong-repo-clone`);

    if (
      !result.success &&
      (result.output.includes('401') || result.output.includes('Unauthorized'))
    ) {
      logSuccess('Token for wrong repository is rejected');
      return true;
    }

    logFailure('Expected clone with wrong repo token to fail');
    return false;
  } finally {
    // Cleanup
    await deleteProject(testId1);
    await deleteProject(testId2);
  }
}

async function testInvalidGitUsername(tempDir: string) {
  log('\n=== Test: Invalid Git Username (not x-access-token) ===');

  const testId = `test-auth-username-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  try {
    const initResult = await initProject(testId);
    const tokenResult = await generateGitToken(testId, 'full');

    // Use wrong username instead of "x-access-token"
    const cloneDir = join(tempDir, 'wrong-username-clone');
    mkdirSync(cloneDir, { recursive: true });

    const wrongUsernameUrl = buildGitUrlWithToken(
      initResult.git_url,
      tokenResult.token,
      'wrong-username'
    );
    const result = runGitCommand(tempDir, `git clone "${wrongUsernameUrl}" wrong-username-clone`);

    if (
      !result.success &&
      (result.output.includes('401') || result.output.includes('Invalid credentials'))
    ) {
      logSuccess('Invalid git username is rejected');
      return true;
    }

    logFailure('Expected clone with wrong username to fail');
    return false;
  } finally {
    await deleteProject(testId);
  }
}

async function testTokenForNonExistentRepo() {
  log('\n=== Test: Generate Token for Non-Existent Repository ===');

  const nonExistentId = `non-existent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const endpoint = `${APP_BUILDER_URL}/apps/${encodeURIComponent(nonExistentId)}/token`;

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
      logSuccess('Token generation for non-existent repo returns 404');
      return true;
    }
  }

  logFailure(`Expected 404, got ${response.status}`);
  return false;
}

async function testInvalidTokenPermission() {
  log('\n=== Test: Invalid Token Permission Value ===');

  const testId = `test-auth-perm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  try {
    await initProject(testId);

    const endpoint = `${APP_BUILDER_URL}/apps/${encodeURIComponent(testId)}/token`;

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${AUTH_TOKEN}`,
      },
      body: JSON.stringify({ permission: 'invalid-permission' }),
    });

    if (response.status === 400) {
      const body = (await response.json()) as ErrorResponse;
      if (body.error === 'invalid_parameter') {
        logSuccess('Invalid permission value returns 400');
        return true;
      }
    }

    logFailure(`Expected 400, got ${response.status}`);
    return false;
  } finally {
    await deleteProject(testId);
  }
}

async function testCloneNonExistentRepository(tempDir: string) {
  log('\n=== Test: Clone Non-Existent Repository ===');

  // Generate a valid-looking but non-existent app ID
  const nonExistentId = `non-existent-repo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const gitUrl = `${APP_BUILDER_URL}/apps/${nonExistentId}.git`;

  // We need some token to attempt the clone (the git protocol will validate)
  const cloneDir = join(tempDir, 'non-existent-clone');
  mkdirSync(cloneDir, { recursive: true });

  // Use x-access-token with a dummy token
  const url = new URL(gitUrl);
  url.username = 'x-access-token';
  url.password = 'dummy-token';

  const result = runGitCommand(tempDir, `git clone "${url.toString()}" non-existent-clone`);

  // Git reports authentication failures as "Authentication failed" or the server's error message
  if (
    !result.success &&
    (result.output.includes('404') ||
      result.output.includes('not found') ||
      result.output.includes('401') ||
      result.output.includes('Unauthorized') ||
      result.output.includes('Authentication failed'))
  ) {
    logSuccess('Clone of non-existent repository fails appropriately');
    return true;
  }

  logFailure('Expected clone of non-existent repo to fail');
  return false;
}

// --- Main Test Runner ---

async function runTests() {
  const tempDir = mkdtempSync(join(tmpdir(), 'app-builder-auth-test-'));
  let passed = 0;
  let failed = 0;

  log('Starting authentication edge case tests', {
    tempDir,
    appBuilderUrl: APP_BUILDER_URL,
  });

  try {
    const tests = [
      () => testMissingAuthHeader(),
      () => testInvalidBearerToken(),
      () => testMalformedBearerToken(),
      () => testTokenForWrongRepository(tempDir),
      () => testInvalidGitUsername(tempDir),
      () => testTokenForNonExistentRepo(),
      () => testInvalidTokenPermission(),
      () => testCloneNonExistentRepository(tempDir),
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
