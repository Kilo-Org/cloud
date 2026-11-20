// eslint-disable-next-line import/no-nodejs-modules -- vitest-only guard, runs in node, never bundled into the app
import { readFileSync } from 'node:fs';
// eslint-disable-next-line import/no-nodejs-modules -- vitest-only guard, runs in node, never bundled into the app
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * The iOS presentation read runs on the main queue against a live window, so no
 * host without a simulator can execute it. This guard reads the Swift source and
 * asserts the three facts it depends on: the read is registered as the module's
 * `presentedSurfaceOriginTop` async function, it converts the surface's zero
 * point into *window* coordinates (the conversion is what carries the
 * presentation offset — a `frame`/`bounds` read would answer the sheet's own
 * origin, which is the value every JS measurement already returns), and it
 * answers the negative sentinel instead of a guessed origin when the view or
 * its window is gone.
 *
 * The Kotlin counterpart's shape is guarded in `android-surface-geometry.test.ts`;
 * the JS contract both sides answer is `src/lib/native-surface-geometry.ts`.
 */

const SOURCE = readFileSync(
  fileURLToPath(new URL('ios/KiloSurfaceGeometryModule.swift', import.meta.url)),
  'utf8'
);

/** A Swift function body: the text between its opening and matching braces. */
function functionBody(source: string, name: string): string {
  const signature = new RegExp(String.raw`func\s+${name}\s*\(`).exec(source);
  if (signature === null) {
    return '';
  }
  const open = source.indexOf('{', signature.index);
  if (open === -1) {
    return '';
  }
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') {
      depth += 1;
    } else if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(open + 1, index);
      }
    }
  }
  return '';
}

const READ = functionBody(SOURCE, 'definition');

describe('the iOS presented-surface origin read', () => {
  it('is registered as the async function the JS bridge calls', () => {
    expect(SOURCE, 'the read is registered').toContain(
      'AsyncFunction("presentedSurfaceOriginTop")'
    );
    expect(SOURCE, 'the read resolves the node tag the bridge sent').toMatch(
      /presentedSurfaceOriginTop"\)\s*\{\s*\(tag: Int\)/
    );
  });

  it('converts the surface into window coordinates, the one read that carries the offset', () => {
    // `convert(_:to:)` walks the real view hierarchy, so the presentation
    // offset `UISheetPresentationController` applies is included. `frame`,
    // `bounds` and `safeAreaInsets` are all surface-local and would answer the
    // same value on a phone whose sheet sits 62pt lower.
    expect(SOURCE, 'the surface is converted into its window').toContain(
      'view.convert(CGPoint.zero, to: window)'
    );
    expect(SOURCE, 'the surface window is resolved before the read').toContain('view.window');
    expect(SOURCE, 'the read answers points, as the JS contract types it').toContain(
      'AsyncFunction("presentedSurfaceOriginTop") { (tag: Int) -> Double in'
    );
  });

  it('answers the negative sentinel where the surface or its window is gone', () => {
    // The bridge turns a negative answer into null, so the header keeps the
    // clearance its mode reserved instead of reserving a band from an absent
    // read.
    expect(SOURCE, 'a missing view or window answers the sentinel').toMatch(
      /guard let view = self\.appContext\?\.findView\(withTag: tag, ofType: UIView\.self\),\s*let window = view\.window else \{\s*return -1/
    );
  });

  it('runs on the main queue, where the view hierarchy may be read', () => {
    const read = SOURCE.slice(SOURCE.indexOf('presentedSurfaceOriginTop'));
    expect(read.slice(0, read.indexOf('AsyncFunction("', 10))).toContain('.runOnQueue(.main)');
  });

  it('registers the read beside the observation it complements', () => {
    // The definition body is where every async function lives; a read added
    // outside it would never be exposed.
    expect(READ).toContain('presentedSurfaceOriginTop');
    expect(READ).toContain('observeSurface');
  });
});
