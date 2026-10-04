/* eslint-disable eslint-plugin-import/no-nodejs-modules, eslint-plugin-unicorn/prefer-module -- this test reads the widget sources from disk, which is the only place the family contract is observable under vitest */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { glanceableLayoutCopy } from './layout-copy';

const MOBILE_DIR = join(__dirname, '..', '..');

const read = (...segments: string[]) => readFileSync(join(...segments), 'utf8');

/**
 * The widget transform stringifies the layout, so nothing here can execute it:
 * the declared families and the large-card branch are only observable in the
 * sources. This is the same boundary `layout-copy.test.ts` reads.
 */
describe('ActiveAgentsWidget families', () => {
  it('declares systemLarge on the ActiveAgentsWidget entry', () => {
    const entry = /name: 'ActiveAgentsWidget'[\s\S]*?supportedFamilies: \[([\s\S]*?)\]/.exec(
      read(MOBILE_DIR, 'app.config.ts')
    );

    expect(entry?.[1]).toContain("'systemLarge'");
  });

  it('draws the newest result on the large card and keeps the smaller families', () => {
    const layout = read(__dirname, 'active-agents-widget.tsx');
    // From the footer's derivation through the large branch, up to the medium
    // branch that follows it.
    const large = layout.slice(
      layout.indexOf('const newestResultKind'),
      layout.indexOf('if (wide)')
    );

    expect(large).toContain("family === 'systemLarge'");
    expect(large).toContain('props.newestResultKind');
    expect(large).toContain('props.newestResultLabel');
    expect(large).toContain('props.newestResultAt');
    expect(large).toContain('dateStyle="relative"');
    // The mark at the top, the rows centred, the footer at the bottom. A
    // spacer between the rows and the footer reserves the lower third up
    // front, so a stale→happy swap cannot move the counts.
    expect(large).toContain('{systemRows}');
    expect(large).toContain('{newestResultFooter}');
    // The spacer the comment names sits between the two markers: asserting the
    // last spacer in the whole slice would also accept one from the footer body
    // or the mark row, so a deleted spacer here would still pass.
    expect(
      large.slice(large.indexOf('{systemRows}'), large.indexOf('{newestResultFooter}'))
    ).toContain('<Spacer />');
  });

  it('prefers the delayed copy over the newest result while the counts are stale', () => {
    const layout = read(__dirname, 'active-agents-widget.tsx');
    const footer = layout.slice(
      layout.indexOf('const newestResultBody'),
      layout.indexOf('const footerBody')
    );

    // `statusLine` is tested first, so a stale frame draws "Can't update now"
    // and never a relative time claiming freshness the snapshot has lost.
    expect(footer).toContain('if (statusLine !== null)');
    expect(footer.indexOf('statusLine')).toBeLessThan(footer.indexOf('newestResultKind'));
  });

  it('draws the scheduled row and its wake in every family that draws counts', () => {
    const layout = read(__dirname, 'active-agents-widget.tsx');
    // One row builder draws every count line, and both families that draw the
    // rows map their counts through it: the Lock Screen rectangle with the
    // compact flag, the Home Screen families through `systemRows`. So the
    // scheduled row appears wherever needs-input, running and idle do.
    expect(layout).toContain("scheduled: { icon: 'clock'");
    expect(layout).toMatch(/line\.kind === 'scheduled'[\s\S]*?date=\{new Date\(timeAt\)\}/);
    // The wake is an absolute clock time; the wait above it stays the relative
    // duration. The medium card draws the wait and the wake, and the large card
    // draws the wake beside its scheduled row too; the small square has room
    // for neither. `wakeRow` is what both Home Screen cards that draw a wake
    // share, and the `Spacer` reserves the trailing slot in every state.
    expect(layout).toContain("let timeStyle: 'relative' | 'time' = 'relative';");
    expect(layout).toContain("timeStyle = 'time';");
    expect(layout).toContain("const wakeRow = wide || family === 'systemLarge';");
    expect(layout).toMatch(/else if \(wakeRow && line\.kind === 'scheduled'\)/);
    expect(layout).toContain('{wakeRow ? <Spacer /> : null}');
    expect(layout).toContain('dateStyle={timeStyle}');
    expect(layout).toContain('const scheduledAt = props.scheduledAt ?? null;');
    expect(layout).toContain(
      '{counts.map(line => countRow(line, line.kind === primaryKind, true))}'
    );
    expect(layout).toContain(
      '{counts.map(line => countRow(line, line.kind === primaryKind, false))}'
    );
  });

  it('bakes the newestResult copy slot into the layout map', () => {
    expect(read(__dirname, 'layout-copy.ts')).toContain("i18n.t('glanceable.newestResult')");
    expect(glanceableLayoutCopy()).toHaveProperty('newestResult');
  });

  it('caps Dynamic Type growth in the Home Screen families', () => {
    const layout = read(__dirname, 'active-agents-widget.tsx');

    // The factory is read off the widget global, not the imported binding: the
    // stringified layout is evaluated against widget globals, and the vitest
    // swift-ui mock does not bind `dynamicTypeSize`.
    expect(layout).toContain('dynamicTypeSize?: typeof dynamicTypeSize;');
    // The small square and the medium row cap at the default body size, because
    // four rows, the reserved slot and the action row share one fixed card
    // height; the tall large card may reach an accessibility size.
    expect(layout).toContain("family === 'systemLarge' ? 'accessibility2' : 'large'");
    // The cap reaches every Home Screen family through one modifier list.
    expect(layout).toContain('...typeModifiers,');
    // The two height-constrained families draw the rows small enough to fit.
    expect(layout).toContain("const denseRows = family !== 'systemLarge';");
  });

  it('draws the press line only while the marker names a known action on a count-less surface', () => {
    const layout = read(__dirname, 'active-agents-widget.tsx');

    // A partial write (or a marker from a later app version) can leave only the
    // visible flag: it must not hold "Starting…" on a settled widget.
    expect(layout).toContain(
      "props.pendingAction === 'approve' || props.pendingAction === 'new-agent'"
    );
    // A recognized action is not enough: the owner's stored marker names
    // `new-agent` and still lingered on a settled idle-only tray, so the guard
    // also requires a count-less surface. Only the empty surface draws it.
    expect(layout).toContain(
      'props.pendingActionVisible === true && pendingActionKind !== null && counts.length === 0'
    );
  });

  it('decodes raw app-group count rows instead of mapping them blindly', () => {
    const layout = read(__dirname, 'active-agents-widget.tsx');

    // A stale timeline written by another app version can carry a non-array or
    // a null row; mapping it threw and expo-widgets drew the red error box in
    // every family. The rows are decoded, and an unknown kind falls back to the
    // neutral idle mark instead of reading `.icon` off `undefined`.
    expect(layout).toContain('Array.isArray(props.countLines) ? props.countLines : []');
    expect(layout).toContain('const glyphFor = (kind: string | null | undefined)');
    expect(layout).toContain('Object.hasOwn(GLYPH, kind)');
    expect(layout).toContain('return GLYPH.idle;');
    // No raw lookup may reach `.icon`/`.color`: an unknown kind there is a
    // runtime `undefined` and the whole widget view falls into its red box.
    expect(layout).not.toContain('GLYPH[primaryKind');
    expect(layout).not.toContain('GLYPH[newestResultKind');
    expect(layout).not.toContain('GLYPH[line.kind');
  });

  it('strips an orphaned press flag from the stored timeline', () => {
    const actions = read(__dirname, 'widget-actions.ts');

    // The layout guard only hides the orphan; the sweep must also clear it, or
    // it would outlive its press in the app group.
    expect(actions).toContain('function hasPressMarker(');
    expect(actions).toContain(
      'props?.pendingActionVisible === true || pendingActionOf(props) !== null'
    );
    expect(actions).toContain('hasPressMarker(entry.props)');
    expect(actions).toContain('if (marked.size > 0)');
  });
});
