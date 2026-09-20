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
 * remember the URL it posted and cancel the superseded record — but only once
 * the post carrying the new record lands. Cancelling it first would leave the
 * card still in the shade after a failed post with no record to serve or track.
 */
function segment(from: string, to: string): string {
  const start = MODULE_SOURCE.indexOf(from);
  expect(start, `${from} is missing from the native module`).toBeGreaterThan(-1);
  const end = MODULE_SOURCE.indexOf(to, start);
  expect(end, `${to} is missing after ${from}`).toBeGreaterThan(start);
  return MODULE_SOURCE.slice(start, end);
}

describe('ActiveAgentsLiveUpdate Open PendingIntent records', () => {
  it('creates the Open record without retiring the previous one before the post can fail', () => {
    const open = segment('private fun openPendingIntent', 'private fun cancelOpenIntent');
    expect(open, 'openPendingIntent must create the record').toContain(
      'PendingIntent.getActivity('
    );
    expect(
      open,
      'openPendingIntent must not cancel the previous record before the post can fail'
    ).not.toContain('cancelOpenIntent(');
    expect(
      open,
      'openPendingIntent must not name the new URL before the post can fail'
    ).not.toContain('putString(OPEN_URL');
  });

  it('retires the superseded record only after a successful post', () => {
    const post = segment('private fun post(', 'private fun dismiss()');
    const notify = post.indexOf('notificationManager.notify(');
    expect(notify, 'post no longer posts the notification').toBeGreaterThan(-1);
    const commit = post.indexOf('commitOpenUrl(previousOpenUrl, openUrl)');
    expect(commit, 'post must commit the Open URL only after the post lands').toBeGreaterThan(
      notify
    );
  });

  it('drops the record a failed post created and keeps the previous URL', () => {
    const post = segment('private fun post(', 'private fun dismiss()');
    const catchStart = post.indexOf('catch (error', post.indexOf('notificationManager.notify('));
    expect(catchStart, 'post no longer handles a failed notify').toBeGreaterThan(-1);
    const rethrow = post.indexOf('throw error', catchStart);
    expect(rethrow).toBeGreaterThan(catchStart);
    expect(
      post.slice(catchStart, rethrow),
      'a failed post must drop the Open record it created'
    ).toContain('cancelOpenIntent(openUrl)');
  });

  it('cancels the previous record and remembers the new URL when committing', () => {
    const commit = segment('private fun commitOpenUrl', 'private fun approvePendingIntent');
    expect(commit).toContain('cancelOpenIntent(previousUrl)');
    expect(commit).toContain('putString(OPEN_URL, openUrl)');
  });

  it('asks for the existing record only when cancelling', () => {
    const cancel = segment('private fun cancelOpenIntent', 'private fun commitOpenUrl');
    expect(cancel, 'cancelOpenIntent must not create a record it means to remove').toContain(
      'FLAG_NO_CREATE'
    );
    expect(cancel).toContain('.cancel()');
  });

  it('remembers the posted URL and forgets it on dismiss', () => {
    const dismiss = segment('private fun dismiss()', 'private companion object');
    expect(dismiss, 'dismiss must drop the Open record it no longer serves').toContain(
      'remove(OPEN_URL)'
    );
  });
});
