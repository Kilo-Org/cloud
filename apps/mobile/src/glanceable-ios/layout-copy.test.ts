/* eslint-disable eslint-plugin-import/no-nodejs-modules, eslint-plugin-unicorn/prefer-module -- this test reads the layout sources from disk, which is the only place the placeholder is observable */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { i18n } from '@/i18n';

import { glanceableLayoutCopy, withGlanceableCopy } from './layout-copy';

const PLACEHOLDER = '__KILO_GLANCEABLE_COPY__';
const LAYOUT_FILE = 'active-agents-live-activity.tsx';
const LAYOUT_FILES = [LAYOUT_FILE, 'active-agents-widget.tsx'];
/**
 * The module that routes a Live Activity press. Read, never imported: it loads
 * the native widget modules a node test cannot.
 */
const INTERACTION_FILE = 'interaction.ts';

const read = (file: string) => readFileSync(join(__dirname, file), 'utf8');

/** The literal a source file declares for its exported `name`. */
function declaredLiteral(file: string, name: string): string {
  const match = new RegExp(`export const ${name} = '([^']+)'`).exec(read(file));
  if (match === null) {
    throw new Error(`${file} declares no ${name}`);
  }
  return match[1] ?? '';
}

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
  const source = read(LAYOUT_FILE);

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

  it('is a literal in the layout, equal to the target interaction.ts routes', () => {
    // The handler matches the event's `target` against
    // `GLANCEABLE_APPROVE_TARGET` (interaction.ts), and the widget process reads
    // the target off the layout source. A `target` written as the imported
    // identifier would be an undefined global there, so the literal is the
    // contract: this reads the sources because no widget transform runs under
    // vitest.
    const targets = [...source.matchAll(/target=(['"])([^'"]*)\1/g)].map(match => match[2]);
    expect(targets).toContain(declaredLiteral(INTERACTION_FILE, 'GLANCEABLE_APPROVE_TARGET'));
    expect(source).not.toMatch(/target=\{/);
  });

  it('is gated on the recorded ask and the approvable count, never the count alone', () => {
    // The control has to be one its own press can answer: the press resolves
    // the ask the app recorded, so the app's `canApprove` flag withholds it,
    // and the approvable count alone cannot gate it because a permission row
    // the control plane does not own is `needsApproval` but not approvable.
    // Both count terms are still required: `needsInput` withholds the control
    // from the expired frame `withStatus` (lib/glanceable/publisher) leaves
    // `needsApproval` on, and `needsApproval` withholds it from a server-written
    // question-only state, where `runGlanceableApprove` answers `none`.
    // `view-props.test.ts` pins that expired shape.
    expect(source).toContain('props.canApprove !== false');
    expect(source).toMatch(/\(props\.needsInput \?\? 0\) > 0/);
    expect(source).toMatch(/\(props\.needsApproval \?\? 0\) > 0/);
    expect(source).not.toMatch(/const needsApproval/);
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
    // the same gate the phone banner uses: `canApprove`, the flag that says the
    // recorded ask is one the press can answer.
    const block = section('bannerSmall');
    expect(block).toContain('target="approve"');
    expect(block).toMatch(/\{canApprove \? \(/);
    expect(block).not.toMatch(/needsApproval/);
  });

  it('draws the watch card count row outside the Approve gate', () => {
    // The wrist card must show a waiting agent's count even when nothing is
    // approvable: only the control is conditional. The ranked primary row draws
    // from the count payload, and the gate that hides the control must sit after
    // it, so a permission-less wait still reads on the watch.
    const block = section('bannerSmall');
    const gate = block.indexOf('{canApprove ? (');
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
    expect(declaredLiteral(LAYOUT_FILE, 'LIVE_ACTIVITY_NAME')).toBe('ActiveAgentsLiveActivity');
    expect(source).toMatch(/createLiveActivity<ContentState>\(\s*LIVE_ACTIVITY_NAME,/);
    // The handler recognises a press from this surface by that same constant.
    expect(read(INTERACTION_FILE)).toContain('source === LIVE_ACTIVITY_NAME');
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

  it('covers every status the layouts render, the in-place actions, and the language tag', () => {
    expect(Object.keys(glanceableLayoutCopy()).toSorted()).toEqual([
      'approve',
      'approving',
      'digits',
      'empty',
      'expired',
      'idle',
      'locale',
      'needsInput',
      'newAgent',
      'open',
      'openAgents',
      'privacy',
      'running',
      'signed_out',
      'stale',
      'starting',
      'waiting',
    ]);
  });

  it('bakes both Live Activity action labels from the reviewed keys', () => {
    // A missing key would come back as the key itself, so the copy is asserted
    // against the catalog and not only against the slot.
    const copy = glanceableLayoutCopy();
    expect(copy.approve).toBe(i18n.t('common.approve'));
    expect(copy.approve).not.toBe('common.approve');
    expect(copy.open).toBe(i18n.t('glanceable.openSession'));
    expect(copy.open).not.toBe('glanceable.openSession');
  });
});
