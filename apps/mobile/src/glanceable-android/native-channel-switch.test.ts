/* eslint-disable eslint-plugin-import/no-nodejs-modules, eslint-plugin-unicorn/prefer-module -- this test reads the Kotlin module from disk, the only place its channel-switch contract is observable under vitest */
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
 * The card keeps one fixed notification id while its kind, and so its channel,
 * changes. The framework replaces a post's channel on that id, but a post to a
 * channel the user disabled is dropped instead of moved, and the previous
 * kind's card would stay in the shade on the old channel. `post` must therefore
 * clear the posted card before it re-posts on a different channel.
 */
function segment(from: string, to: string): string {
  const start = MODULE_SOURCE.indexOf(from);
  expect(start, `${from} is missing from the native module`).toBeGreaterThan(-1);
  const end = MODULE_SOURCE.indexOf(to, start);
  expect(end, `${to} is missing after ${from}`).toBeGreaterThan(start);
  return MODULE_SOURCE.slice(start, end);
}

describe('ActiveAgentsLiveUpdate channel switch', () => {
  it('reads the channel the module last posted from its own state', () => {
    const postedChannelId = segment('private fun postedChannelId()', 'private fun newBuilder');
    expect(postedChannelId).toContain('notificationState.getString(POSTED_CHANNEL, null)');
    // No version fork: `Notification.channelId` exists only on API 26+, while
    // the module's mirror holds the channel on every supported API.
    expect(postedChannelId).not.toContain('Build.VERSION.SDK_INT');
    expect(postedChannelId).not.toContain('activeNotifications');
  });

  it('mirrors the posted channel on every post', () => {
    const post = segment('private fun post(', 'private fun dismiss()');
    expect(post).toContain('putString(POSTED_CHANNEL, channelId)');
  });

  it('clears the posted card before re-posting on a different channel', () => {
    const post = segment('private fun post(', 'private fun dismiss()');
    const comparison = post.indexOf('previousChannelId != channelId');
    expect(
      comparison,
      'post does not compare the requested channel with the posted channel'
    ).toBeGreaterThan(-1);
    const cancel = post.indexOf('notificationManager.cancel(', comparison);
    expect(cancel, 'post does not cancel the posted card on a channel switch').toBeGreaterThan(
      comparison
    );
    const notify = post.indexOf('notificationManager.notify(');
    expect(notify, 'post no longer posts the notification').toBeGreaterThan(cancel);
  });

  it('exposes the posted marker and removes it on dismiss', () => {
    // The JS side adopts the kind after a restart from this marker; the widget
    // snapshot is stored whether or not a card was posted, so it cannot prove
    // the card exists.
    expect(MODULE_SOURCE).toContain('Function("getPostedChannel")');
    const dismiss = segment('private fun dismiss()', 'private companion object');
    expect(dismiss).toContain('remove(POSTED_CHANNEL)');
  });

  it('confirms the fixed card is still posted before handing back its channel', () => {
    // A terminal timeout removes the notification without any further app call,
    // so the stored marker alone can outlive the card; the getter must also
    // check the framework's active notifications for the fixed id.
    const getter = segment('private fun postedChannelOrNull()', 'private fun post(');
    expect(getter).toContain('postedChannelId()');
    expect(getter).toContain('activeNotifications');
    expect(getter).toContain('NOTIFICATION_ID');
  });

  it('clears the failed post marker only when that post removed the card', () => {
    const post = segment('private fun post(', 'private fun dismiss()');
    const notify = post.indexOf('notificationManager.notify(');
    const catchStart = post.indexOf('catch (error', notify);
    expect(catchStart, 'post no longer handles a failed notify').toBeGreaterThan(notify);
    const clearing = post.indexOf('remove(POSTED_CHANNEL)', catchStart);
    expect(clearing, 'a failed post must clear the marker it could not confirm').toBeGreaterThan(
      catchStart
    );
    // `notify` is also the update path: a same-channel post removes no card and
    // leaves the previous one in the shade, so its marker must survive the
    // failure. The clear is guarded on whether this call removed that card.
    const guard = post.lastIndexOf('previousChannelId != channelId', clearing);
    expect(
      guard,
      'the failure path must not clear the marker of a card still in the shade'
    ).toBeGreaterThan(catchStart);
  });
});
