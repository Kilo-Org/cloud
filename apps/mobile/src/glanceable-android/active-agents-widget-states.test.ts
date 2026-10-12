import { buildHomeWidgetData } from '@kilocode/app-shared/home-widget';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { _resetHomeWidgetDataForTests } from '@/lib/glanceable/home-widget-data';
import { setSurfaceExtras } from '@/lib/glanceable/surface-extras';
import { darkColors, lightColors } from '@/lib/hooks/theme-colors.generated';

import {
  byKey,
  CELLS,
  DESIGN,
  hasKey,
  nodes,
  NOW,
  placed,
  rectOf,
  render,
  texts,
  translate,
} from './active-agents-widget.test-helpers';
import {
  close,
  expectInsideBand,
  LONG,
  PERMISSION,
  type State,
  stateProps,
  STATES,
  targets,
} from './active-agents-widget.test-fixtures';
import { buildCurrentWidgetProps } from './widget-props';

vi.mock('react-native-android-widget', () => ({
  FlexWidget: () => null,
  ImageWidget: () => null,
  OverlapWidget: () => null,
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

describe('Home widget extra height', () => {
  it('spends a taller Small cell on agent lines, then splits the rest evenly', () => {
    const props = stateProps(STATES['needs input with Approve']);
    const short = render(props, [170, 170]).light;
    const tall = render(props, [172, 224]).light;
    expect(placed(short).filter(node => node.key?.startsWith('line-'))).toHaveLength(1);
    expect(placed(tall).filter(node => node.key?.startsWith('line-'))).toHaveLength(3);
    close(rectOf(byKey(tall, 'footer')).y, 224 - 16 - 15);
  });

  it('adds Medium and Large rows only when they fit', () => {
    const props = stateProps(STATES['needs input with Approve']);
    const rows = (size: readonly [number, number]) =>
      placed(render(props, size).light).filter(node => /^row-\d-title$/u.test(node.key ?? ''))
        .length;
    expect(rows([467, 208])).toBe(2);
    expect(rows([360, 224])).toBe(3);
    expect(rows([360, 344])).toBe(2);
    expect(rows([360, 464])).toBe(3);
  });

  it('splits a taller narrow cell evenly across its three gaps', () => {
    const props = stateProps(STATES.working);
    const y = (height: number, key: string) =>
      rectOf(byKey(render(props, [172, height]).light, key)).y;
    const extra = 31;
    close(y(135, 'status') - y(104, 'status'), extra / 3);
    close(y(135, 'footer') - y(104, 'footer'), (extra * 2) / 3);
  });
});

describe('Home widget states', () => {
  const at = (state: State, size: readonly [number, number]) =>
    render(stateProps(state), size).light;

  it('shows approve progress in the Approve slot and the failure in place of the detail', () => {
    const approving = at(STATES.approving, DESIGN.small);
    expect(hasKey(approving, 'approving-glyph')).toBe(true);
    expect(hasKey(approving, 'approve-target')).toBe(false);
    expect(hasKey(approving, 'create-target')).toBe(true);
    expect(texts(at(STATES.approving, DESIGN.medium))).toContain('Approving…');
    const failed = at(STATES['could not approve'], DESIGN.small);
    expect(byKey(failed, 'line-0').props.text).toBe('Could not approve');
    expect(hasKey(failed, 'approve-target')).toBe(true);
    expect(byKey(at(STATES['could not approve'], DESIGN.medium), 'footer').props.text).toBe(
      "Couldn't approve. Tap Approve to try again."
    );
    expect(byKey(at(STATES['could not approve'], DESIGN.narrow), 'footer').props.text).toBe(
      'Could not approve'
    );
  });

  it('keeps the Approve slot empty without moving `+` when no approval is possible', () => {
    for (const size of Object.values(DESIGN)) {
      const withApprove = at(STATES['needs input with Approve'], size);
      const without = at(STATES['needs input without Approve'], size);
      expect(hasKey(without, 'approve-target')).toBe(false);
      expect(rectOf(byKey(without, 'create-target'))).toEqual(
        rectOf(byKey(withApprove, 'create-target'))
      );
    }
  });

  it('hides the header `+` on an empty Medium/Large cell behind one New agent pill', () => {
    for (const size of [DESIGN.medium, DESIGN.large, [266, 344] as const]) {
      const root = at(STATES.empty, size);
      expect(hasKey(root, 'create-glyph')).toBe(false);
      expect(hasKey(root, 'new-agent-pill')).toBe(true);
      expect(targets(root)).toHaveLength(1);
      expect(texts(root)).toEqual(
        expect.arrayContaining(['Nothing running right now', 'New agent'])
      );
    }
    expect(hasKey(at(STATES.empty, DESIGN.small), 'create-glyph')).toBe(true);
    expect(texts(at(STATES.empty, DESIGN.narrow))).toContain('No work in progress');
  });

  it('draws updating placeholders with no actions', () => {
    for (const size of Object.values(DESIGN)) {
      const root = at(STATES.updating, size);
      expect(targets(root)).toEqual([]);
      expect(placed(root).some(node => node.key?.startsWith('bar-'))).toBe(true);
      // The 4x1 row draws bars only (round 5): its header has no footer slot while updating.
      if (size !== DESIGN.row) {
        expect(texts(root)).toContain('Updating agents');
      }
    }
  });

  it.each(['privacy', 'signed out'] as const)(
    'locks %s with a two-shape lock and no actions or titles',
    name => {
      for (const size of Object.values(DESIGN)) {
        const root = at(STATES[name], size);
        expect(hasKey(root, 'lock-shackle')).toBe(true);
        expect(hasKey(root, 'lock-body')).toBe(true);
        expect(targets(root)).toEqual([]);
        const shown = texts(root).join(' ');
        expect(shown).not.toContain('Review the release');
        expect(shown).not.toContain('Checked');
      }
    }
  );

  it('labels scheduled time today, overdue and unknown without relative words', () => {
    const today = texts(at(STATES['scheduled today'], DESIGN.small));
    expect(today).toContain('Next run 8:00 PM');
    expect(texts(at(STATES['scheduled today'], DESIGN.large))).toEqual(
      expect.arrayContaining(['Usage report', 'Dependency audit', '8:00 PM'])
    );
    expect(texts(at(STATES['scheduled today'], DESIGN.narrow))).toContain('Next run 8:00 PM');
    const overdue = at(STATES['scheduled overdue'], DESIGN.small);
    expect(byKey(overdue, 'line-0').props.style?.textAlign).toBe('left');
    expect(byKey(overdue, 'line-0').props.text).toBe('Awaiting update');
    expect(texts(at(STATES['scheduled unknown time'], DESIGN.small))).toContain('Dependency audit');
  });

  it('shows the latest title for working and idle, and counts for mixed', () => {
    expect(texts(at(STATES.working, DESIGN.medium))).toEqual(
      expect.arrayContaining(['Recent', 'Fix the flaky login test'])
    );
    expect(texts(at(STATES.mixed, DESIGN.medium))).toEqual(
      expect.arrayContaining(['1 Scheduled', '1 Idle'])
    );
    expect(texts(at(STATES.mixed, DESIGN.large))).toEqual(
      expect.arrayContaining(['Recent', 'Build the app', 'Next scheduled', 'Morning checks'])
    );
    expect(hasKey(at(STATES.idle, DESIGN.small), 'status')).toBe(true);
  });

  it('keeps a stress count at full size and an untitled agent generic', () => {
    for (const size of Object.values(DESIGN)) {
      const root = at(STATES.stress, size);
      const count = nodes(root).find(node => node.props.text === '9999');
      expect(count?.props.style?.fontSize).toBeGreaterThanOrEqual(20);
    }
    expect(texts(at(STATES.stress, DESIGN.large))).toEqual(expect.arrayContaining([LONG, 'Agent']));
  });

  it.each(CELLS)('keeps German and Arabic/RTL copy inside the band at %dx%d', (width, height) => {
    for (const language of ['de', 'ar']) {
      const translated = (key: string) =>
        language === 'ar' ? `العربية ${translate(key)}` : `Deutsch ${translate(key)}`;
      for (const [name, state] of Object.entries(STATES) as [string, State][]) {
        const props = stateProps(state, translated);
        const root = render(props, [width, height], language === 'ar').light;
        expectInsideBand(root, [width, height], `${language} ${name}`);
      }
      const props = stateProps(STATES['needs input with Approve'], translated);
      const root = render(props, [width, height], language === 'ar').light;
      const label = nodes(root).find(node => node.props.text === props.homeCopy?.primaryLabel);
      expect(label?.props.style?.textAlign).toBe(language === 'ar' ? 'right' : 'left');
    }
  });

  it('uses the approved palettes', () => {
    const { light, dark } = render(stateProps(STATES.working), DESIGN.small);
    expect(light.props.style?.backgroundColor).toBe(lightColors.background);
    expect(dark.props.style?.backgroundColor).toBe(darkColors.card);
  });

  it('retains last-known data after activity expiry without renewing the checked time', () => {
    const data = buildHomeWidgetData({
      sessions: PERMISSION,
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
    const root = render(props, DESIGN.narrow).light;
    expect(texts(root)).toEqual(
      expect.arrayContaining(['3', 'Needs input', 'Last known · 8:00 PM'])
    );
    expect(hasKey(root, 'create-target')).toBe(true);
  });
});
