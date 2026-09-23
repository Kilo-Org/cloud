// eslint-disable-next-line import/no-nodejs-modules -- vitest-only guard, runs in node, never bundled into the app
import { readFileSync } from 'node:fs';
// eslint-disable-next-line import/no-nodejs-modules -- vitest-only guard, runs in node, never bundled into the app
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * The observer runs on the Android UI thread, so no host without a device can
 * execute it. This guard reads the Kotlin source and asserts the shape the
 * allocation fix requires: the per-frame pre-draw pass reuses preallocated
 * scratch objects, compares the six measured values through a mutable holder
 * instead of building a map, and runs the full measurement only when a cheap
 * signal changed. A return to per-frame allocation or per-frame measurement
 * fails here instead of on a device.
 *
 * The JS contract is unchanged: `snapshot()` still returns the six-field map
 * (`src/lib/native-surface-geometry.ts`) and one event is emitted per change.
 */

const SOURCE = readFileSync(
  fileURLToPath(
    new URL(
      'android/src/main/java/expo/modules/kilosurfacegeometry/KiloSurfaceGeometryModule.kt',
      import.meta.url
    )
  ),
  'utf8'
);

/** A Kotlin function body: the text between its opening and matching braces. */
function functionBody(source: string, name: string): string {
  const signature = new RegExp(String.raw`fun\s+${name}\s*\(`).exec(source);
  if (signature === null) {
    return '';
  }
  const open = source.indexOf('{', signature.index);
  if (open === -1) {
    return '';
  }
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const character = source[index];
    if (character === '{') {
      depth += 1;
    } else if (character === '}') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(open + 1, index);
      }
    }
  }
  return '';
}

/** The observer's `private val <name> = <type>()` initialisers, by field name. */
function scratchFields(type: string): string[] {
  const declaration = new RegExp(String.raw`private val (\w+) = ${type}\(\)`, 'g');
  return [...SOURCE.matchAll(declaration)].map(match => match[1] ?? '');
}

const MEASURE = functionBody(SOURCE, 'measure');
const LOCAL_TO_SCREEN = functionBody(SOURCE, 'localToScreen');
const SNAPSHOT = functionBody(SOURCE, 'snapshot');
const PRE_DRAW = functionBody(SOURCE, 'onPreDraw');
const SIGNAL = functionBody(SOURCE, 'signalChanged');
const COMPARE = functionBody(SOURCE, 'sameAs');

describe('the surface-geometry pre-draw observer', () => {
  it('preallocates the scratch objects as observer fields', () => {
    expect(scratchFields('Matrix'), 'root inverse plus ancestor clip matrix').toHaveLength(2);
    expect(scratchFields('RectF').length, 'the RectF scratch fields').toBeGreaterThanOrEqual(4);
    expect(scratchFields('Rect').length, 'the Rect scratch fields').toBeGreaterThanOrEqual(2);
    expect(
      [...SOURCE.matchAll(/private val (\w+) = IntArray\(2\)/g)].length,
      'one window/root location array'
    ).toBe(1);
    expect(
      [...SOURCE.matchAll(/private val (\w+) = FloatArray\(2\)/g)].length,
      'one origin array'
    ).toBe(1);
  });

  it('hands localToScreen the caller matrix instead of allocating one', () => {
    expect(SOURCE).toMatch(/private fun localToScreen\(view: View, result: Matrix\)/);
    expect(LOCAL_TO_SCREEN, 'the caller matrix is the one written').toContain('result.');
    expect(LOCAL_TO_SCREEN, 'no per-call matrix').not.toMatch(/\bMatrix\(\)/);
    expect(LOCAL_TO_SCREEN, 'no per-call location array').not.toMatch(/\bIntArray\(/);
    expect(LOCAL_TO_SCREEN, 'no per-call origin array').not.toMatch(/floatArrayOf\(/);
  });

  it('runs measure with no allocating constructors', () => {
    expect(MEASURE, 'measure is declared').not.toBe('');
    for (const allocation of [
      /\bMatrix\(/,
      /\bRectF\(/,
      /\bRect\(/,
      /\bIntArray\(/,
      /\bFloatArray\(/,
      /floatArrayOf\(/,
    ]) {
      expect(MEASURE, `measure must not allocate ${allocation}`).not.toMatch(allocation);
    }
    expect(MEASURE, 'the measured values are written into the running holder').toContain('result.');
  });

  it('maps each ancestor clip through the preallocated matrix', () => {
    const walk = /localToScreen\(ancestor, (\w+)\)/.exec(MEASURE);
    expect(walk, 'the clip walk hands its matrix to localToScreen').not.toBeNull();
    expect(MEASURE, 'no per-ancestor matrix').not.toMatch(/Matrix\(\)/);
    expect(MEASURE, 'no per-ancestor clip rect').not.toMatch(/RectF\(clip\)/);
    expect(MEASURE, 'the clip is mapped through a scratch rect').toMatch(/\w+\.mapRect\(/);
    expect(scratchFields('Matrix'), 'the walk matrix is an observer field').toContain(
      walk?.[1] ?? ''
    );
  });

  it('compares the six values and builds the emit map only on a change', () => {
    for (const field of [
      'tag',
      'visibleTop',
      'visibleBottom',
      'boundsHeight',
      'safeAreaTop',
      'safeAreaBottom',
    ]) {
      expect(COMPARE, `${field} is compared`).toContain(field);
    }
    expect(SOURCE, 'one map builder').toMatch(/fun toMap\(\): Map<String, Any>/);
    expect([...SOURCE.matchAll(/\bmapOf\(/g)], 'the only map build').toHaveLength(1);
    expect(MEASURE, 'measure never builds a map').not.toContain('mapOf(');
    expect(SOURCE, 'the last built map is cached').toMatch(
      /private var previousMap: Map<String, Any> = emptyMap\(\)/
    );
    expect(SNAPSHOT, 'the cached map is what snapshot returns').toContain('previousMap');
    expect(SOURCE, 'snapshot still returns the map').toMatch(/fun snapshot\(\): Map<String, Any>/);
  });

  it('gates the pre-draw measurement on the changed signal', () => {
    expect(PRE_DRAW, 'pre-draw reads the cheap signal').toMatch(/signalChanged\(\w+\)/);
    expect(PRE_DRAW, 'the measurement is behind the gate').toMatch(/if \([^\n]*\) snapshot\(\)/);
    expect(PRE_DRAW, 'a skip is possible').toContain('return true');
    expect(SOURCE, 'the pre-draw listener stays registered').toContain(
      'addOnPreDrawListener(this)'
    );
    for (const part of [
      'root.height',
      'isAttachedToWindow',
      'isShown',
      'windowVisibility',
      'getLocationOnScreen',
      'scrollX',
      'scrollY',
    ]) {
      expect(SIGNAL, `the signal reads ${part}`).toContain(part);
    }
  });

  it('covers every ancestor input measure reads in the changed signal', () => {
    // The gate may only skip a pass when nothing measure() reads changed, so the
    // signal covers the ancestor walk too: the alpha product and the ancestors'
    // clip bounds, both read on every measure() pass.
    expect(SIGNAL, 'the ancestor alpha product is signalled').toMatch(/\balpha\b/);
    expect(SIGNAL, 'the alpha product is compared with the last pass').toContain('lastAlpha');
    expect(SIGNAL, 'the ancestors clip bounds are signalled').toMatch(/getClipBounds\(/);
    expect(SIGNAL, 'the clip walk is compared with the last pass').toContain('clipWalk');
    expect(SIGNAL, 'the walk starts at the root, as measure does').toMatch(
      /ancestor: View\? = root\b/
    );
    expect(SIGNAL, 'no matrix or rect is allocated for the walk').not.toMatch(
      /Matrix\(|RectF\(|Rect\(|IntArray\(|FloatArray\(|floatArrayOf\(/
    );
  });

  it('marks the next measurement dirty on layout, attach and detach', () => {
    expect(functionBody(SOURCE, 'onGlobalLayout')).toContain('dirty = true');
    expect(functionBody(SOURCE, 'onViewAttachedToWindow')).toContain('dirty = true');
    expect(functionBody(SOURCE, 'onViewDetachedFromWindow')).toContain('dirty = true');
  });

  it('adds no logging to the steady-state path', () => {
    expect(SOURCE).not.toContain('android.util.Log');
  });
});
