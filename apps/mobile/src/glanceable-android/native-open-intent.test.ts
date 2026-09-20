/* eslint-disable eslint-plugin-import/no-nodejs-modules, eslint-plugin-unicorn/prefer-module -- this test reads the Kotlin module from disk, the only place its PendingIntent contract is observable under vitest */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const MODULE_SOURCE = readFileSync(
  join(
    __dirname,
    '../../modules/active-agents-live-update/android/src/main/java/com/kilocode/activeagentsliveupdate/ActiveAgentsLiveUpdateModule.kt'
  ),
  'utf8'
);

/**
 * The Open action deep-links to the recorded session, so its Intent data URI
 * changes with every waiting session. `PendingIntent.getActivity` matches on
 * `Intent.filterEquals`, which includes that URI: the fixed request code with
 * FLAG_UPDATE_CURRENT cannot reuse the previous session's record, and each new
 * URL would leave another system record behind. The module must therefore
 * remember the URL it posted and cancel the superseded record.
 */
function segment(from: string, to: string): string {
  const start = MODULE_SOURCE.indexOf(from);
  expect(start, `${from} is missing from the native module`).toBeGreaterThan(-1);
  const end = MODULE_SOURCE.indexOf(to, start);
  expect(end, `${to} is missing after ${from}`).toBeGreaterThan(start);
  return MODULE_SOURCE.slice(start, end);
}

describe('ActiveAgentsLiveUpdate Open PendingIntent records', () => {
  it('cancels the superseded session URL record before creating the next one', () => {
    const open = segment('private fun openPendingIntent', 'private fun cancelOpenIntent');
    const cancel = open.indexOf('cancelOpenIntent(previousUrl)');
    const create = open.indexOf('PendingIntent.getActivity(');
    expect(
      cancel,
      'openPendingIntent does not cancel the previous Open URL record'
    ).toBeGreaterThan(-1);
    expect(
      create,
      'openPendingIntent must create the new record after cancelling the old one'
    ).toBeGreaterThan(cancel);
  });

  it('asks for the existing record only when cancelling', () => {
    const cancel = segment('private fun cancelOpenIntent', 'private fun approvePendingIntent');
    expect(cancel, 'cancelOpenIntent must not create a record it means to remove').toContain(
      'FLAG_NO_CREATE'
    );
    expect(cancel).toContain('.cancel()');
  });

  it('remembers the posted URL and forgets it on dismiss', () => {
    const open = segment('private fun openPendingIntent', 'private fun cancelOpenIntent');
    expect(open).toContain('putString(OPEN_URL, openUrl)');
    const dismiss = segment('private fun dismiss()', 'private companion object');
    expect(dismiss, 'dismiss must drop the Open record it no longer serves').toContain(
      'remove(OPEN_URL)'
    );
  });
});
