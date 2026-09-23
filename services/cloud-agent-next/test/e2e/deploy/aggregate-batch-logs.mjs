#!/usr/bin/env node
/**
 * Aggregate the per-batch deployed E2E logs produced by the `batches` matrix.
 *
 * Dependency-free Node (no npm packages). Usage:
 *
 *   node aggregate-batch-logs.mjs '<json-array-of-batch-names>' [log-dir]
 *
 * `argv[2]` is the expected batch names as a JSON array (an empty string or an
 * empty array means "no batches expected"); `argv[3]` is the directory holding
 * the merged `e2e-batch-<name>.log` artifacts and defaults to `.`.
 *
 * Per expected batch the outcome is one of:
 *
 *   ok            valid accounting: a `Summary:` line whose counts sum to the
 *                 `Batch:` header's scenario count
 *   missing-log   `e2e-batch-<name>.log` is absent
 *   no-summary    the log has no `^Summary: …$` line
 *   inconsistent  the summary counts do not sum to the header's count, or the
 *                 header is missing / does not name the expected batch
 *
 * `ok` means the accounting is valid, NOT that the tests passed: a batch whose
 * own `Summary` reports failures is still `ok` here and its failed count flows
 * into the combined summary. A broken or truncated log can therefore never be
 * silently hidden — it is a non-`ok` batch and adds one failure.
 *
 * The per-batch table and exactly one combined summary line are always printed
 * and, when `GITHUB_STEP_SUMMARY` is set, appended to it. The process exits
 * non-zero when any expected batch is not `ok`.
 */

import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const BATCH_LOG_PREFIX = 'e2e-batch-';
const BATCH_HEADER = /^Batch: (.+) \((\d+) scenarios, concurrency (\d+)\)$/gm;
const SUMMARY_LINE = /^Summary: (\d+) passed, (\d+) failed, (\d+) unsupported$/gm;

/** Last match in the log: the runner's own lines come after any child output. */
function lastMatch(text, regex) {
  let match = null;
  for (const candidate of text.matchAll(regex)) match = candidate;
  return match;
}

function parseExpectedBatches(raw) {
  if (raw === undefined || raw.trim() === '') return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`expected batch names are not valid JSON: ${error.message}`);
  }
  if (!Array.isArray(parsed) || parsed.some(name => typeof name !== 'string')) {
    throw new Error('expected batch names must be a JSON array of strings');
  }
  return parsed;
}

function classifyBatch(name, logDirectory) {
  const logFile = `${BATCH_LOG_PREFIX}${name}.log`;
  const logPath = path.join(logDirectory, logFile);
  if (!existsSync(logPath)) {
    return { name, status: 'missing-log', detail: `no ${logFile}` };
  }

  const text = readFileSync(logPath, 'utf8');
  const summary = lastMatch(text, SUMMARY_LINE);
  if (summary === null) {
    return { name, status: 'no-summary', detail: 'log has no Summary line' };
  }
  const passed = Number(summary[1]);
  const failed = Number(summary[2]);
  const unsupported = Number(summary[3]);

  const header = lastMatch(text, BATCH_HEADER);
  if (header === null) {
    return {
      name,
      status: 'inconsistent',
      passed,
      failed,
      unsupported,
      detail: 'log has no Batch header',
    };
  }
  const headerName = header[1];
  const scenarios = Number(header[2]);
  if (headerName !== name) {
    return {
      name,
      status: 'inconsistent',
      passed,
      failed,
      unsupported,
      detail: `header names batch "${headerName}"`,
    };
  }
  if (passed + failed + unsupported !== scenarios) {
    return {
      name,
      status: 'inconsistent',
      passed,
      failed,
      unsupported,
      detail: `${passed}+${failed}+${unsupported} != ${scenarios} header count`,
    };
  }
  return { name, status: 'ok', passed, failed, unsupported, detail: '' };
}

function renderTable(results) {
  const columns = ['Batch', 'Status', 'Passed', 'Failed', 'Unsupported', 'Detail'];
  const rows = results.map(result => [
    result.name,
    result.status,
    result.status === 'ok' ? String(result.passed ?? 0) : '-',
    result.status === 'ok' ? String(result.failed ?? 0) : '-',
    result.status === 'ok' ? String(result.unsupported ?? 0) : '-',
    result.detail ?? '',
  ]);
  const widths = columns.map((column, index) =>
    Math.max(column.length, ...rows.map(row => row[index].length))
  );
  const renderRow = row => row.map((cell, index) => cell.padEnd(widths[index])).join('  ');
  return [renderRow(columns), ...rows.map(renderRow)].join('\n');
}

function combine(results) {
  const combined = { passed: 0, failed: 0, unsupported: 0 };
  for (const result of results) {
    if (result.status === 'ok') {
      combined.passed += result.passed;
      combined.failed += result.failed;
    } else {
      // A non-`ok` batch is a failure in its own right, regardless of whether
      // its log carried partial counts.
      combined.failed += 1;
    }
    // Unsupported is parsed independently of the accounting status: the header
    // `<n>` is what an inconsistent batch fails on, and its unsupported count
    // is still a real skip count that must not be dropped from the total.
    if (typeof result.unsupported === 'number') {
      combined.unsupported += result.unsupported;
    }
  }
  return combined;
}

function main() {
  const logDirectory = process.argv[3] ?? '.';
  const expected = parseExpectedBatches(process.argv[2]);
  const results = expected.map(name => classifyBatch(name, logDirectory));
  const combined = combine(results);

  const output = [
    renderTable(results),
    '',
    `Summary: ${combined.passed} passed, ${combined.failed} failed, ${combined.unsupported} unsupported`,
  ].join('\n');

  console.log(output);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `## Deployed E2E batches\n\n\`\`\`\n${output}\n\`\`\`\n`
    );
  }

  if (results.some(result => result.status !== 'ok')) process.exitCode = 1;
}

try {
  main();
} catch (error) {
  console.error(`aggregate-batch-logs failed: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}
