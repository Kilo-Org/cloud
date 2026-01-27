/**
 * Debug Logger for GitLab Code Reviews
 *
 * Writes debug information to a local file for troubleshooting
 * the GitLab code review flow.
 *
 * Log file: /tmp/gitlab-code-review-debug.log
 *
 * WARNING: This logger outputs FULL tokens for debugging purposes.
 * DO NOT use in production or commit logs containing tokens!
 */

import { appendFileSync, writeFileSync } from 'fs';

const LOG_FILE = '/tmp/gitlab-code-review-debug.log';

type LogData = Record<string, unknown>;

function formatLogEntry(context: string, message: string, data?: LogData): string {
  const timestamp = new Date().toISOString();
  const dataStr = data ? `\n  Data: ${JSON.stringify(data, null, 2).replace(/\n/g, '\n  ')}` : '';
  return `[${timestamp}] [${context}] ${message}${dataStr}\n`;
}

/**
 * Log a debug message to the file
 */
export function debugLog(context: string, message: string, data?: LogData): void {
  try {
    const entry = formatLogEntry(context, message, data);
    appendFileSync(LOG_FILE, entry);
    // Also log to console for visibility
    console.log(`[GITLAB-DEBUG] ${context}: ${message}`, data || '');
  } catch {
    // Silently fail if we can't write to the file
    console.error('[GITLAB-DEBUG] Failed to write to log file');
  }
}

/**
 * Clear the log file and start fresh
 */
export function clearDebugLog(): void {
  try {
    writeFileSync(
      LOG_FILE,
      `=== GitLab Code Review Debug Log ===\nStarted: ${new Date().toISOString()}\n\n`
    );
  } catch {
    // Silently fail
  }
}

/**
 * Log a separator for a new review
 */
export function logReviewStart(reviewId: string, platform: string): void {
  debugLog('REVIEW-START', `Starting review ${reviewId}`, { reviewId, platform });
  try {
    appendFileSync(LOG_FILE, `\n${'='.repeat(80)}\n`);
    appendFileSync(LOG_FILE, `NEW REVIEW: ${reviewId} (${platform})\n`);
    appendFileSync(LOG_FILE, `${'='.repeat(80)}\n\n`);
  } catch {
    // Silently fail
  }
}

/**
 * Log token information - FULL TOKEN for debugging
 * WARNING: This outputs the full token! Only use for local debugging.
 */
export function logTokenInfo(context: string, tokenName: string, token: string | undefined): void {
  if (!token) {
    debugLog(context, `${tokenName}: NOT SET`);
    return;
  }

  // Log the FULL token for debugging purposes
  debugLog(context, `${tokenName}: ${token} (length: ${token.length})`);
}

/**
 * Log environment variable information - FULL VALUES for debugging
 * WARNING: This outputs full values including tokens! Only use for local debugging.
 */
export function logEnvVars(context: string, envVars: Record<string, string>): void {
  // Log all env vars with full values for debugging
  debugLog(context, 'Environment variables (FULL VALUES)', envVars);
}
