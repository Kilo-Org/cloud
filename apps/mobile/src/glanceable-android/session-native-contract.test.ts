/* eslint-disable eslint-plugin-import/no-nodejs-modules, eslint-plugin-unicorn/prefer-module, max-lines -- this test reads the Kotlin sources from disk, the only place their contract is observable without an Android build */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { SILENT_ANDROID_NOTIFICATION_CHANNEL_IDS } from '@/lib/android-notification-channels';

/**
 * The session notification path is Kotlin plus a JS bridge, and only an Android
 * build compiles the Kotlin half. Two defects shipped that a compiler or an
 * emulator caught first: a call to a card helper that did not exist, and a
 * dismissal that cancelled the card but never told JS to unfollow. These tests
 * read the sources so both classes fail here, on any machine.
 */

const KOTLIN_DIR = join(
  __dirname,
  '../../modules/active-agents-live-update/android/src/main/java/com/kilocode/activeagentsliveupdate'
);

function kotlin(file: string): string {
  return readFileSync(join(KOTLIN_DIR, file), 'utf8');
}

const MODULE = kotlin('ActiveAgentsLiveUpdateModule.kt');
const NOTIFICATIONS = kotlin('SessionNotifications.kt');
const RECEIVER = kotlin('ActiveAgentsActionReceiver.kt');
const WORKER = kotlin('ActiveAgentsApproveWorker.kt');
const BRIDGE = readFileSync(join(__dirname, 'session-notification.ts'), 'utf8');
const APPROVE_TASK = readFileSync(join(__dirname, 'approve-task.ts'), 'utf8');
const REGISTER = readFileSync(join(__dirname, 'register.ts'), 'utf8');

/** The text of one Kotlin function body, from its signature to its closing brace. */
function body(source: string, signature: string): string {
  const start = source.indexOf(signature);
  expect(start, `${signature} is missing`).toBeGreaterThan(-1);
  let depth = 0;
  for (let index = source.indexOf('{', start); index < source.length; index += 1) {
    if (source[index] === '{') {
      depth += 1;
    } else if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, index + 1);
      }
    }
  }
  return source.slice(start);
}

/** Names matched by `pattern`'s first group, as a sorted unique list. */
function names(source: string, pattern: RegExp): string[] {
  return [...new Set([...source.matchAll(pattern)].map(match => match[1] ?? ''))].toSorted();
}

describe('SessionNotificationCard', () => {
  const fields = names(body(NOTIFICATIONS, 'class SessionNotificationCard'), /@Field var (\w+)/g);

  it('writes and reads back every field it declares', () => {
    expect(fields.length).toBeGreaterThan(0);
    const written = names(body(NOTIFICATIONS, 'fun toJson()'), /put\("(\w+)"/g);
    const read = names(body(NOTIFICATIONS, 'fun fillFromJson('), /^\s+(\w+) = /gm);
    expect(written).toEqual(fields);
    expect(read).toEqual(fields);
  });

  it('declares every field the JS bridge sends', () => {
    const sent = names(body(BRIDGE, 'export type SessionNotificationCard = {'), /^\s{2}(\w+): /gm);
    expect(sent).toEqual(fields);
  });

  it('reads an absent optional field as absent, never as the text "null"', () => {
    const reader = body(NOTIFICATIONS, 'fun fillFromJson(');
    for (const field of [
      'organizationId',
      'subText',
      'expandedText',
      'quietText',
      'compactText',
      'approveLabel',
      'approvalKey',
    ]) {
      expect(reader, `${field} must go through optionalString`).toContain(
        `${field} = optionalString(json, "${field}")`
      );
    }
    expect(body(NOTIFICATIONS, 'private fun optionalString(')).toContain('json.isNull(key)');
  });

  it('parses the bridge JSON with the reader the store writes for', () => {
    expect(MODULE).toContain('fillFromJson(JSONObject(cardJson))');
  });
});

describe('SessionNotifications', () => {
  it('defines every helper the module and the receiver call', () => {
    const called = names(MODULE + RECEIVER, /SessionNotifications\.(\w+)\(/g);
    expect(called.length).toBeGreaterThan(0);
    for (const name of called) {
      expect(NOTIFICATIONS, `SessionNotifications.${name} is never defined`).toContain(
        `fun ${name}(`
      );
    }
  });

  it('arms the finished-card timeout only where the API has it', () => {
    const post = body(NOTIFICATIONS, 'fun post(');
    expect(post).toMatch(
      /if \(timeoutMs > 0 && Build\.VERSION\.SDK_INT >= 26\) \{\s+builder\.setTimeoutAfter/
    );
  });

  it('keeps a finished card stored, marked with its window, so a teardown can cancel it', () => {
    // The restore reads `finishedUntil` to keep it out of the followed set; the
    // teardown's prune cancels every stored card, so an unstored one would
    // survive a sign-out.
    const post = body(NOTIFICATIONS, 'fun post(');
    expect(post).toMatch(
      /if \(timeoutMs > 0\) \{\s+stored\.put\(FINISHED_UNTIL, nowMs \+ timeoutMs\)/
    );
    expect(post).toContain('putString(KEY_PREFIX + card.sessionId, stored.toString())');
    expect(post).not.toContain('editor.remove(');
    expect(NOTIFICATIONS).toContain('private const val FINISHED_UNTIL = "finishedUntil"');
    expect(BRIDGE).toContain('finishedUntil: z.number().optional()');
  });

  it('gives each session its own explicit notification group', () => {
    expect(body(NOTIFICATIONS, 'private fun builder(')).toMatch(
      /\.setGroup\("followed-session:\$\{card\.sessionId\}"\)/
    );
    expect(NOTIFICATIONS).not.toContain('setGroupSummary(true)');
  });

  it('names a session through the shared identity, never through a derived id', () => {
    // The notification pair and every action record carry the whole session id,
    // so one session can never take another's card or another's action.
    const gate = kotlin('ApprovalGate.kt');
    const identity = kotlin('SessionNotificationIdentity.kt');
    const post = body(NOTIFICATIONS, 'fun post(');
    const cancel = body(NOTIFICATIONS, 'fun cancel(');
    expect(post).toContain('SessionNotificationIdentity.tag(card.sessionId)');
    expect(post).toContain('SessionNotificationIdentity.NOTIFICATION_ID');
    expect(cancel).toContain('SessionNotificationIdentity.tag(sessionId)');
    expect(cancel).toContain('SessionNotificationIdentity.NOTIFICATION_ID');
    expect(body(NOTIFICATIONS, 'private fun quietIntent(')).toContain(
      'SessionNotificationIdentity.sessionData(sessionId)'
    );
    expect(body(NOTIFICATIONS, 'private fun dismissIntent(')).toContain(
      'SessionNotificationIdentity.sessionData(sessionId)'
    );
    expect(body(gate, 'fun intent(')).toContain(
      'SessionNotificationIdentity.sessionData(sessionId)'
    );
    // The Approve record carries the ask as well as the session, so a newer ask
    // is a different record and cannot rewrite the one the card in the shade
    // still shows.
    expect(body(gate, 'fun intent(')).toContain(
      'SessionNotificationIdentity.askData(sessionId, approvalKey)'
    );
    // Nothing outside the retirement helpers may derive an identity from a hash.
    expect(identity).toContain('fun legacyNotificationId(');
    expect(identity).toContain('fun legacyRequestCode(');
    expect(NOTIFICATIONS).not.toContain('hashCode()');
  });

  it('restores the persisted live card through the same native posting path', () => {
    const restore = body(NOTIFICATIONS, 'fun restore(');
    expect(restore).toContain('getString(KEY_PREFIX + sessionId, null) ?: return');
    expect(restore).toContain('json.has(FINISHED_UNTIL)');
    expect(restore).toContain('fillFromJson(json)');
    expect(restore).toContain('post(context, SessionNotificationCard()');
    expect(MODULE).toContain('AsyncFunction("restoreSession")');
    expect(MODULE).toContain('SessionNotifications.restore(context, sessionId)');
  });

  it('retires an earlier card before this post builds its own records', () => {
    // The retirement acts only on records the earlier build left, so it runs
    // before the post that builds this session's own records.
    const post = body(NOTIFICATIONS, 'fun post(');
    const retirement = post.indexOf('cancelLegacy(context, card.sessionId, card)');
    const build = post.indexOf('val builder = builder(');
    expect(retirement).toBeGreaterThan(-1);
    expect(build).toBeGreaterThan(-1);
    expect(retirement).toBeLessThan(build);
  });

  it('retires a card under both Approve identities a build could have posted it', () => {
    // A card posted before the Approve record carried its ask keeps that record
    // under the session alone, so a teardown that cancelled only the ask-keyed
    // one would leave a stale Approve action behind its card.
    const actions = body(NOTIFICATIONS, 'private fun cancelActions(');
    const askKeyed = actions.indexOf(
      'ApprovalGate.cancel(context, APPROVE_REQUEST_CODE, sessionId, approvalKey)'
    );
    const sessionOnly = actions.indexOf(
      'ApprovalGate.cancel(context, APPROVE_REQUEST_CODE, sessionId, null)'
    );
    expect(askKeyed, 'the ask-keyed record must be cancelled').toBeGreaterThan(-1);
    expect(sessionOnly, 'the session-only record must be cancelled too').toBeGreaterThan(-1);
    expect(sessionOnly).toBeGreaterThan(askKeyed);
  });

  it('starts restoration even when registration loads after the app became active', () => {
    expect(REGISTER).toMatch(
      /if \(AppState\.currentState === 'active'\) \{\s+void sessionFollowStorage\(\)\.restoreFollowedSessionCardsFromStorage\(\)/
    );
  });

  it('keeps the notification silent independently of channel importance', () => {
    const build = body(NOTIFICATIONS, 'private fun builder(');
    expect(build).toContain('.setSound(null)');
    expect(build).toContain('.setVibrate(null)');
    expect(build).toContain('.setOnlyAlertOnce(true)');
  });

  it('posts the followed card on the channel the JS side creates silent', () => {
    // The channel id exists in two languages. Reading the Kotlin literal into the
    // JS list is what fails when either side renames the channel.
    const channelId = /private const val CHANNEL_ID = "([^"]+)"/.exec(NOTIFICATIONS)?.[1];
    expect(channelId).toBeDefined();
    expect(SILENT_ANDROID_NOTIFICATION_CHANNEL_IDS).toContain(channelId);
  });
});

describe('a post that does not land leaves the card answering the request it shows', () => {
  const post = body(NOTIFICATIONS, 'fun post(');
  const abandon = body(NOTIFICATIONS, 'private fun abandonPost(');

  it('reads the previous ask before it writes the stored card', () => {
    // A post that does not land leaves the previous card in the shade, so the
    // facts that describe it must be read before this call overwrites them.
    const read = post.indexOf('val previousApprovalKey = approvalKeyOf(previousJson)');
    const write = post.indexOf('putString(KEY_PREFIX + card.sessionId, stored.toString())');
    expect(read, 'post must read the previous ask').toBeGreaterThan(-1);
    expect(write, 'post must write the stored card').toBeGreaterThan(-1);
    expect(read).toBeLessThan(write);
  });

  it('treats a post the system cannot show as one that did not land', () => {
    // `notify` answers nothing, and it discards a post when the app or the card's
    // channel is turned off. Both are read before the post: reading the posted
    // set afterwards would race the system's own enqueue.
    const notify = post.indexOf('manager(context).notify(');
    const check = post.indexOf('if (!canShow(context, CHANNEL_ID)) {');
    expect(notify, 'post must post the card').toBeGreaterThan(-1);
    expect(check, 'post must check the card can be shown').toBeGreaterThan(-1);
    expect(check).toBeLessThan(notify);
    // Bounded to the branch: an unbounded slice would also match the catch's
    // call, so deleting this branch's call would still pass.
    expect(post.slice(check, notify)).toContain(
      'abandonPost(context, card, previousJson, previousApprovalKey)'
    );
    const canShow = body(NOTIFICATIONS, 'private fun canShow(');
    expect(canShow).toContain('manager.areNotificationsEnabled()');
    expect(canShow).toContain('channel.importance != NotificationManager.IMPORTANCE_NONE');
    expect(NOTIFICATIONS, 'nothing may read the posted set to decide this').not.toContain(
      'activeNotifications'
    );
  });

  it('puts the previous stored card back inside the catch a failed post falls into', () => {
    const guard = post.indexOf('} catch (error: Throwable) {');
    const rethrow = post.indexOf('throw error', guard);
    expect(guard, 'post must guard its own post').toBeGreaterThan(-1);
    expect(rethrow, 'the catch must rethrow').toBeGreaterThan(guard);
    // The catch is the second caller: the drop branch above it handles a post
    // the system discarded without throwing.
    const catchBody = post.slice(guard, rethrow);
    expect(catchBody, 'the catch must abandon the post').toContain(
      'abandonPost(context, card, previousJson, previousApprovalKey)'
    );
    expect(abandon).toContain('restoreStored(context, card.sessionId, previousJson)');
    const restoreStored = body(NOTIFICATIONS, 'private fun restoreStored(');
    expect(restoreStored).toContain('editor.putString(KEY_PREFIX + sessionId, previousJson)');
    expect(restoreStored, 'no predecessor leaves nothing stored').toContain(
      'editor.remove(KEY_PREFIX + sessionId)'
    );
  });

  it('drops a newer ask only when it differs from the one the card shows', () => {
    // A re-post of the same ask must leave that ask's record alone: it is the one
    // the card in the shade is serving.
    expect(abandon).toMatch(
      /if \(card\.approvalKey != null && card\.approvalKey != previousApprovalKey\) \{\s+ApprovalGate\.cancel\(context, APPROVE_REQUEST_CODE, card\.sessionId, card\.approvalKey\)/
    );
  });

  it('retires the superseded ask only after the card is posted, and records it first', () => {
    const notify = post.indexOf('manager(context).notify(');
    const sweep = post.indexOf('sweepRetiring(context, card.sessionId)');
    const retire = post.indexOf('retire(context, card.sessionId, previousApprovalKey)');
    expect(notify, 'post must post the card').toBeGreaterThan(-1);
    expect(sweep, 'post must sweep an ask a crash left recorded').toBeGreaterThan(notify);
    expect(retire, 'the superseded ask must be retired').toBeGreaterThan(sweep);
    // The record names the ask before cancelling it, so a crash between the two
    // steps leaves it for the next post or teardown.
    const retireBody = body(NOTIFICATIONS, 'private fun retire(');
    const record = retireBody.indexOf('keys -> keys + approvalKey');
    const cancel = retireBody.indexOf('ApprovalGate.cancel(');
    expect(record, 'retire must record the ask first').toBeGreaterThan(-1);
    expect(cancel).toBeGreaterThan(record);
    expect(retireBody.slice(cancel)).toContain('keys -> keys - approvalKey');
  });

  it('retires an ask a crash left recorded from the teardown too', () => {
    expect(body(NOTIFICATIONS, 'fun cancel(')).toContain(
      'sweepRetiring(context, sessionId)'
    );
    expect(NOTIFICATIONS).toContain('private const val RETIRING_PREFIX = "retiring:"');
  });

  it('arms no quiet moment on the failure path', () => {
    // The surviving card keeps whatever quiet moment it already had.
    const rethrow = post.indexOf('throw error');
    const schedule = post.indexOf('scheduleQuiet(context, card, nowMs)');
    expect(rethrow, 'the catch must rethrow').toBeGreaterThan(-1);
    expect(schedule, 'post must arm the quiet moment').toBeGreaterThan(rethrow);
  });
});

describe('the shared card helpers', () => {
  const GATE = kotlin('PromotionGate.kt');
  const STYLE = kotlin('CardStyle.kt');
  const BUILDERS = kotlin('CardBuilders.kt');

  it('asks the promotion question in the gate alone, never in either card', () => {
    // A capability tested twice can promote one card and fall back on the other.
    expect(GATE).toContain('canPostPromotedNotifications()');
    expect(MODULE).not.toContain('canPostPromotedNotifications');
    expect(NOTIFICATIONS).not.toContain('canPostPromotedNotifications');
  });

  it('requests promotion through the documented extra, never the unsettable flag', () => {
    // The platform clears FLAG_PROMOTED_ONGOING from every post, so setting it
    // promotes nothing; one request form keeps both cards promotable.
    expect(MODULE + NOTIFICATIONS).not.toContain('FLAG_PROMOTED_ONGOING');
    expect(GATE).toContain('putBoolean(EXTRA_REQUEST_PROMOTED_ONGOING, true)');
  });

  it('looks the drawable name up once, so a rename has one place to land', () => {
    // A second copy of the drawable name silently posts a card with no icon.
    expect(STYLE).toContain('getIdentifier(ICON, "drawable"');
    expect(MODULE + NOTIFICATIONS).not.toContain('getIdentifier(');
  });

  it('spells the day-primary hex once and reports a refused card write', () => {
    // A copied hex drifts from global.css, and a dropped commit loses the card.
    expect((MODULE + NOTIFICATIONS + STYLE).match(/#4F5A10/g)).toHaveLength(1);
    expect(body(NOTIFICATIONS, 'fun post(')).toContain('commitOrReport(');
    expect(body(NOTIFICATIONS, 'fun cancel(')).toContain('commitOrReport(');
  });

  it('builds both cards through one builder fork and one action record', () => {
    // A second copy of the fork can correct the legacy branch on one card only.
    expect(BUILDERS).toContain('Notification.Builder(context, channelId)');
    expect(BUILDERS).toContain('Notification.Action.Builder(');
    expect(BUILDERS).toContain('Build.VERSION.SDK_INT >= 26');
    expect(MODULE + NOTIFICATIONS).not.toContain('Notification.Builder(');
    expect(MODULE + NOTIFICATIONS).not.toContain('Notification.Action.Builder(');
  });
});

describe('the quiet moment of a Working card', () => {
  it('posts the card as it shows now, then arms or disarms its quiet alarm', () => {
    const post = body(NOTIFICATIONS, 'fun post(');
    expect(post).toContain('builder(context, card.shownAt(nowMs))');
    expect(post.indexOf('scheduleQuiet(context, card, nowMs)')).toBeGreaterThan(
      post.indexOf('.notify(')
    );
    const schedule = body(NOTIFICATIONS, 'private fun scheduleQuiet(');
    expect(
      schedule.indexOf('alarmManager.cancel(operation)'),
      'scheduleQuiet must cancel before it arms'
    ).toBeGreaterThan(-1);
    expect(schedule.indexOf('alarmWhileIdle('), 'scheduleQuiet must arm').toBeGreaterThan(-1);
    expect(schedule.indexOf('alarmManager.cancel(operation)')).toBeLessThan(
      schedule.indexOf('alarmWhileIdle(')
    );
  });

  it('reads the clock once per post, so the drawn card and the quiet alarm agree', () => {
    const post = body(NOTIFICATIONS, 'fun post(');
    expect(post.match(/System\.currentTimeMillis\(\)/g)).toHaveLength(1);
    expect(post).toContain('val nowMs = System.currentTimeMillis()');
    const schedule = body(NOTIFICATIONS, 'private fun scheduleQuiet(');
    expect(schedule).toContain('nowMs: Long');
    expect(schedule).not.toContain('System.currentTimeMillis()');
    expect(schedule).toContain('if (quietAt <= nowMs');
  });

  it('swaps to the quiet text and the last-activity timer once the window passed', () => {
    const shown = body(NOTIFICATIONS, 'fun shownAt(');
    expect(shown).toContain('nowMs < quietAtMs.toLong()');
    expect(shown).toContain('shown.text = quiet');
    expect(shown).toContain('shown.whenMs = quietWhenMs');
  });

  it('re-posts only the stored card that armed the alarm', () => {
    const quiet = body(NOTIFICATIONS, 'fun postQuiet(');
    expect(quiet).toContain('?: return');
    expect(quiet).toContain('json.has(FINISHED_UNTIL)');
    expect(quiet).toContain('card.quietAtMs.toLong() != quietAtMs');
    expect(body(NOTIFICATIONS, 'fun cancel(')).toContain('quietIntent(context, sessionId, 0)');
  });

  it('routes the quiet alarm to the re-post, with no JS', () => {
    const receive = body(RECEIVER, 'override fun onReceive(');
    const quiet = receive.slice(receive.indexOf('if (action == ACTION_QUIET)'));
    expect(quiet).toMatch(
      /SessionNotifications\.postQuiet\(context, sessionId, intent\.getLongExtra\(EXTRA_QUIET_AT, 0\)\)/
    );
    expect(quiet.slice(0, quiet.indexOf('return'))).not.toContain('enqueueHeadless');
    expect(body(NOTIFICATIONS, 'private fun quietIntent(')).toContain(
      '.setAction(ActiveAgentsActionReceiver.ACTION_QUIET)'
    );
  });

  it('draws the expanded-only line in the big-text style alone, never in the header', () => {
    const build = body(NOTIFICATIONS, 'private fun builder(');
    const anchor = build.indexOf('PromotionGate.request(context, builder, card.compactText)');
    // indexOf answers -1 for a missing anchor, and slice(-1) would start at the
    // end and pass on an empty fallback, so the anchor must be found first.
    expect(anchor, 'the promotion gate call is missing').toBeGreaterThan(-1);
    const fallback = build.slice(build.indexOf('} else {', anchor));
    expect(fallback).toContain('card.expandedText?.let');
    expect(fallback).toContain('Notification.BigTextStyle().bigText(');
    expect(build.match(/expandedText/g)).toHaveLength(1);
    expect(build).toContain('.setSubText(card.subText)');
  });

  it('hides the relative system time on every card that does not count up', () => {
    const build = body(NOTIFICATIONS, 'private fun builder(');
    expect(build).toContain('builder.setWhen(0).setShowWhen(false)');
    expect(build.match(/setWhen\(card\.whenMs\.toLong\(\)\)/g)).toHaveLength(1);
    expect(NOTIFICATIONS).not.toContain('@Field var showWhen');
  });
});

describe('ActiveAgentsActionReceiver', () => {
  const receive = body(RECEIVER, 'override fun onReceive(');
  const dismiss = receive.slice(receive.indexOf('if (action == ACTION_DISMISS)'));
  const quiet = receive.slice(receive.indexOf('if (action == ACTION_QUIET)'));

  it('routes a dismissal to the headless unfollow, after dropping the stored card', () => {
    const cancel = dismiss.indexOf('SessionNotifications.cancel(context, sessionId)');
    const enqueue = dismiss.indexOf('enqueueDismiss(');
    expect(cancel, 'the stored card must be dropped').toBeGreaterThan(-1);
    expect(enqueue, 'the dismissal must reach headless JS').toBeGreaterThan(cancel);
    expect(dismiss.slice(enqueue)).toMatch(/enqueueDismiss\(context, sessionId\)/);
  });

  it('keeps the card writes off the broadcast thread', () => {
    // The receiver's own contract is that it only enqueues: the prefs fsync,
    // the notify and the alarm calls belong to the process's durable queue.
    for (const [branch, call] of [
      [quiet, 'SessionNotifications.postQuiet('],
      [dismiss, 'SessionNotifications.cancel('],
    ] as const) {
      const queued = branch.indexOf('enqueueDurableWrite {');
      expect(queued, `${call} must be queued`).toBeGreaterThan(-1);
      expect(branch.indexOf(call), `${call} must run inside the queued body`).toBeGreaterThan(
        queued
      );
    }
  });

  it('gives each dismissed session its own work, so a clear-all unfollows all of them', () => {
    expect(RECEIVER).toContain('private const val DISMISS_WORK_PREFIX = "active-agents-dismiss:"');
    expect(body(RECEIVER, 'private fun enqueueDismiss(')).toContain(
      'enqueueUniqueWork("$DISMISS_WORK_PREFIX$sessionId", ExistingWorkPolicy.KEEP, request)'
    );
  });

  it('starts the worker that runs the registered headless task', () => {
    const enqueue = body(RECEIVER, 'private fun enqueueDismiss(');
    expect(enqueue).toContain('OneTimeWorkRequest.Builder(ActiveAgentsApproveWorker::class.java)');
    expect(enqueue).toContain('.putString(ActiveAgentsApproveWorker.KEY_ACTION, ACTION_DISMISS)');
    expect(enqueue).toContain('.putString(ActiveAgentsApproveWorker.KEY_SESSION_ID, sessionId)');
    expect(WORKER).toContain('Arguments.makeNativeMap(inputData.keyValueMap)');
    expect(WORKER).toContain('const val KEY_ACTION = "action"');
    expect(WORKER).toContain('const val KEY_SESSION_ID = "session_id"');
  });

  it('names the dismissal action the JS task reads', () => {
    const kotlinAction = /const val ACTION_DISMISS = "([^"]+)"/.exec(RECEIVER)?.[1];
    const jsAction = /export const SESSION_DISMISS_ACTION = '([^']+)'/.exec(APPROVE_TASK)?.[1];
    expect(kotlinAction).toBeDefined();
    expect(jsAction).toBe(kotlinAction);
  });
});

describe('the Approve presence gate', () => {
  const GATE = kotlin('ApprovalGate.kt');
  const BUILDERS = kotlin('CardBuilders.kt');
  const ACTIVITY = kotlin('ActiveAgentsApprovalActivity.kt');
  const MANIFEST = readFileSync(join(KOTLIN_DIR, '../../../../AndroidManifest.xml'), 'utf8');

  it('sends every Approve action through the gate activity', () => {
    expect(MODULE).not.toContain('PendingIntent.getBroadcast');
    expect(MODULE).toContain(
      'ApprovalGate.pendingIntent(context, APPROVE_REQUEST_CODE, sessionId, approvalKey)'
    );
    expect(NOTIFICATIONS).toContain('ApprovalGate.pendingIntent(');
    expect(GATE).toContain('PendingIntent.getActivity(');
    expect(MANIFEST).toContain('com.kilocode.activeagentsliveupdate.ActiveAgentsApprovalActivity');
    expect(MANIFEST).toMatch(/ActiveAgentsApprovalActivity"[\s\S]*?android:exported="false"/);
  });

  it('marks the action with the platform authentication requirement where it exists', () => {
    expect(GATE).toContain(
      'CardBuilders.action(context, icon, label, pendingIntent, authenticationRequired = true)'
    );
    expect(BUILDERS).toMatch(
      /if \(authenticationRequired && Build\.VERSION\.SDK_INT >= 31\) \{\s+setAuthenticationRequired\(true\)/
    );
    expect(MODULE).toContain('ApprovalGate.action(context, icon, it, approvePendingIntent())');
    expect(NOTIFICATIONS).toContain(
      'ApprovalGate.action(context, icon, label, approveIntent(context, card))'
    );
  });

  it('runs the approval after the keyguard is dismissed, on every API', () => {
    const create = body(ACTIVITY, 'override fun onCreate(');
    expect(create).toContain('if (!ApprovalGate.isDeviceLocked(this))');
    expect(create).toContain('keyguard().requestDismissKeyguard(');
    expect(create).toMatch(/if \(Build\.VERSION\.SDK_INT < 26\) \{\s+finish\(\)/);
    expect(ACTIVITY).toContain('override fun onDismissSucceeded() = approveAndFinish()');
    expect(ACTIVITY).toContain('override fun onDismissCancelled() = finish()');
    expect(ACTIVITY).toContain('override fun onDismissError() = finish()');
  });

  it("routes an older card's action through the same unlocked-device check", () => {
    const receive = body(RECEIVER, 'override fun onReceive(');
    expect(receive).toContain('if (ApprovalGate.isDeviceLocked(context))');
    expect(receive.slice(receive.indexOf('ApprovalGate.isDeviceLocked'))).toContain(
      'ApprovalGate.enqueue(context, intent)'
    );
  });

  it('names each ask its own work, so a different approval is not dropped', () => {
    const enqueue = body(GATE, 'fun enqueue(');
    expect(enqueue).toContain('workName(sessionId, approvalKey)');
    expect(enqueue).not.toContain('ActiveAgentsApproveWorker.UNIQUE_WORK_NAME');

    const name = body(GATE, 'private fun workName(');
    // A session card names the ask it answers; the aggregate card, which passes
    // neither extra, keeps the one name its recorded ask already scopes.
    expect(name).toContain('if (sessionId == null || approvalKey == null) {');
    expect(name).toContain('return ActiveAgentsApproveWorker.UNIQUE_WORK_NAME');
    expect(name).toContain('APPROVE_WORK_PREFIX');
    expect(name).toMatch(/\$\{sessionId\.length\}:\$sessionId\$approvalKey/);
    expect(GATE).toContain('private const val APPROVE_WORK_PREFIX = "active-agents-approve:"');
  });
});

describe('ActiveAgentsDeadlineReceiver', () => {
  const DEADLINE = kotlin('ActiveAgentsDeadlineReceiver.kt');

  it('reports a refused commit and keeps the process alive', () => {
    // Both commits run on a broadcast and on the JS bridge; neither has an
    // error surface, and a throw on the broadcast thread ends the process.
    expect(DEADLINE).not.toContain('check(');
    expect(DEADLINE).toContain(
      'Log.e(ACTIVE_AGENTS_TAG, "Cannot persist the active agents deadline")'
    );
    expect(DEADLINE).toContain(
      'Log.e(ACTIVE_AGENTS_TAG, "Cannot consume the active agents deadline")'
    );
    expect(body(DEADLINE, 'private fun replace(')).toMatch(
      /if \(!editor\.commit\(\)\) \{\s+Log\.e\([\s\S]*?\n\s+return\n\s+\}/
    );
    expect(body(DEADLINE, 'private fun expire(')).toMatch(
      /if \(!preferences\.edit\(\)[\s\S]*?commit\(\)\) \{\s+Log\.e\([\s\S]*?\n\s+return\n\s+\}/
    );
  });

  it('runs both broadcast branches on the durable queue', () => {
    const receive = body(DEADLINE, 'override fun onReceive(');
    expect(receive).toMatch(/enqueueDurableWrite \{ restoreWidgetDeadline\(context\) \}/);
    expect(receive).toMatch(/enqueueDurableWrite \{ expire\(context, intent\) \}/);
  });

  it('stores the deadline before it arms the alarm', () => {
    const replace = body(DEADLINE, 'private fun replace(');
    expect(replace.indexOf('if (!editor.commit())')).toBeLessThan(replace.indexOf('AlarmManager'));
    expect(replace).toContain('if (deadline <= System.currentTimeMillis())');
  });
});
