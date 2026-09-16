/* eslint-disable eslint-plugin-import/no-nodejs-modules, eslint-plugin-unicorn/prefer-module -- this test reads the layout sources from disk, which is the only place the placeholder is observable */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { ACTIVE_AGENTS_LIVE_ACTIVITY_NAME, APPROVE_TARGET } from './approve-action';
import { glanceableLayoutCopy, withGlanceableCopy } from './layout-copy';

// `approve-action` imports expo-widgets, whose native module is unreachable
// under vitest. This suite only reads the identifier it exports.
vi.mock('expo-widgets', () => ({ addUserInteractionListener: vi.fn() }));

const PLACEHOLDER = '__KILO_GLANCEABLE_COPY__';
const LAYOUT_FILES = ['active-agents-live-activity.tsx', 'active-agents-widget.tsx'];

const read = (file: string) => readFileSync(join(__dirname, file), 'utf8');

/** Stands in for an untransformed layout, which is a function, not a string. */
const untransformedLayout = () => null;

/**
 * The `'widget'` layouts are stringified by Babel and re-evaluated inside the
 * widget process, where an imported binding is an undefined global that throws
 * and blanks the whole surface. So the placeholder must appear as a literal in
 * each layout source. These assertions read the sources because no widget
 * transform runs under vitest.
 */
describe('glanceable layout copy placeholder', () => {
  it('matches the token layout-copy.ts replaces', () => {
    expect(read('layout-copy.ts')).toContain(`= '${PLACEHOLDER}'`);
  });

  for (const file of LAYOUT_FILES) {
    it(`is a literal in ${file}`, () => {
      expect(read(file)).toContain(`= '${PLACEHOLDER}'`);
    });
  }
});

describe('glanceable approve target', () => {
  const source = read('active-agents-live-activity.tsx');

  /**
   * Extract one section of the returned layout object, from its key to the next
   * key at the same indentation. The `'widget'` layout never runs under vitest,
   * so the source text is the only place its sections are observable.
   */
  const section = (key: string): string => {
    const pattern = new RegExp(`\\n {4}${key}: ([\\s\\S]*?)(?=\\n {4}[A-Za-z]+: |\\n {2}\\};\\n)`);
    const match = source.match(pattern);
    expect(match).not.toBeNull();
    return match?.[1] ?? '';
  };

  it('is a literal in the layout, equal to APPROVE_TARGET', () => {
    // The handler matches the event's `target` against APPROVE_TARGET, and the
    // widget process reads the target off the layout source. A `target` written
    // as the imported identifier would be an undefined global there, so the
    // literal is the contract: this reads the source because no widget
    // transform runs under vitest.
    const targets = [...source.matchAll(/target=(['"])([^'"]*)\1/g)].map(match => match[2]);
    expect(targets).toContain(APPROVE_TARGET);
    expect(source).not.toContain('target={APPROVE_TARGET}');
  });

  it('is gated on the card still drawing a wait, not the approvable count alone', () => {
    // `withStatus` (lib/glanceable/publisher) zeroes every count on expiry but
    // keeps `needsApproval`, so the retained expired frame carries an approvable
    // count with nothing to approve. `hasCounts` is false exactly when every
    // count is zero, and the gate must include it or the card reads Expired and
    // still offers Approve. `view-props.test.ts` pins that expired shape.
    expect(source).toMatch(/const needsApproval\s*=\s*hasCounts\s*&&/);
    expect(source).not.toMatch(/const needsApproval\s*=\s*\(props\.needsApproval/);
  });

  it('declares the bannerSmall section the Apple Watch and CarPlay draw', () => {
    // expo-widgets' banner view renders `nodes["bannerSmall"]` when the activity
    // family is `.small`, falling back to the phone `banner` when the key is
    // absent. The key itself, not a mention in a comment, is what reaches the
    // widget process.
    expect(source).toContain('bannerSmall:');
    expect(section('bannerSmall')).not.toBe('');
  });

  it('carries the control in the bannerSmall block under the wait gate', () => {
    // The watch draws one row and the Approve control after it. The press has to
    // answer on the wrist, so the block itself must hold the literal target and
    // the same wait gate the phone banner uses.
    const block = section('bannerSmall');
    expect(block).toContain('target="approve"');
    expect(block).toMatch(/needsApproval/);
  });

  it('draws the watch card count row outside the Approve gate', () => {
    // The wrist card must show a waiting agent's count even when nothing is
    // approvable: only the control is conditional. The ranked primary row draws
    // from the count payload, and the gate that hides the control must sit after
    // it, so a permission-less wait still reads on the watch.
    const block = section('bannerSmall');
    const gate = block.indexOf('{needsApproval ? (');
    expect(gate).toBeGreaterThanOrEqual(0);
    expect(block.slice(0, gate)).toContain('countRow(primary, true, false)');
    expect(block.slice(gate)).toContain('target="approve"');
  });

  it('keeps the phone banner drawing its own control', () => {
    // The Lock Screen banner and the expanded island share `markAndRows`, which
    // holds the Button; the whole-source literal-target and gate assertions
    // above pin that control. The phone `banner` block must still draw the
    // shared block, so the small section is an addition, not a move.
    expect(section('banner')).toContain('markAndRows');
  });

  it('registers under the Live Activity name, not the source the native event reports', () => {
    // The native intent reports `context.activityID` as the event's `source`
    // (`WidgetLiveActivity.swift` renders the layout with
    // `name: context.activityID`, and `DynamicView.swift` copies that name onto
    // the button's `source`), so the handler matches the unique `approve` target
    // instead of a source name. The registration name still has to be this
    // value: the activity's content state carries it, and it is what makes the
    // card mirror into the Apple Watch Smart Stack.
    expect(source).toContain(`'${ACTIVE_AGENTS_LIVE_ACTIVITY_NAME}'`);
  });
});

describe('withGlanceableCopy', () => {
  it('leaves the untransformed function alone', () => {
    expect(withGlanceableCopy(untransformedLayout)).toBe(untransformedLayout);
  });

  it('replaces the quoted token with a JSON source literal the layout can parse', () => {
    const prefix = 'const copySource = ';
    const source = withGlanceableCopy(`${prefix}'${PLACEHOLDER}';`);
    expect(source).not.toContain(PLACEHOLDER);
    // The patched text must be a valid source literal, so copy that contains an
    // apostrophe ("Can't update now") cannot break the layout the widget
    // process evaluates. A JSON string literal is also valid JSON, so parsing
    // twice reads the copy back the way the layout's `JSON.parse` does.
    const literal = source.slice(prefix.length, -1);
    expect(JSON.parse(JSON.parse(literal) as string)).toEqual(glanceableLayoutCopy());
  });

  it('bakes no digit table for a language that writes the plain ten', () => {
    // English is `latn`, so the layout's own `String` is already right and the
    // empty table tells it to skip the mapping.
    expect(glanceableLayoutCopy().digits).toBe('');
  });

  it('bakes the locale in the form the SwiftUI modifier accepts', () => {
    // `@expo/ui` applies the locale only when `Locale.availableIdentifiers`
    // contains the value, and that list writes `zh_Hans`, not `zh-Hans`. A
    // hyphen there silently left the wait in the device language.
    expect(glanceableLayoutCopy().locale).not.toContain('-');
  });

  it('covers every status the layouts render, plus the language tag and Approve', () => {
    expect(Object.keys(glanceableLayoutCopy()).toSorted()).toEqual([
      'approve',
      'digits',
      'empty',
      'expired',
      'idle',
      'locale',
      'needsInput',
      'newestResult',
      'openAgents',
      'privacy',
      'running',
      'signed_out',
      'stale',
      'waiting',
    ]);
  });
});
