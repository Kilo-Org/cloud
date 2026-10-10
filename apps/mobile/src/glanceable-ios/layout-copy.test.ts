/* eslint-disable eslint-plugin-import/no-nodejs-modules, eslint-plugin-unicorn/prefer-module -- this test reads the layout sources from disk, which is the only place the placeholder is observable */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { i18n } from '@/i18n';

import { glanceableLayoutCopy, withGlanceableCopy } from './layout-copy';

const PLACEHOLDER = '__KILO_GLANCEABLE_COPY__';
const LAYOUT_FILE = 'active-agents-live-activity.tsx';
const LAYOUT_FILES = [LAYOUT_FILE, 'active-agents-widget.tsx'];

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

  it('bakes Home freshness and fallback copy alongside privacy-minimal accessory copy', () => {
    const copy = glanceableLayoutCopy();
    expect(copy).toMatchObject({
      checked: i18n.t('glanceable.checked'),
      lastKnown: i18n.t('glanceable.lastKnown'),
      awaitingUpdate: i18n.t('glanceable.awaitingUpdate'),
      agent: i18n.t('common.agent'),
      homeEmpty: i18n.t('home.noLiveSessions'),
    });
    expect(copy.checked).not.toBe('glanceable.checked');
    expect(copy.awaitingUpdate).not.toBe('glanceable.awaitingUpdate');
  });

  it('bakes the Home redesign slots from reviewed keys and a one-character group separator', () => {
    const copy = glanceableLayoutCopy();
    expect(copy).toMatchObject({
      approving: i18n.t('glanceable.approving'),
      couldNotApprove: i18n.t('glanceable.couldNotApprove'),
      approveFailed: i18n.t('glanceable.approveFailed'),
      recent: i18n.t('common.recent'),
      nextScheduled: i18n.t('glanceable.nextScheduled'),
      group: ',',
    });
    // The failure footer nests the Approve label; an unresolved nesting would leak `$t(`.
    expect(copy.approveFailed).not.toContain('$t(');
    expect(copy.recent).not.toBe('common.recent');
  });

  it('bakes the Live Activity Approve label from the reviewed key', () => {
    // A missing key would come back as the key itself, so the copy is asserted
    // against the catalog and not only against the slot.
    const copy = glanceableLayoutCopy();
    expect(copy.approve).toBe(i18n.t('common.approve'));
    expect(copy.approve).not.toBe('common.approve');
  });

  it('bakes the scheduled row label from the reviewed key', () => {
    // The Live Activity cannot translate: the notifications Worker pushes the
    // raw content state, so the scheduled row's label has to arrive in the
    // baked copy. The key is the one the session list already reads, so a
    // scheduled session is worded the same on every surface. The widget needs
    // no baked row label — its rows arrive translated through the timeline
    // props, and only its prop-less gallery placeholder draws the baked copy.
    const copy = glanceableLayoutCopy();
    expect(copy.scheduled).toBe(i18n.t('common.scheduled'));
    expect(copy.scheduled).not.toBe('common.scheduled');
    expect(copy.scheduled).not.toBe('');
  });
});
