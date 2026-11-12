// eslint-disable-next-line import/no-nodejs-modules -- vitest-only guard, runs in node, never bundled into the app
import { readFileSync } from 'node:fs';
// eslint-disable-next-line import/no-nodejs-modules -- vitest-only guard, runs in node, never bundled into the app
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * The observer runs on the Android UI thread, so no host without a device can
 * execute it. This guard reads the Kotlin source and asserts the shape the
 * per-frame work fix requires: the layout and pre-draw passes gate on one cheap
 * signal so a traversal measures at most once, the measurement reuses the
 * display frame the signal read, the clip walk collects the ancestor path once
 * instead of walking to the window root per ancestor, and the passes reuse
 * preallocated scratch objects and compare the six measured values through a
 * mutable holder instead of building a map. A return to per-frame allocation,
 * per-traversal measurement, a second frame query or a quadratic clip walk
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
const LAYOUT = functionBody(SOURCE, 'onGlobalLayout');
const ATTACH = functionBody(SOURCE, 'onViewAttachedToWindow');
const DETACH = functionBody(SOURCE, 'onViewDetachedFromWindow');
const REFRESH_FRAME = functionBody(SOURCE, 'refreshDisplayFrame');
const STOP = functionBody(SOURCE, 'stop');
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

  it('maps each ancestor clip through one collected path', () => {
    expect(MEASURE, 'the path is collected once').toMatch(/chain\[depth\] = ancestor\b/);
    expect(MEASURE, 'the descent starts at the collected window root').toMatch(
      /localToScreen\(chain\[depth - 1\]!!, ancestorMatrix\)/
    );
    expect(MEASURE, 'no ancestor-to-window walk per clipping ancestor').not.toMatch(
      /localToScreen\(ancestor\b/
    );
    expect(MEASURE, 'each level prepends its matrix to the parent transform').toMatch(
      /ancestorMatrix\.preConcat\(view\.matrix\)/
    );
    expect(MEASURE, 'each level prepends its parent scroll').toMatch(
      /ancestorMatrix\.preTranslate\(-parent\.scrollX\.toFloat\(\), -parent\.scrollY\.toFloat\(\)\)/
    );
    expect(MEASURE, 'no per-ancestor matrix').not.toMatch(/Matrix\(\)/);
    expect(MEASURE, 'no per-ancestor clip rect').not.toMatch(/RectF\(clip\)/);
    expect(MEASURE, 'the clip is mapped through a scratch rect').toMatch(/\w+\.mapRect\(/);
    expect(SOURCE, 'the path buffer is a reused observer field').toMatch(
      /private var chain = arrayOfNulls<View>\(0\)/
    );
    expect(MEASURE, 'the path buffer grows by doubling').toMatch(/chain = chain\.copyOf\(/);
    expect(MEASURE, 'the tail past the collected path is released').toMatch(
      /releaseChain\(depth\)/
    );
    for (const [name, body] of [
      ['detach', DETACH],
      ['stop', STOP],
    ] as const) {
      expect(body, `${name} releases the collected path`).toMatch(/releaseChain\(0\)/);
    }
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

  it('gates the layout pass on the same signal so a traversal measures once', () => {
    // The layout pass and the pre-draw pass of one traversal run in that order,
    // so the layout pass writes the baselines it measured with and the pre-draw
    // pass then finds nothing changed. A layout pass that measured
    // unconditionally measured twice per traversal.
    expect(LAYOUT, 'the layout pass reads the cheap signal').toMatch(/signalChanged\(view\)/);
    expect(LAYOUT, 'the measurement is behind the gate').toMatch(/if \([^\n]*\) snapshot\(\)/);
    expect(LAYOUT, 'the layout pass measures nothing by itself').not.toMatch(/^\s*snapshot\(\)$/m);
    expect(ATTACH, 'an attach still measures through the dirty pass').toContain('snapshot()');
    expect(DETACH, 'a detach still measures through the dirty pass').toContain('snapshot()');
  });

  it('keeps the dirty pass for the first pass, attach and detach', () => {
    expect(SOURCE, 'the first pass starts dirty').toMatch(/private var dirty = true/);
    expect(ATTACH, 'an attach marks the state dirty').toContain('dirty = true');
    expect(DETACH, 'a detach marks the state dirty').toContain('dirty = true');
  });

  it('covers every ancestor input measure reads in the changed signal', () => {
    // The gate may only skip a pass when nothing measure() reads changed, so the
    // signal covers the ancestor walk too: the alpha product, the ancestors'
    // clip bounds and their transform chain, all read on every measure() pass.
    expect(SIGNAL, 'the ancestor alpha product is signalled').toMatch(/\balpha\b/);
    expect(SIGNAL, 'the alpha product is compared with the last pass').toContain('lastAlpha');
    expect(SIGNAL, 'the ancestors clip bounds are signalled').toMatch(/getClipBounds\(/);
    expect(SIGNAL, 'the clip walk is compared with the last pass').toContain('clipWalk');
    expect(SIGNAL, 'the walk starts at the root, as measure does').toMatch(
      /ancestor: View\? = root\b/
    );
    expect(SIGNAL, 'the ancestor transform chain is signalled').toMatch(
      /ancestorMatrix\.postConcat\(ancestor\.matrix\)/
    );
    expect(SIGNAL, 'the transform chain is compared with the last pass').toContain(
      'lastMatrixValues'
    );
    expect(SIGNAL, 'no matrix or rect is allocated for the walk').not.toMatch(
      /Matrix\(|RectF\(|Rect\(|IntArray\(|FloatArray\(|floatArrayOf\(/
    );
  });

  it('covers the insets, display frame and soft-input mode measure reads', () => {
    // measure() reads the window insets, the visible display frame and the
    // window's soft-input mode for its safe-area and keyboard branches, and
    // insets can change without a layout pass: the gate must observe all three.
    expect(SIGNAL, 'the window insets are signalled').toContain('rootWindowInsets');
    expect(SIGNAL, 'the insets are compared with the last pass').toContain('lastWindowInsets');
    expect(SIGNAL, 'the display frame is compared with the last pass').toContain(
      'lastDisplayFrame'
    );
    expect(SIGNAL, 'the soft-input mode is signalled').toContain('softInputMode');
    expect(SIGNAL, 'the soft-input mode is compared with the last pass').toContain(
      'lastSoftInputMode'
    );
  });

  it('reads the window display frame only on a pass that can move it', () => {
    // The frame is a window-session query, so the pass reads it once and the
    // measurement reads the cached rect: a per-draw query plus a second query
    // per measurement was the alternative.
    expect(REFRESH_FRAME, 'the cached rect is the one the window session fills').toContain(
      'getWindowVisibleDisplayFrame'
    );
    expect(MEASURE, 'the measurement reuses the cached frame').not.toContain(
      'getWindowVisibleDisplayFrame'
    );
    expect(SIGNAL, 'the signal refreshes the first pass and an insets change').toMatch(
      /if \(!frameFresh \|\| insetsChanged\) refreshDisplayFrame\(root\)/
    );
    expect(SNAPSHOT, 'a measurement never runs on a stale frame').toMatch(
      /if \(!frameFresh\) refreshDisplayFrame\(root\)/
    );
    expect(LAYOUT, 'a layout pass can move the frame').toContain('frameFresh = false');
    expect(ATTACH, 'a new window carries a new frame').toContain('frameFresh = false');
  });

  it('adds no logging to the steady-state path', () => {
    expect(SOURCE).not.toContain('android.util.Log');
  });
});
