/* eslint-disable eslint-plugin-import/no-nodejs-modules, eslint-plugin-unicorn/prefer-module -- the buttons' targets and copy are stringified into the widget process, so their literals are observable only in the layout source, which this suite reads from disk */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const LAYOUT_FILE = 'active-agents-live-activity.tsx';
const INTERACTION_FILE = 'interaction.ts';

const read = (file: string) => readFileSync(join(__dirname, file), 'utf8');

/** The source between two markers, so a region can be asserted on its own. */
function region(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  expect(from).toBeGreaterThan(-1);
  expect(to).toBeGreaterThan(from);
  return source.slice(from, to);
}

const targetsIn = (source: string): string[] =>
  [...source.matchAll(/target="([^"]+)"/g)].map(match => match[1] ?? '').toSorted();

/**
 * The `'widget'` layout is stringified by Babel and re-evaluated inside the
 * widget extension, where an imported binding is an undefined global and a
 * non-literal target could not be sent back by the native intent. Nothing here
 * runs the widget transform, so the source on disk is the only place these
 * literals can be checked.
 */
describe('Active Agents Live Activity actions', () => {
  const source = read(LAYOUT_FILE);

  it('declares the two stable targets', () => {
    expect(targetsIn(source)).toEqual(['approve', 'open']);
  });

  it('reads both labels from the baked copy, never through an import', () => {
    expect(source).toContain('COPY.approve');
    expect(source).toContain('COPY.open');
    // The layout cannot call i18n: the widget process would throw on the
    // undefined global and blank the whole surface.
    expect(source).not.toMatch(/\bi18n\./);
  });

  it('offers Approve only while something waits', () => {
    expect(source).toContain('const canApprove = (props.needsInput ?? 0) > 0;');
    expect(source).toMatch(/canApprove \? \([\s\S]*?target="approve"[\s\S]*?\) : null/);
  });

  it('always offers Open', () => {
    const guardEnd = source.indexOf(') : null', source.indexOf('canApprove ? ('));
    expect(guardEnd).toBeGreaterThan(-1);
    // The Open button is outside the needs-input guard: it is the only way to
    // the session the card names.
    expect(source.indexOf('target="open"')).toBeGreaterThan(guardEnd);
  });

  it('draws the actions on the banner and in the expanded island', () => {
    expect(region(source, 'banner: (', 'compactLeading:')).toContain('{actions}');
    expect(region(source, 'expandedBottom: (', '\n  };\n};')).toContain('{actions}');
  });

  it('keeps every compact presentation free of buttons', () => {
    const compact = region(source, 'compactLeading:', 'expandedBottom:');
    expect(compact).not.toContain('<Button');
    expect(compact).not.toContain('{actions}');
  });

  it('bakes both action slots from the reviewed keys', () => {
    const copy = read('layout-copy.ts');
    expect(copy).toContain("approve: i18n.t('common.approve')");
    expect(copy).toContain("open: i18n.t('glanceable.openSession')");
  });

  it('routes exactly the targets the layout declares', () => {
    // The layout cannot import the target constants — they would be undefined
    // globals in the widget process — so the two files are compared instead.
    const interactionTargets = [
      ...read(INTERACTION_FILE).matchAll(/GLANCEABLE(?:_APPROVE|_OPEN)_TARGET = '([^']+)'/g),
    ]
      .map(match => match[1] ?? '')
      .toSorted();
    expect(interactionTargets).toEqual(['approve', 'open']);
    expect(targetsIn(source)).toEqual(interactionTargets);
  });
});
