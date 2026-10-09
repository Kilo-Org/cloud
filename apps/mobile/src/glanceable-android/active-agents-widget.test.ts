import { buildHomeWidgetData, type HomeWidgetSessionRow } from '@kilocode/app-shared/home-widget';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { _resetHomeWidgetDataForTests } from '@/lib/glanceable/home-widget-data';

import { setSurfaceExtras } from '@/lib/glanceable/surface-extras';
import { darkColors, lightColors } from '@/lib/hooks/theme-colors.generated';

import {
  CELLS,
  minimumHeight,
  nodes,
  NOW,
  propsFor,
  render,
  texts,
  translate,
  WAKE,
} from './active-agents-widget.test-helpers';
import { buildCurrentWidgetProps } from './widget-props';

vi.mock('react-native-android-widget', () => ({
  FlexWidget: () => null,
  TextWidget: () => null,
}));

beforeEach(() => {
  _resetHomeWidgetDataForTests();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  setSurfaceExtras({ newestSessionTitle: null, actionFeedback: null });
});

const MIXED: HomeWidgetSessionRow[] = [
  { status: 'permission', title: 'Review the release', approvalKey: 'a'.repeat(64) },
  { status: 'busy', title: 'Build the app' },
  { status: 'scheduled', title: 'Morning checks', scheduledAt: WAKE },
  { status: 'idle', title: 'Connected agent' },
];
const STATES = [
  ['waiting', [], 'waiting'],
  ['empty', [], 'empty'],
  ['signed out', MIXED, 'signed_out'],
  ['privacy', MIXED, 'privacy'],
  ['mixed', MIXED, undefined],
  ['running', [{ status: 'busy' }], undefined],
  ['idle', [{ status: 'idle' }], undefined],
  ['scheduled', [{ status: 'scheduled', scheduledAt: WAKE }], undefined],
  ['missing wake', [{ status: 'scheduled' }], undefined],
  [
    'overdue wake',
    [{ status: 'scheduled', scheduledAt: new Date(NOW - 60_000).toISOString() }],
    undefined,
  ],
] as const;

describe('Home widget native compositions', () => {
  it.each(CELLS)('preserves the state, navigation and action at %dx%d', (width, height) => {
    for (const [name, sessions, status] of STATES) {
      const props = propsFor([...sessions], status);
      const representation = render(props, [width, height]);
      for (const theme of [representation.light, representation.dark]) {
        const visible = texts(theme);
        expect(visible, name).toContain('Kilo');
        expect(theme.props.clickActionData, name).toEqual({ uri: 'kiloapp:///cloud/sessions' });
        expect(theme.props.accessibilityLabel, name).toBe(props.homeCopy?.accessibilityLabel);
        if (props.home?.status === 'content') {
          expect(visible, name).toContain(props.homeCopy?.primaryCount);
          expect(visible, name).toContain(props.homeCopy?.primaryLabel);
          expect(visible, name).not.toContain('0');
          expect(visible, name).toContain('Checked 8:00 PM');
        } else {
          expect(visible, name).toContain(props.homeCopy?.status);
        }
        const controls = nodes(theme).filter(
          node =>
            node.props.clickAction === 'approve' ||
            node.props.clickActionData?.uri === 'kiloapp:///cloud/sessions/new'
        );
        expect(controls.length, name).toBe(
          Number(props.home?.canCreate) + Number(props.home?.canApprove)
        );
        for (const control of controls) {
          expect(control.props.style?.width).toBeGreaterThanOrEqual(48);
          expect(control.props.style?.height).toBeGreaterThanOrEqual(48);
          expect(control.props.accessibilityLabel).toBeTruthy();
        }
        expect(minimumHeight(theme), name).toBeLessThanOrEqual(height);
      }
      expect(texts(representation.light)).toEqual(texts(representation.dark));
      expect(representation.light.props.style?.backgroundColor).toBe(lightColors.background);
      expect(representation.dark.props.style?.backgroundColor).toBe(darkColors.background);
    }
  });

  it.each(CELLS)(
    'budgets German and Arabic/RTL without shrinking the count at %dx%d',
    (width, height) => {
      for (const language of ['de', 'ar']) {
        const translated = (key: string) =>
          language === 'ar' ? `العربية ${translate(key)}` : `Deutsch ${translate(key)}`;
        const props = propsFor(MIXED, undefined, translated);
        const tree = render(props, [width, height], language === 'ar').light;
        expect(minimumHeight(tree)).toBeLessThanOrEqual(height);
        const primary = nodes(tree).find(
          node =>
            node.props.text === props.homeCopy?.primaryCount &&
            (node.props.style?.fontSize ?? 0) >= 22
        );
        expect(primary?.props.style?.fontSize).toBeGreaterThanOrEqual(22);
        const label = nodes(tree).find(node => node.props.text === props.homeCopy?.primaryLabel);
        expect(label?.props.style?.textAlign).toBe(language === 'ar' ? 'right' : 'left');
      }
    }
  );

  it('uses compact, wide and tall space for hierarchy rather than a four-zero ledger', () => {
    const props = propsFor(MIXED);
    const small = texts(render(props, [172, 104]).light);
    const wide = texts(render(props, [360, 224]).light);
    const tall = texts(render(props, [360, 464]).light);
    expect(small).toContain('Review the release');
    expect(wide).toEqual(expect.arrayContaining(['Working', 'Scheduled', 'Idle']));
    expect(tall).toEqual(expect.arrayContaining(['Review the release', 'Permission required']));
    expect(
      nodes(render(props, [360, 464]).light).find(node => node.props.text === '1')?.props.style
        ?.fontSize
    ).toBeGreaterThan(30);
  });

  it.each(CELLS)('keeps a scheduled wake ahead of idle details at %dx%d', (width, height) => {
    const props = propsFor([
      { status: 'scheduled', title: 'Morning checks', scheduledAt: WAKE },
      { status: 'idle' },
    ]);
    expect(texts(render(props, [width, height]).light)).toContain('Next run 8:00 PM');
    const overdue = propsFor([
      { status: 'scheduled', scheduledAt: new Date(NOW - 1).toISOString() },
    ]);
    expect(texts(render(overdue, [width, height]).light)).toContain('Awaiting update');
    expect(texts(render(overdue, [width, height]).light)).not.toContain('Working');
  });

  it('uses the large list for earliest waits or wakes, with honest generic missing titles', () => {
    const waiting = propsFor([
      { status: 'permission', title: 'First' },
      { status: 'question', title: 'Second' },
      { status: 'retry' },
    ]);
    expect(texts(render(waiting, [360, 464]).light)).toEqual(
      expect.arrayContaining([
        'First',
        'Second',
        'Agent',
        'Permission required',
        'Answer needed',
        'Waiting to retry',
      ])
    );
    const scheduled = propsFor([
      { status: 'scheduled', title: 'Later', scheduledAt: new Date(NOW + 20_000).toISOString() },
      { status: 'scheduled', title: 'Sooner', scheduledAt: new Date(NOW + 10_000).toISOString() },
    ]);
    const shown = texts(render(scheduled, [360, 464]).light);
    expect(shown.indexOf('Sooner')).toBeLessThan(shown.indexOf('Later'));
  });

  it('retains last-known data after activity expiry without renewing the checked timestamp', () => {
    const data = buildHomeWidgetData({
      sessions: MIXED,
      userId: 'u1',
      organizationId: null,
      now: NOW,
    });
    vi.setSystemTime(Date.parse(data.snapshot.expiresAt) + 1);
    const props = buildCurrentWidgetProps(
      data.snapshot,
      translate,
      String,
      String,
      () => '8:00 PM',
      data
    );
    expect(props.home?.checkedAt).toBe(data.snapshot.updatedAt);
    expect(props.home?.stale).toBe(true);
    expect(texts(render(props, [172, 104]).light)).toEqual(
      expect.arrayContaining(['1', 'Needs input', 'Checked 8:00 PM'])
    );
    expect(
      nodes(render(props, [172, 104]).light).some(node =>
        node.props.clickActionData?.uri?.endsWith('/new')
      )
    ).toBe(true);
  });

  it('shows action progress in the fixed detail slot and keeps the create control', () => {
    setSurfaceExtras({ newestSessionTitle: null, actionFeedback: 'approving' });
    const inFlight = render(propsFor(MIXED), [172, 104]).light;
    expect(texts(inFlight)).toContain('Approving…');
    expect(nodes(inFlight).some(node => node.props.clickAction === 'approve')).toBe(false);
    expect(nodes(inFlight).some(node => node.props.clickActionData?.uri?.endsWith('/new'))).toBe(
      true
    );
    setSurfaceExtras({ newestSessionTitle: null, actionFeedback: 'couldNotApprove' });
    const failed = render(propsFor(MIXED), [172, 104]).light;
    expect(texts(failed)).toContain('Could not approve');
    expect(nodes(failed).some(node => node.props.clickAction === 'approve')).toBe(true);
  });

  it.each(['signed_out', 'privacy'] as const)('removes titles and counts on %s', status => {
    const props = propsFor(MIXED, status);
    const shown = texts(render(props, [360, 464]).light).join(' ');
    expect(shown).not.toContain('Review the release');
    expect(shown).not.toContain('Build the app');
    expect(shown).not.toContain('Checked');
    expect(shown).not.toContain('1');
  });
});

it.each(CELLS)('keeps four-digit primary counts legible at %dx%d', (width, height) => {
  const props = propsFor(Array.from({ length: 9999 }, () => ({ status: 'busy' })));
  const tree = render(props, [width, height]).light;
  const count = nodes(tree).find(node => node.props.text === '9999');
  expect(count).toBeDefined();
  expect(count?.props.style?.fontSize).toBeGreaterThanOrEqual(22);
  expect(texts(tree)).toContain('Working');
  expect(minimumHeight(tree)).toBeLessThanOrEqual(height);
});
