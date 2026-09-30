/* eslint-disable eslint-plugin-import/no-nodejs-modules, eslint-plugin-unicorn/prefer-module -- the buttons' targets and copy are stringified into the widget process, so their literals are observable only in the layout source, which this suite reads from disk */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildGlanceableSnapshot } from '@kilocode/app-shared/glanceable-agents-snapshot';
import { describe, expect, it } from 'vitest';

import { buildGlanceableLiveActivityContentState } from './view-props';

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
    // Two surfaces draw Approve — the phone block's `actions` and the
    // watch/CarPlay `bannerSmall` control beside it — so the literal repeats.
    // The contract is the set of targets the handler routes, and no surface
    // declares one outside it.
    expect([...new Set(targetsIn(source))]).toEqual(['approve', 'open']);
  });

  it('reads both labels from the baked copy, never through an import', () => {
    expect(source).toContain('COPY.approve');
    expect(source).toContain('COPY.open');
    // The layout cannot call i18n: the widget process would throw on the
    // undefined global and blank the whole surface.
    expect(source).not.toMatch(/\bi18n\./);
  });

  /**
   * The gate expression as the widget process evaluates it. The layout is
   * stringified, so no import runs it under vitest; the literal in the source is
   * the shipped gate, and evaluating it here is the only way to run that gate
   * against a content state.
   */
  const gate = (): ((props: Record<string, number | boolean | undefined>) => boolean) => {
    const match = /const canApprove =([\s\S]*?);\n/.exec(source);
    if (match === null) {
      throw new Error('the layout declares no canApprove gate');
    }
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func -- the shipped gate is a source literal, so it cannot be imported and called
    return new Function('props', `return (${match[1] ?? ''});`) as (
      props: Record<string, number | boolean | undefined>
    ) => boolean;
  };

  it('offers Approve only while an approvable ask waits', () => {
    const canApprove = gate();
    // The app's own state: the recorded-ask flag decides, and the wait count
    // withholds the control from the expired frame `withStatus` leaves the
    // approvable count on.
    expect(canApprove({ needsInput: 1, needsApproval: 1, canApprove: true })).toBe(true);
    expect(canApprove({ needsInput: 1, needsApproval: 1, canApprove: false })).toBe(false);
    expect(canApprove({ needsInput: 0, needsApproval: 1, canApprove: true })).toBe(false);
    expect(source).toMatch(/canApprove \? \([\s\S]*?target="approve"[\s\S]*?\) : null/);
  });

  it('withholds Approve from a server-written question-only state', () => {
    // A state that arrived over APNs carries no `canApprove`, and its
    // `needsApproval` counts the `permission` rows alone. A question-only wait
    // must not draw the control `runGlanceableApprove` answers with `none`,
    // while a permission wait keeps the tap the app-closed press answers.
    const canApprove = gate();
    expect(canApprove({ needsInput: 1, needsApproval: 0 })).toBe(false);
    expect(canApprove({ needsInput: 1, needsApproval: 0, canApprove: true })).toBe(false);
    expect(canApprove({ needsInput: 1, needsApproval: 1 })).toBe(true);
    expect(source).toContain('props.canApprove !== false');
    expect(source).not.toMatch(/props\.canApprove === true/);
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

  it('draws a failed Approve on the surfaces the button lives on', () => {
    // The press can arrive with the app closed, so the failure line the app
    // puts in the content state has to be drawn on the card itself.
    expect(source).toContain('const notice = props.notice ?? null;');
    expect(region(source, 'banner: (', 'bannerSmall:')).toContain('{noticeLine}');
    expect(region(source, 'bannerSmall: (', 'compactLeading:')).toContain('{noticeLine}');
    expect(region(source, 'expandedBottom: (', '\n  };\n};')).toContain('{noticeLine}');
    // The compact presentations carry the count alone: the notice goes where
    // the buttons and the labelled counts are.
    expect(region(source, 'compactLeading:', 'expandedBottom:')).not.toContain('{noticeLine}');
  });

  it('reserves the small banner notice row even before an Approve failure', () => {
    const small = region(source, 'bannerSmall: (', 'compactLeading:');
    expect(small).toMatch(
      /<VStack modifiers=\{\[frame\(\{ height: 18 \}\)\]\}>\s*\{noticeLine\}\s*<\/VStack>/
    );
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
    expect([...new Set(targetsIn(source))]).toEqual(interactionTargets);
  });

  it('foregrounds the app for Open, and only for Open', () => {
    // A Live Activity button performs in the app's process without bringing it
    // forward, so Open asks for the foreground: the destination the press
    // records is consumed by the app's own listener, which the user has to be
    // looking at. Approve must not ask for it — an Approve that needed the app
    // up would not answer the Lock Screen with the app closed.
    expect(source).toContain('const openButtonProps = { openAppWhenRun: true };');
    expect(source.match(/\.\.\.openButtonProps/g)).toHaveLength(1);
    // The one spread is the Open button's: the prop travels beside its target.
    expect(region(source, '{...openButtonProps}', 'modifiers=')).toContain('target="open"');
  });

  it('names the foregrounding prop the patched expo-widgets button view reads', () => {
    // The prop name is the JS-to-native contract: the layout writes
    // `openAppWhenRun` on the Open button, and expo-widgets' patched ButtonProps
    // reads that name and presses through the intent that asks the system for
    // the foreground. The two sides are literals in different languages, so the
    // patch is read here to hold them equal — a rename on one side alone would
    // put Open back in the background with no other test to catch it.
    const patch = read('../../../../patches/expo-widgets@57.0.18.patch');
    expect(patch).toContain('@Field var openAppWhenRun: Bool?');
    expect(patch).toContain('static var openAppWhenRun: Bool = true');
    expect(patch).toContain('intent: LiveActivityOpenInteraction(');
  });
});

/**
 * The scheduled row reaches the card over two paths: the app builds the content
 * state from a snapshot, and the notifications Worker pushes the same raw shape
 * for a card that was never woken by the app. Both carry the count and the ISO
 * wake, and the layout draws the wake as a clock time beside the row — never
 * when a scheduled row had no wake to report.
 */
describe('Active Agents Live Activity scheduled row', () => {
  const source = read(LAYOUT_FILE);

  it('carries the scheduled count and its ISO wake in the built content state', () => {
    const snapshot = buildGlanceableSnapshot({
      sessions: [{ status: 'scheduled', scheduledAt: '2026-09-24T09:00:00.000Z' }],
      userId: 'u1',
      organizationId: null,
      now: Date.parse('2026-01-02T00:00:00.000Z'),
    });
    const contentState = buildGlanceableLiveActivityContentState(snapshot);
    expect(contentState.scheduled).toBe(1);
    expect(contentState.scheduledAt).toBe('2026-09-24T09:00:00.000Z');
  });

  it('draws the wake as a clock time beside the scheduled row', () => {
    // The row itself draws from the pushed count, and the wake is gated on that
    // count being non-zero: a scheduled state without a wake renders the row
    // with no time rather than a stale or invented one.
    expect(source).toContain("kind: 'scheduled'");
    expect(source).toContain('count: props.scheduled ?? 0');
    expect(source).toContain(
      'const scheduledAt = (props.scheduled ?? 0) > 0 ? (props.scheduledAt ?? null) : null;'
    );
    expect(source).toMatch(
      /showWait && line\.kind === 'scheduled' && scheduledAt !== null[\s\S]*?date=\{new Date\(scheduledAt\)\}[\s\S]*?dateStyle="time"/
    );
    // The wait row above it stays a relative duration, and the small watch row
    // takes no time at all.
    expect(source).toMatch(
      /line\.kind === 'needsInput' && needsInputSince !== null[\s\S]*?dateStyle="relative"/
    );
    expect(source).toContain('countRow(primary, true, false)');
  });
});
