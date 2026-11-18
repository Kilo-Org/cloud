/* eslint-disable eslint-plugin-import/no-nodejs-modules, eslint-plugin-unicorn/prefer-module -- this test reads the Kotlin receiver from disk, which is the only place its wake-lock order is observable */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const RECEIVER_SOURCE = readFileSync(
  join(
    __dirname,
    '../../modules/active-agents-live-update/android/src/main/java/com/kilocode/activeagentsliveupdate/ActiveAgentsApproveReceiver.kt'
  ),
  'utf8'
);

/**
 * The receiver runs only on Android, which no harness reaches under vitest, so
 * the source is the only place its contract is observable. `HeadlessJsTaskService`
 * exposes no public release for the lock `acquireWakeLockNow` takes — the task
 * service releases it in `onDestroy` — so a lock taken before a refused
 * `startService` (API 26+ background service limits) is never released. The
 * order in the source is therefore the contract.
 */
describe('ActiveAgentsApproveReceiver', () => {
  it('takes the wake lock only after the service start is accepted', () => {
    const start = RECEIVER_SOURCE.indexOf('startService(');
    const wakeLock = RECEIVER_SOURCE.indexOf('acquireWakeLockNow(');
    expect(start).toBeGreaterThan(-1);
    expect(wakeLock).toBeGreaterThan(start);
  });

  it('cannot let a refused start escape with the lock still held', () => {
    // The start must sit in a try whose catch gives up before the lock is taken:
    // a throw otherwise escapes `onReceive` and leaves the static lock held.
    const handler = RECEIVER_SOURCE.slice(RECEIVER_SOURCE.indexOf('override fun onReceive'));
    const tryIndex = handler.indexOf('try {');
    const catchIndex = handler.indexOf('catch (');
    expect(tryIndex).toBeGreaterThan(-1);
    expect(catchIndex).toBeGreaterThan(tryIndex);
    expect(handler.slice(catchIndex)).toMatch(/\breturn\b/);
  });
});
