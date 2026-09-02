import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { waitForEnvValueChange } from './runner.ts';

void test('stops waiting when the capture process exits', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'capture-wait-'));
  const envPath = path.join(directory, '.env');
  writeFileSync(envPath, 'STRIPE_WEBHOOK_SECRET=old-secret\n');

  let livenessChecks = 0;
  const startedAt = Date.now();
  try {
    const changed = await waitForEnvValueChange(
      envPath,
      'STRIPE_WEBHOOK_SECRET',
      'old-secret',
      2_000,
      undefined,
      () => {
        livenessChecks++;
        return false;
      }
    );

    assert.equal(changed, false);
    assert.equal(livenessChecks, 1);
    assert.ok(
      Date.now() - startedAt < 1_500,
      'exited capture process should not use the full timeout'
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

void test('accepts a captured value before checking process liveness', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'capture-wait-'));
  const envPath = path.join(directory, '.env');
  writeFileSync(envPath, 'STRIPE_WEBHOOK_SECRET=new-secret\n');

  try {
    const changed = await waitForEnvValueChange(
      envPath,
      'STRIPE_WEBHOOK_SECRET',
      'old-secret',
      2_000,
      undefined,
      () => false
    );

    assert.equal(changed, true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
