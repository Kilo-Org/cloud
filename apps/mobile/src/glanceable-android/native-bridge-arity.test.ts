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
