/* eslint-disable eslint-plugin-import/no-nodejs-modules, eslint-plugin-unicorn/prefer-module -- this test reads the Kotlin module and its JS bridge from disk, the only place their argument contract is observable under vitest */
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

const BRIDGE_SOURCE = readFileSync(join(__dirname, 'live-update.ts'), 'utf8');

/**
 * Expo's `Function` builder declares one overload per arity and stops at eight
 * (expo-modules-core `ObjectDefinitionBuilder`: `reified P0` … `reified P7`). A
 * native `Function` registered with a ninth argument does not resolve any
 * overload, so the Kotlin module fails to compile and `app:assembleDebug` dies
 * — a failure only the native android job sees. The declared arity and the
 * argument list the JS bridge hands across must therefore stay within that
 * limit and agree with each other.
 */
const EXPO_FUNCTION_MAX_ARGS = 8;

/** Commas at nesting depth zero, so `Map<String, Any>` counts as one argument. */
function countTopLevelArgs(list: string): number {
  const trimmed = list.trim();
  if (trimmed === '') {
    return 0;
  }
  let depth = 0;
  let args = 1;
  for (const char of trimmed) {
    if (char === '<' || char === '(' || char === '[' || char === '{') {
      depth += 1;
    } else if (char === '>' || char === ')' || char === ']' || char === '}') {
      depth -= 1;
    } else if (char === ',' && depth === 0) {
      args += 1;
    }
  }
  return args;
}

/** The arity the Kotlin `Function("<name>") { … }` lambda declares. */
function declaredArity(name: string): number {
  const marker = `Function("${name}") {`;
  const start = MODULE_SOURCE.indexOf(marker);
  expect(start, `${marker} is missing from the native module`).toBeGreaterThan(-1);
  const body = MODULE_SOURCE.slice(start + marker.length);
  const arrow = body.indexOf('->');
  const close = body.indexOf('\n    }');
  expect(close).toBeGreaterThan(-1);
  if (arrow === -1 || arrow > close) {
    return 0;
  }
  return countTopLevelArgs(body.slice(0, arrow));
}

/** The argument count the JS wrapper passes to `nativeModule?.<name>(…)`. */
function bridgedArity(name: string): number {
  const marker = `nativeModule?.${name}(`;
  const start = BRIDGE_SOURCE.indexOf(marker);
  expect(start, `${marker} is missing from live-update.ts`).toBeGreaterThan(-1);
  const args = BRIDGE_SOURCE.slice(start + marker.length);
  let depth = 1;
  let end = -1;
  for (let index = 0; index < args.length; index += 1) {
    const char = args[index];
    if (char === '(') {
      depth += 1;
    } else if (char === ')') {
      depth -= 1;
      if (depth === 0) {
        end = index;
        break;
      }
    }
  }
  expect(end).toBeGreaterThan(-1);
  return countTopLevelArgs(args.slice(0, end));
}

/**
 * One registration in the module's `definition()`, from its builder call to the
 * next one. `AsyncFunction("x") {` still contains the `Function("x") {` marker
 * `declaredArity` looks for; this helper reads whichever builder is used so a
 * test can assert the queue attached to a single entry point.
 */
function registration(name: string): string {
  const builder = new RegExp(`(?:Async)?Function\\("${name}"\\)\\s*\\{`);
  const start = MODULE_SOURCE.search(builder);
  expect(start, `${name} is not registered on the native module`).toBeGreaterThan(-1);
  const marker = builder.exec(MODULE_SOURCE.slice(start));
  const after = marker === null ? MODULE_SOURCE.length : start + marker[0].length;
  const next = /(?:Async)?Function\("/.exec(MODULE_SOURCE.slice(after));
  return MODULE_SOURCE.slice(start, next === null ? MODULE_SOURCE.length : after + next.index);
}

describe('ActiveAgentsLiveUpdate native bridge arity', () => {
  it('keeps every native Function within Expo’s eight-argument builder limit', () => {
    for (const name of [
      'isPromotionCapable',
      'start',
      'update',
      'end',
      'setWidgetSnapshot',
      'getWidgetSnapshot',
    ]) {
      expect(declaredArity(name), `${name} declares too many arguments`).toBeLessThanOrEqual(
        EXPO_FUNCTION_MAX_ARGS
      );
    }
  });

  it('passes exactly the arguments the native Function declares', () => {
    expect(bridgedArity('start')).toBe(declaredArity('start'));
    expect(bridgedArity('update')).toBe(declaredArity('update'));
  });
});

/**
 * The durable write path — a prefs fsync plus one or more binder round-trips —
 * must not run on the JavaScript thread, and the JS bridge declares these
 * entry points `void`, so a rejection would reach nobody. Every write runs on
 * one single-thread executor, shared by every module instance in the process
 * so no instance's queued write can land after a replacement's newer write.
 */
describe('ActiveAgentsLiveUpdate durable write queue', () => {
  it('owns one single-thread executor, not a pool or the UI thread', () => {
    // Queues.DEFAULT is a pool and Queues.MAIN would put the fsync on the UI
    // thread, so neither satisfies the finding.
    expect((MODULE_SOURCE.match(/newSingleThreadExecutor/g) ?? []).length).toBe(1);
    expect(MODULE_SOURCE).toContain('Thread(it, "active-agents-live-update")');
    expect(MODULE_SOURCE).toContain('CoroutineScope(');
    expect(MODULE_SOURCE).toContain('asCoroutineDispatcher()');
  });

  it('runs every durable write on that queue', () => {
    for (const name of ['start', 'update', 'end']) {
      const block = registration(name);
      expect(block, `${name} must be an AsyncFunction`).toMatch(
        new RegExp(`^AsyncFunction\\("${name}"\\)`)
      );
      expect(block, `${name} must run on the module queue`).toContain('.runOnQueue(moduleQueue)');
      expect(block, `${name} must not stay on the default or main queue`).not.toContain('Queues.');
    }

    // `setWidgetSnapshot` keeps the durable commit on the queue but records the
    // snapshot on the JS thread first, so a read in the same turn as the write
    // sees the value the JS side just issued instead of the pre-write storage.
    const write = registration('setWidgetSnapshot');
    expect(write, 'setWidgetSnapshot must stay a synchronous Function').toMatch(
      /^Function\("setWidgetSnapshot"\)/
    );
    expect(write, 'setWidgetSnapshot must submit its durable body to the module queue').toContain(
      'durableQueue.execute'
    );
    expect(write, 'the JS thread must not run the prefs commit itself').not.toContain('.commit()');
    expect(write, 'setWidgetSnapshot must not stay on the default or main queue').not.toContain(
      'Queues.'
    );
  });

  it('answers a read with the write the JS side last issued', () => {
    const write = registration('setWidgetSnapshot');
    expect(write, 'setWidgetSnapshot must record the snapshot it carries').toMatch(
      /widgetSnapshot\s*=\s*snapshot/
    );

    const read = registration('getWidgetSnapshot');
    expect(read, 'getWidgetSnapshot must stay a synchronous Function').toMatch(
      /^Function\("getWidgetSnapshot"\)/
    );
    const recorded = read.indexOf('widgetSnapshot');
    const fallback = read.indexOf('ActiveAgentsDeadlineReceiver.getWidgetSnapshot(');
    expect(recorded, 'getWidgetSnapshot must consult the recorded snapshot').toBeGreaterThan(-1);
    expect(fallback, 'getWidgetSnapshot must fall back to persisted storage').toBeGreaterThan(-1);
    expect(
      recorded,
      'the recorded snapshot must be returned before the persisted read'
    ).toBeLessThan(fallback);
  });

  it('keeps the synchronous read path on the JS thread', () => {
    // A Promise form would change the JS bridge and its consumers
    // (`live-update.ts`, `register.ts`, `android-sink.ts`), which this item
    // does not own.
    for (const name of [
      'isPromotionCapable',
      'isDndAccessGranted',
      'getWidgetSnapshot',
      'getPostedChannel',
    ]) {
      const block = registration(name);
      expect(block, `${name} must stay a synchronous Function`).toMatch(
        new RegExp(`^Function\\("${name}"\\)`)
      );
      expect(block, `${name} must not be queued`).not.toContain('.runOnQueue(');
    }
  });

  it('keeps the queue process-wide so a replacement module cannot race it', () => {
    // Destroying a module cannot drain its queue, so a per-instance executor
    // would let a replaced module's already-queued write land after the
    // replacement's newer write. One shared queue keeps every durable write in
    // submission order across instances, and nothing may stop it on destroy:
    // the work a replacement instance queued would otherwise never run.
    expect(MODULE_SOURCE, 'the queue must be one shared executor').toContain(
      'val durableQueue: ExecutorService'
    );
    expect(MODULE_SOURCE, 'the queue must live in the companion object').toMatch(
      /private companion object \{[\s\S]*val durableQueue: ExecutorService/
    );
    expect(MODULE_SOURCE, 'no lifecycle hook may stop the shared queue').not.toContain(
      '.shutdown()'
    );
  });
});
