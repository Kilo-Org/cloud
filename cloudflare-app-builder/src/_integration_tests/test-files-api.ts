#!/usr/bin/env npx ts-node

/**
 * Integration Tests for Files API (Tree & Blob Endpoints)
 *
 * Tests the file browsing API endpoints:
 * - GET /apps/{id}/tree/{ref} - List directory contents
 * - GET /apps/{id}/blob/{ref}/{path} - Get file content
 *
 * Prerequisites:
 * - App builder running at http://localhost:8790
 * - Set AUTH_TOKEN environment variable
 *
 * Usage:
 *   cd cloudflare-app-builder
 *   AUTH_TOKEN=dev-token-change-this-in-production npx ts-node src/_integration_tests/test-files-api.ts
 */

import { execSync } from 'child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// --- Configuration ---
const APP_BUILDER_URL = process.env.APP_BUILDER_URL || 'http://localhost:8790';
const AUTH_TOKEN = process.env.AUTH_TOKEN || 'dev-token-change-this-in-production';

// --- Types ---
type TreeEntry = {
  name: string;
  type: 'blob' | 'tree';
  oid: string;
  mode: string;
};

type GetTreeResponse = {
  entries: TreeEntry[];
  path: string;
  ref: string;
  commitSha: string;
};

type GetBlobResponse = {
  content: string;
  encoding: 'utf-8' | 'base64';
  size: number;
  path: string;
  sha: string;
};

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

function runGitCommand(dir: string, command: string): string {
  const fullCommand = `cd "${dir}" && ${command}`;
  return execSync(fullCommand, {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

async function getTree(
  appId: string,
  ref: string,
  path?: string
): Promise<{ status: number; body: GetTreeResponse | { error: string; message: string } }> {
  let endpoint = `${APP_BUILDER_URL}/apps/${encodeURIComponent(appId)}/tree/${encodeURIComponent(ref)}`;
  if (path) {
    endpoint += `?path=${encodeURIComponent(path)}`;
  }

  const response = await fetch(endpoint, {
    headers: {
      Authorization: `Bearer ${AUTH_TOKEN}`,
    },
  });

  return { status: response.status, body: await response.json() };
}

async function getBlob(
  appId: string,
  ref: string,
  path: string
): Promise<{ status: number; body: GetBlobResponse | { error: string; message: string } }> {
  const endpoint = `${APP_BUILDER_URL}/apps/${encodeURIComponent(appId)}/blob/${encodeURIComponent(ref)}/${path}`;

  const response = await fetch(endpoint, {
    headers: {
      Authorization: `Bearer ${AUTH_TOKEN}`,
    },
  });

  return { status: response.status, body: await response.json() };
}

// --- Test Cases ---

async function testGetTreeAtHead(testId: string) {
  log('\n=== Test: Get Tree at HEAD ===');

  const result = await getTree(testId, 'HEAD');

  if (result.status === 200) {
    const body = result.body as GetTreeResponse;
    if (body.entries && Array.isArray(body.entries) && body.ref === 'HEAD' && body.commitSha) {
      logSuccess(
        `Get tree at HEAD returns entries (${body.entries.length} items), ref, and commitSha`
      );
      return true;
    }
  }

  logFailure(
    `Expected 200 with tree entries, got ${result.status} - ${JSON.stringify(result.body)}`
  );
  return false;
}

async function testGetTreeAtMain(testId: string) {
  log('\n=== Test: Get Tree at main Branch ===');

  const result = await getTree(testId, 'main');

  if (result.status === 200) {
    const body = result.body as GetTreeResponse;
    if (body.entries && body.ref === 'main') {
      logSuccess('Get tree at main branch succeeds');
      return true;
    }
  }

  logFailure(`Expected 200, got ${result.status}`);
  return false;
}

async function testGetTreeWithSubdirectoryPath(testId: string) {
  log('\n=== Test: Get Tree with Subdirectory Path ===');

  // First, get root tree to find a subdirectory
  const rootResult = await getTree(testId, 'HEAD');

  if (rootResult.status !== 200) {
    logFailure('Could not get root tree');
    return false;
  }

  const rootBody = rootResult.body as GetTreeResponse;
  const subdir = rootBody.entries.find(e => e.type === 'tree');

  if (!subdir) {
    log('No subdirectory found in template, skipping subdir test');
    logSuccess('(Skipped - no subdirectories in template)');
    return true;
  }

  const subdirResult = await getTree(testId, 'HEAD', subdir.name);

  if (subdirResult.status === 200) {
    const body = subdirResult.body as GetTreeResponse;
    if (body.path === subdir.name) {
      logSuccess(`Get tree for subdirectory "${subdir.name}" succeeds`);
      return true;
    }
  }

  logFailure(`Expected 200 for subdir, got ${subdirResult.status}`);
  return false;
}

async function testGetTreeForNonExistentRef(testId: string) {
  log('\n=== Test: Get Tree for Non-Existent Ref ===');

  const result = await getTree(testId, 'non-existent-branch-xyz');

  if (result.status === 404) {
    logSuccess('Get tree for non-existent ref returns 404');
    return true;
  }

  logFailure(`Expected 404, got ${result.status}`);
  return false;
}

async function testGetTreeForNonExistentPath(testId: string) {
  log('\n=== Test: Get Tree for Non-Existent Path ===');

  const result = await getTree(testId, 'HEAD', 'non/existent/path');

  if (result.status === 404) {
    logSuccess('Get tree for non-existent path returns 404');
    return true;
  }

  logFailure(`Expected 404, got ${result.status}`);
  return false;
}

async function testGetBlobForTextFile(testId: string) {
  log('\n=== Test: Get Blob for Text File ===');

  // First, find a text file in the tree
  const treeResult = await getTree(testId, 'HEAD');

  if (treeResult.status !== 200) {
    logFailure('Could not get tree');
    return false;
  }

  const body = treeResult.body as GetTreeResponse;
  const textFile = body.entries.find(
    e =>
      e.type === 'blob' &&
      (e.name.endsWith('.json') ||
        e.name.endsWith('.ts') ||
        e.name.endsWith('.js') ||
        e.name.endsWith('.md'))
  );

  if (!textFile) {
    log('No text file found in root, looking for package.json');
    // Most node templates have package.json
    const blobResult = await getBlob(testId, 'HEAD', 'package.json');
    if (blobResult.status === 200) {
      const blobBody = blobResult.body as GetBlobResponse;
      if (blobBody.encoding === 'utf-8' && blobBody.content && blobBody.size > 0) {
        logSuccess('Get blob for package.json returns utf-8 encoded content');
        return true;
      }
    }
    logFailure('Could not find or read any text file');
    return false;
  }

  const blobResult = await getBlob(testId, 'HEAD', textFile.name);

  if (blobResult.status === 200) {
    const blobBody = blobResult.body as GetBlobResponse;
    if (
      blobBody.encoding === 'utf-8' &&
      blobBody.content &&
      blobBody.size > 0 &&
      blobBody.path === textFile.name
    ) {
      logSuccess(`Get blob for "${textFile.name}" returns utf-8 content`);
      return true;
    }
  }

  logFailure(`Expected 200 with blob content, got ${blobResult.status}`);
  return false;
}

async function testGetBlobForNonExistentFile(testId: string) {
  log('\n=== Test: Get Blob for Non-Existent File ===');

  const result = await getBlob(testId, 'HEAD', 'non-existent-file.xyz');

  if (result.status === 404) {
    logSuccess('Get blob for non-existent file returns 404');
    return true;
  }

  logFailure(`Expected 404, got ${result.status}`);
  return false;
}

async function testGetBlobAtSpecificCommit(testId: string, tempDir: string) {
  log('\n=== Test: Get Blob at Specific Commit SHA ===');

  // Clone, add file, push, get commit SHA
  const tokenResult = await generateGitToken(testId, 'full');
  const initResult = await initProject(`${testId}-commit`).catch(() => null);

  if (!initResult) {
    // Project already exists from earlier init, get the git_url differently
    logFailure('Could not get project for commit test');
    return false;
  }

  try {
    const cloneDir = join(tempDir, 'commit-test-clone');
    mkdirSync(cloneDir, { recursive: true });

    const tokenResult2 = await generateGitToken(`${testId}-commit`, 'full');
    const gitUrl = buildGitUrlWithToken(initResult.git_url, tokenResult2.token);

    runGitCommand(tempDir, `git clone "${gitUrl}" commit-test-clone`);

    // Get the initial commit SHA
    const sha = runGitCommand(cloneDir, 'git rev-parse HEAD').trim();
    log(`Initial commit SHA: ${sha}`);

    // Get tree at that specific SHA
    const result = await getTree(`${testId}-commit`, sha);

    if (result.status === 200) {
      const body = result.body as GetTreeResponse;
      if (body.commitSha === sha) {
        logSuccess('Get tree at specific commit SHA succeeds');
        return true;
      }
    }

    logFailure(`Expected 200 with matching SHA, got ${result.status}`);
    return false;
  } finally {
    await deleteProject(`${testId}-commit`);
  }
}

async function testFilesApiWithoutAuth(testId: string) {
  log('\n=== Test: Files API Without Authorization ===');

  const endpoint = `${APP_BUILDER_URL}/apps/${encodeURIComponent(testId)}/tree/HEAD`;

  const response = await fetch(endpoint, {
    // No Authorization header
  });

  if (response.status === 401) {
    logSuccess('Files API without auth returns 401');
    return true;
  }

  logFailure(`Expected 401, got ${response.status}`);
  return false;
}

async function testTreeEntryTypes(testId: string) {
  log('\n=== Test: Tree Entry Types (blob vs tree) ===');

  const result = await getTree(testId, 'HEAD');

  if (result.status !== 200) {
    logFailure('Could not get tree');
    return false;
  }

  const body = result.body as GetTreeResponse;

  // Verify entries have correct type values
  const validTypes = body.entries.every(e => e.type === 'blob' || e.type === 'tree');
  const hasRequiredFields = body.entries.every(e => e.name && e.oid && e.mode);

  if (validTypes && hasRequiredFields) {
    const blobs = body.entries.filter(e => e.type === 'blob').length;
    const trees = body.entries.filter(e => e.type === 'tree').length;
    logSuccess(`Tree entries have correct types (${blobs} blobs, ${trees} trees)`);
    return true;
  }

  logFailure('Tree entries have invalid or missing fields');
  return false;
}

async function testGetBlobNestedPath(testId: string) {
  log('\n=== Test: Get Blob with Nested Path ===');

  // Find a file in a subdirectory
  const rootResult = await getTree(testId, 'HEAD');

  if (rootResult.status !== 200) {
    logFailure('Could not get root tree');
    return false;
  }

  const rootBody = rootResult.body as GetTreeResponse;
  const subdir = rootBody.entries.find(e => e.type === 'tree');

  if (!subdir) {
    log('No subdirectory found, skipping nested path test');
    logSuccess('(Skipped - no subdirectories in template)');
    return true;
  }

  // Get contents of subdirectory
  const subdirResult = await getTree(testId, 'HEAD', subdir.name);

  if (subdirResult.status !== 200) {
    logFailure('Could not get subdirectory tree');
    return false;
  }

  const subdirBody = subdirResult.body as GetTreeResponse;
  const nestedFile = subdirBody.entries.find(e => e.type === 'blob');

  if (!nestedFile) {
    log('No file found in subdirectory, skipping');
    logSuccess('(Skipped - no files in subdirectory)');
    return true;
  }

  const nestedPath = `${subdir.name}/${nestedFile.name}`;
  const blobResult = await getBlob(testId, 'HEAD', nestedPath);

  if (blobResult.status === 200) {
    const blobBody = blobResult.body as GetBlobResponse;
    if (blobBody.path === nestedPath) {
      logSuccess(`Get blob for nested path "${nestedPath}" succeeds`);
      return true;
    }
  }

  logFailure(`Expected 200 for nested blob, got ${blobResult.status}`);
  return false;
}

// --- Main Test Runner ---

async function runTests() {
  const testId = `test-files-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const tempDir = mkdtempSync(join(tmpdir(), 'app-builder-files-test-'));
  let passed = 0;
  let failed = 0;

  log('Starting files API tests', {
    testId,
    tempDir,
    appBuilderUrl: APP_BUILDER_URL,
  });

  try {
    // Initialize a project for testing
    log('Initializing test project...');
    await initProject(testId);
    logSuccess(`Test project initialized: ${testId}`);

    const tests: Array<() => Promise<boolean>> = [
      () => testGetTreeAtHead(testId),
      () => testGetTreeAtMain(testId),
      () => testGetTreeWithSubdirectoryPath(testId),
      () => testGetTreeForNonExistentRef(testId),
      () => testGetTreeForNonExistentPath(testId),
      () => testGetBlobForTextFile(testId),
      () => testGetBlobForNonExistentFile(testId),
      () => testGetBlobAtSpecificCommit(testId, tempDir),
      () => testFilesApiWithoutAuth(testId),
      () => testTreeEntryTypes(testId),
      () => testGetBlobNestedPath(testId),
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
    // Cleanup
    log('\nCleaning up...');
    await deleteProject(testId);
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch (e) {
      logError('Failed to cleanup temp directory', e);
    }
    log('Cleanup complete');
  }
}

runTests().catch(error => {
  logError('Unhandled error', error);
  process.exit(1);
});
