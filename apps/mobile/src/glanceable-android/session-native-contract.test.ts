/* eslint-disable eslint-plugin-import/no-nodejs-modules, eslint-plugin-unicorn/prefer-module -- this test reads the Kotlin sources from disk, the only place their contract is observable without an Android build */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

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
      /if \(timeoutMs > 0\) \{\s+stored\.put\(FINISHED_UNTIL, System\.currentTimeMillis\(\) \+ timeoutMs\)/
    );
    expect(post).toContain('putString(KEY_PREFIX + card.sessionId, stored.toString())');
    expect(post).not.toContain('editor.remove(');
    expect(NOTIFICATIONS).toContain('private const val FINISHED_UNTIL = "finishedUntil"');
    expect(BRIDGE).toContain('finishedUntil: z.number().optional()');
  });
});

describe('the quiet moment of a Working card', () => {
  it('posts the card as it shows now, then arms or disarms its quiet alarm', () => {
    const post = body(NOTIFICATIONS, 'fun post(');
    expect(post).toContain('builder(context, card.shownAt(System.currentTimeMillis()))');
    expect(post.indexOf('scheduleQuiet(context, card)')).toBeGreaterThan(post.indexOf('.notify('));
    const schedule = body(NOTIFICATIONS, 'private fun scheduleQuiet(');
    expect(schedule.indexOf('alarmManager.cancel(operation)')).toBeLessThan(
      schedule.indexOf('setAndAllowWhileIdle')
    );
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

  it('hides the relative system time on every card that does not count up', () => {
    const build = body(NOTIFICATIONS, 'private fun builder(');
    expect(build).toMatch(/\} else \{[^}]*\}\s+builder\.setShowWhen\(false\)/);
    expect(NOTIFICATIONS).not.toContain('showWhen');
  });
});

describe('ActiveAgentsActionReceiver', () => {
  const receive = body(RECEIVER, 'override fun onReceive(');
  const dismiss = receive.slice(receive.indexOf('if (action == ACTION_DISMISS)'));

  it('routes a dismissal to the headless unfollow, after dropping the stored card', () => {
    const cancel = dismiss.indexOf('SessionNotifications.cancel(context, sessionId)');
    const enqueue = dismiss.indexOf('enqueueHeadless(');
    expect(cancel, 'the stored card must be dropped').toBeGreaterThan(-1);
    expect(enqueue, 'the dismissal must reach headless JS').toBeGreaterThan(cancel);
    expect(dismiss.slice(enqueue)).toMatch(
      /enqueueHeadless\(context, "\$DISMISS_WORK_PREFIX\$sessionId", ACTION_DISMISS, sessionId, null\)/
    );
  });

  it('gives each dismissed session its own work, so a clear-all unfollows all of them', () => {
    expect(RECEIVER).toContain('private const val DISMISS_WORK_PREFIX = "active-agents-dismiss:"');
    expect(body(RECEIVER, 'private fun enqueueHeadless(')).toContain(
      'enqueueUniqueWork(uniqueName, ExistingWorkPolicy.KEEP, request)'
    );
  });

  it('starts the worker that runs the registered headless task', () => {
    const enqueue = body(RECEIVER, 'private fun enqueueHeadless(');
    expect(enqueue).toContain('OneTimeWorkRequest.Builder(ActiveAgentsApproveWorker::class.java)');
    expect(enqueue).toContain('.putString(ActiveAgentsApproveWorker.KEY_ACTION, action)');
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
