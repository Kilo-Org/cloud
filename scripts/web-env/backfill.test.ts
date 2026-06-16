import assert from 'node:assert/strict';
import test from 'node:test';
import { createBackfillReport, formatBackfillReport } from './backfill-report.js';

void test('backfill report is copyable and contains statuses without values', () => {
  const report = createBackfillReport();
  report.migrated.push('POSTGRES_URL');
  report.alreadySensitive.push('NEXTAUTH_SECRET');
  report.productionMismatches.push('MISMATCHED_TOKEN');
  report.stagingUnresolved.push('STAGING_TOKEN');
  report.skipped.push('PUBLIC_ID');
  report.failed.push('FAILED_TOKEN');

  const output = formatBackfillReport(report, '2026-06-16T12:00:00.000Z');
  assert.match(output, /POSTGRES_URL/);
  assert.match(output, /NEXTAUTH_SECRET/);
  assert.match(output, /MISMATCHED_TOKEN/);
  assert.match(output, /STAGING_TOKEN/);
  assert.match(output, /PUBLIC_ID/);
  assert.match(output, /FAILED_TOKEN/);
  assert.equal(output.includes('production-secret-value'), false);
});
