/**
 * Shared helpers for git integration tests.
 *
 * These run real `git` CLI commands against a locally running
 * cloudflare-app-builder worker (default http://localhost:8790).
 */

import { execSync } from 'child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// --- Configuration ---

export const APP_BUILDER_URL = process.env.APP_BUILDER_URL || 'http://localhost:8790';
export const AUTH_TOKEN = process.env.AUTH_TOKEN || 'dev-token-change-this-in-production';

// --- Types ---

export type TokenPermission = 'full' | 'ro';

export type InitSuccessResponse = {
  success: true;
  app_id: string;
  git_url: string;
};

export type TokenResponse = {
  success: true;
  token: string;
  expires_at: string;
  permission: TokenPermission;
};

// --- Logging ---

export function log(message: string, data?: unknown) {
  console.log(`[TEST] ${message}`, data ? JSON.stringify(data, null, 2) : '');
}

export function logError(message: string, error?: unknown) {
  console.error(`[ERROR] ${message}`, error);
}

export function logSuccess(message: string) {
  console.log(`[✓] ${message}`);
}

export function logFailure(message: string) {
  console.error(`[✗] ${message}`);
}

// --- API helpers ---

export async function initProject(projectId: string): Promise<InitSuccessResponse> {
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

export async function generateGitToken(
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

// --- Git CLI helpers ---

export function buildGitUrlWithToken(gitUrl: string, token: string): string {
  const url = new URL(gitUrl);
  url.username = 'x-access-token';
  url.password = token;
  return url.toString();
}

function stringProp(obj: unknown, key: string): string | undefined {
  if (obj != null && typeof obj === 'object' && key in obj) {
    const val = (obj as Record<string, unknown>)[key];
    return typeof val === 'string' ? val : undefined;
  }
  return undefined;
}

function numberProp(obj: unknown, key: string): number | undefined {
  if (obj != null && typeof obj === 'object' && key in obj) {
    const val = (obj as Record<string, unknown>)[key];
    return typeof val === 'number' ? val : undefined;
  }
  return undefined;
}

export function runGitCommand(dir: string, command: string, expectFailure = false): string {
  const fullCommand = `cd "${dir}" && ${command}`;
  log(`Running: ${command}`);

  try {
    const output = execSync(fullCommand, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (expectFailure) {
      throw new Error(`Expected command to fail but it succeeded: ${command}`);
    }
    return output;
  } catch (error: unknown) {
    if (expectFailure) {
      const stderr = stringProp(error, 'stderr');
      const stdout = stringProp(error, 'stdout');
      const message = stringProp(error, 'message');
      log('Command failed as expected', {
        stderr: stderr?.slice(0, 500),
        stdout: stdout?.slice(0, 500),
      });
      return stderr || message || 'Command failed';
    }
    throw error;
  }
}

/**
 * Run a git command and return stdout, ignoring non-zero exit codes.
 * Useful for commands like `git symbolic-ref HEAD` that fail in detached state.
 */
export function runGitCommandSafe(
  dir: string,
  command: string
): { stdout: string; stderr: string; exitCode: number } {
  const fullCommand = `cd "${dir}" && ${command}`;

  try {
    const stdout = execSync(fullCommand, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { stdout: stdout.trim(), stderr: '', exitCode: 0 };
  } catch (error: unknown) {
    return {
      stdout: (stringProp(error, 'stdout') || '').trim(),
      stderr: (stringProp(error, 'stderr') || '').trim(),
      exitCode: numberProp(error, 'status') ?? 1,
    };
  }
}

// --- High-level helpers ---

/**
 * Clone a repository into a subdirectory of `parentDir`.
 * Returns the absolute path to the cloned directory.
 */
export async function cloneRepo(
  appId: string,
  gitUrl: string,
  parentDir: string,
  dirName: string
): Promise<string> {
  const tokenResult = await generateGitToken(appId, 'full');
  const authedUrl = buildGitUrlWithToken(gitUrl, tokenResult.token);
  const cloneDir = join(parentDir, dirName);
  mkdirSync(cloneDir, { recursive: true });
  runGitCommand(parentDir, `git clone "${authedUrl}" ${dirName}`);
  return cloneDir;
}

/**
 * Configure git user in the given directory.
 */
export function configureGitUser(dir: string) {
  runGitCommand(dir, 'git config user.email "test@example.com"');
  runGitCommand(dir, 'git config user.name "Test User"');
}

/**
 * Stage everything, commit, and optionally push.
 */
export function commitAll(dir: string, message: string) {
  runGitCommand(dir, 'git add -A');
  runGitCommand(dir, `git commit -m "${message}"`);
}

export function push(dir: string, branch = 'main') {
  runGitCommand(dir, `git push origin ${branch}`);
}

// --- Temp dir management ---

export function createTempDir(prefix = 'app-builder-test-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function removeTempDir(dir: string) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    logError('Failed to cleanup temp directory', e);
  }
}

// --- Assertions ---

export class AssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssertionError';
  }
}

export function assertEqual<T>(actual: T, expected: T, label: string) {
  if (actual !== expected) {
    throw new AssertionError(
      `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
    );
  }
}

export function assertIncludes(haystack: string, needle: string, label: string) {
  if (!haystack.includes(needle)) {
    throw new AssertionError(
      `${label}: expected string to include ${JSON.stringify(needle)}, got ${JSON.stringify(haystack.slice(0, 200))}`
    );
  }
}

export function assertFileContent(
  dir: string,
  relativePath: string,
  expected: string,
  label: string
) {
  const content = readFileSync(join(dir, relativePath), 'utf-8');
  assertEqual(content, expected, label);
}

export function assertFileExists(dir: string, relativePath: string, label: string) {
  try {
    readFileSync(join(dir, relativePath));
  } catch {
    throw new AssertionError(`${label}: file "${relativePath}" does not exist in ${dir}`);
  }
}

/**
 * Assert that the working directory is on a named branch (NOT detached HEAD).
 * Runs multiple independent checks.
 */
export function assertNotDetachedHead(dir: string, expectedBranch = 'main') {
  // Check 1: git branch --show-current (empty in detached HEAD)
  const branchShowCurrent = runGitCommandSafe(dir, 'git branch --show-current');
  assertEqual(branchShowCurrent.stdout, expectedBranch, 'git branch --show-current');

  // Check 2: git symbolic-ref HEAD (errors in detached HEAD)
  const symbolicRef = runGitCommandSafe(dir, 'git symbolic-ref HEAD');
  assertEqual(symbolicRef.exitCode, 0, 'git symbolic-ref HEAD exit code');
  assertEqual(symbolicRef.stdout, `refs/heads/${expectedBranch}`, 'git symbolic-ref HEAD');

  // Check 3: git rev-parse --abbrev-ref HEAD (returns "HEAD" if detached)
  const abbrevRef = runGitCommandSafe(dir, 'git rev-parse --abbrev-ref HEAD');
  assertEqual(abbrevRef.stdout, expectedBranch, 'git rev-parse --abbrev-ref HEAD');

  // Check 4: git status should say "On branch main", not "HEAD detached"
  const status = runGitCommandSafe(dir, 'git status');
  assertIncludes(status.stdout, `On branch ${expectedBranch}`, 'git status branch line');
}

/**
 * Count commits in the current branch's history.
 */
export function countCommits(dir: string): number {
  const output = runGitCommand(dir, 'git rev-list --count HEAD');
  return parseInt(output.trim(), 10);
}

/**
 * Get the list of commit messages (most recent first).
 */
export function getCommitMessages(dir: string): string[] {
  const output = runGitCommand(dir, 'git log --format=%s');
  return output
    .trim()
    .split('\n')
    .filter(line => line.length > 0);
}

// --- Test runner ---

export type TestFn = () => Promise<void>;

/**
 * Run a set of named test functions, collecting pass/fail results.
 * Returns `true` if all tests passed.
 */
export async function runTestSuite(
  suiteName: string,
  tests: Array<{ name: string; fn: TestFn }>
): Promise<boolean> {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  ${suiteName}`);
  console.log('='.repeat(60));

  const results: Array<{ name: string; passed: boolean; error?: string }> = [];

  for (const test of tests) {
    console.log(`\n--- ${test.name} ---`);
    try {
      await test.fn();
      logSuccess(test.name);
      results.push({ name: test.name, passed: true });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logFailure(`${test.name}: ${msg}`);
      results.push({ name: test.name, passed: false, error: msg });
    }
  }

  // Summary
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  Results: ${suiteName}`);
  console.log('='.repeat(60));

  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;

  for (const r of results) {
    console.log(`  ${r.passed ? '✓' : '✗'} ${r.name}${r.error ? ` — ${r.error}` : ''}`);
  }

  console.log(`\n  ${passed} passed, ${failed} failed\n`);

  return failed === 0;
}

// Re-export fs utilities for convenience
export { writeFileSync, readFileSync, readdirSync, mkdirSync, join };
