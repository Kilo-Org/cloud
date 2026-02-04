#!/usr/bin/env npx ts-node

/**
 * Integration Tests for Init Endpoint Edge Cases
 *
 * Tests project initialization scenarios including templates and idempotency.
 *
 * Prerequisites:
 * - App builder running at http://localhost:8790
 * - Set AUTH_TOKEN environment variable
 *
 * Usage:
 *   cd cloudflare-app-builder
 *   AUTH_TOKEN=dev-token-change-this-in-production npx ts-node src/_integration_tests/test-init-edge-cases.ts
 */

// --- Configuration ---
const APP_BUILDER_URL = process.env.APP_BUILDER_URL || 'http://localhost:8790';
const AUTH_TOKEN = process.env.AUTH_TOKEN || 'dev-token-change-this-in-production';

// --- Types ---
type InitSuccessResponse = {
  success: true;
  app_id: string;
  git_url: string;
};

type InitErrorResponse = {
  success: false;
  error: string;
  message: string;
  git_url?: string;
};

type InitResponse = InitSuccessResponse | InitErrorResponse;

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

async function initProjectRaw(
  projectId: string,
  body?: Record<string, unknown>
): Promise<{ status: number; body: InitResponse }> {
  const endpoint = `${APP_BUILDER_URL}/apps/${encodeURIComponent(projectId)}/init`;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${AUTH_TOKEN}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const responseBody = (await response.json()) as InitResponse;
  return { status: response.status, body: responseBody };
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

async function testBasicInit() {
  log('\n=== Test: Basic Project Initialization ===');

  const testId = `test-init-basic-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  try {
    const result = await initProjectRaw(testId);

    if (result.status === 201 && result.body.success === true) {
      const successBody = result.body as InitSuccessResponse;
      if (successBody.app_id === testId && successBody.git_url.includes(testId)) {
        logSuccess('Basic init returns 201 with correct app_id and git_url');
        return true;
      }
    }

    logFailure(`Unexpected response: ${result.status} - ${JSON.stringify(result.body)}`);
    return false;
  } finally {
    await deleteProject(testId);
  }
}

async function testDoubleInit() {
  log('\n=== Test: Double Initialization (409 Conflict) ===');

  const testId = `test-init-double-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  try {
    // First init should succeed
    const firstResult = await initProjectRaw(testId);
    if (firstResult.status !== 201) {
      logFailure(`First init failed: ${firstResult.status}`);
      return false;
    }

    // Second init should fail with 409
    const secondResult = await initProjectRaw(testId);

    if (secondResult.status === 409 && secondResult.body.success === false) {
      const errorBody = secondResult.body as InitErrorResponse;
      if (errorBody.error === 'repository_exists' && errorBody.git_url) {
        logSuccess('Double init returns 409 with repository_exists error and git_url');
        return true;
      }
    }

    logFailure(`Expected 409, got ${secondResult.status} - ${JSON.stringify(secondResult.body)}`);
    return false;
  } finally {
    await deleteProject(testId);
  }
}

async function testInitWithDefaultTemplate() {
  log('\n=== Test: Init with Default Template (empty body) ===');

  const testId = `test-init-default-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  try {
    // Init without specifying template (should use default)
    const result = await initProjectRaw(testId);

    if (result.status === 201 && result.body.success === true) {
      logSuccess('Init with empty body uses default template and succeeds');
      return true;
    }

    logFailure(`Expected 201, got ${result.status}`);
    return false;
  } finally {
    await deleteProject(testId);
  }
}

async function testInitWithExplicitTemplate() {
  log('\n=== Test: Init with Explicit Template ===');

  const testId = `test-init-template-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  try {
    // Init with explicit template name
    const result = await initProjectRaw(testId, { template: 'nextjs-starter' });

    if (result.status === 201 && result.body.success === true) {
      logSuccess('Init with explicit template succeeds');
      return true;
    }

    logFailure(`Expected 201, got ${result.status}`);
    return false;
  } finally {
    await deleteProject(testId);
  }
}

async function testInitWithNonExistentTemplate() {
  log('\n=== Test: Init with Non-Existent Template (500) ===');

  const testId = `test-init-bad-template-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  try {
    const result = await initProjectRaw(testId, { template: 'non-existent-template-xyz' });

    if (result.status === 500 && result.body.success === false) {
      const errorBody = result.body as InitErrorResponse;
      if (errorBody.error === 'template_not_found') {
        logSuccess('Init with non-existent template returns 500 template_not_found');
        return true;
      }
    }

    logFailure(
      `Expected 500 template_not_found, got ${result.status} - ${JSON.stringify(result.body)}`
    );
    return false;
  } finally {
    await deleteProject(testId);
  }
}

async function testInitWithInvalidTemplateName() {
  log('\n=== Test: Init with Invalid Template Name (path traversal attempt) ===');

  const testId = `test-init-invalid-name-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  try {
    // Attempt path traversal in template name
    const result = await initProjectRaw(testId, { template: '../../../etc/passwd' });

    if (result.status === 400 && result.body.success === false) {
      const errorBody = result.body as InitErrorResponse;
      if (errorBody.error === 'invalid_request') {
        logSuccess('Init with path traversal template name returns 400');
        return true;
      }
    }

    logFailure(
      `Expected 400 invalid_request, got ${result.status} - ${JSON.stringify(result.body)}`
    );
    return false;
  } finally {
    await deleteProject(testId);
  }
}

async function testInitWithInvalidJson() {
  log('\n=== Test: Init with Invalid JSON Body ===');

  const testId = `test-init-invalid-json-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const endpoint = `${APP_BUILDER_URL}/apps/${encodeURIComponent(testId)}/init`;

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${AUTH_TOKEN}`,
      },
      body: 'not valid json {{{',
    });

    if (response.status === 400) {
      const body = (await response.json()) as ErrorResponse;
      if (body.error === 'invalid_request') {
        logSuccess('Init with invalid JSON returns 400');
        return true;
      }
    }

    logFailure(`Expected 400, got ${response.status}`);
    return false;
  } finally {
    await deleteProject(testId);
  }
}

async function testInitWithSpecialCharactersInId() {
  log('\n=== Test: Init with Special Characters in App ID ===');

  // Test various special characters - most should work since pattern is [a-z0-9_-]
  const validTestId = `test-init_special-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  try {
    const result = await initProjectRaw(validTestId);

    if (result.status === 201 && result.body.success === true) {
      logSuccess('Init with valid special chars (underscore, hyphen) succeeds');
      return true;
    }

    logFailure(`Expected 201, got ${result.status}`);
    return false;
  } finally {
    await deleteProject(validTestId);
  }
}

async function testInitResponseContainsCorrectGitUrl() {
  log('\n=== Test: Init Response Contains Correct Git URL Format ===');

  const testId = `test-init-giturl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  try {
    const result = await initProjectRaw(testId);

    if (result.status === 201 && result.body.success === true) {
      const successBody = result.body as InitSuccessResponse;
      const expectedUrlPattern = new RegExp(`https://[^/]+/apps/${testId}\\.git$`);

      if (expectedUrlPattern.test(successBody.git_url)) {
        logSuccess('Git URL follows expected format: https://hostname/apps/{id}.git');
        return true;
      }

      logFailure(`Git URL format unexpected: ${successBody.git_url}`);
      return false;
    }

    logFailure(`Expected 201, got ${result.status}`);
    return false;
  } finally {
    await deleteProject(testId);
  }
}

// --- Main Test Runner ---

async function runTests() {
  let passed = 0;
  let failed = 0;

  log('Starting init edge case tests', {
    appBuilderUrl: APP_BUILDER_URL,
  });

  const tests = [
    testBasicInit,
    testDoubleInit,
    testInitWithDefaultTemplate,
    testInitWithExplicitTemplate,
    testInitWithNonExistentTemplate,
    testInitWithInvalidTemplateName,
    testInitWithInvalidJson,
    testInitWithSpecialCharactersInId,
    testInitResponseContainsCorrectGitUrl,
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
      logError(`Test ${test.name} threw an exception`, error);
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
}

runTests().catch(error => {
  logError('Unhandled error', error);
  process.exit(1);
});
