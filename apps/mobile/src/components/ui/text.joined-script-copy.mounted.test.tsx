/**
 * PR #6497 proof (finding home-arabic): the Arabic home overline, its action and
 * the bottom-nav labels carried the tracked all-caps display treatment, whose
 * added advance splits a cursive script's joins mid-word («الوكلاء» draws as
 * «الوكلا ء»). These tests render the shipped components with the *real* catalog
 * copy — the exact keys the finding names, so the proof cannot drift from the
 * translation — and assert the inline `letterSpacing: 0` that clears the class's
 * `tracking-*`, while the Latin copy keeps its tracking.
 */
import { createElement, type ReactElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SectionHeader } from '@/components/home/section-header';
import { TabBarLabel } from '@/components/tab-bar-label';
import ar from '@/i18n/locales/ar.json';
import en from '@/i18n/locales/en.json';

const i18nManager = vi.hoisted(() => ({ isRTL: false }));
// `Text` and `SectionHeader` read the native direction at render time, so the
// mutable flag drives each render; the host text element is the assertion target.
vi.mock('react-native', () => ({
  I18nManager: i18nManager,
  Pressable: 'Pressable',
  Text: 'Text',
  View: 'View',
}));
// `@rn-primitives/slot` ships untranspiled JSX and is only reached by `asChild`.
vi.mock('@rn-primitives/slot', () => ({ Text: 'Slot.Text' }));

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;
function mount(element: ReactElement) {
  act(() => {
    renderer = TestRenderer.create(element);
  });
  if (!renderer) {
    throw new Error('Missing renderer');
  }
  return renderer.root;
}

function hostTextWithChildren(root: TestRenderer.ReactTestInstance, children: string) {
  return root.find(node => Object.is(node.type, 'Text') && node.children.includes(children));
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  i18nManager.isRTL = false;
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
});

// The home overline and its action: `SectionHeader` renders them with the
// eyebrow variant and `EYEBROW_LATIN_DISPLAY` (`tracking-[1.5px]`).
const OVERLINE_AR = ar.home.agentSessions;
const OVERLINE_EN = en.home.agentSessions;
const ACTION_AR = ar.home.seeAll;
const ACTION_EN = en.home.seeAll;

// The bottom-nav labels, sourced from the tab layout's keys.
const NAV = [
  { name: 'home', ar: ar.tabs.home, en: en.tabs.home },
  { name: 'agents', ar: ar.common.agents, en: en.common.agents },
  { name: 'profile', ar: ar.common.profile, en: en.common.profile },
  { name: 'chat', ar: ar.common.chat, en: en.common.chat },
] as const;

describe('home overline and action with real copy', () => {
  it.each([false, true])(
    'clears the tracked letter-spacing on the Arabic overline and action (RTL=%s)',
    isRTL => {
      i18nManager.isRTL = isRTL;
      const root = mount(
        createElement(SectionHeader, {
          label: OVERLINE_AR,
          actionLabel: ACTION_AR,
          onActionPress: () => undefined,
        })
      );
      const label = hostTextWithChildren(root, OVERLINE_AR);
      const action = root.findByProps({ accessibilityRole: 'button' });
      const actionText = action.find(node => Object.is(node.type, 'Text'));

      // Outside RTL the LTR display class is still on the label…
      if (!isRTL) {
        expect((label.props.className as string).split(' ')).toContain('tracking-[1.5px]');
      }
      // …and the inline override beats it in both directions.
      expect(label.props.style).toContainEqual({ letterSpacing: 0 });
      expect(actionText.props.style).toContainEqual({ letterSpacing: 0 });
    }
  );

  it('keeps the English overline tracked and never clears it', () => {
    const root = mount(
      createElement(SectionHeader, {
        label: OVERLINE_EN,
        actionLabel: ACTION_EN,
        onActionPress: () => undefined,
      })
    );
    const label = hostTextWithChildren(root, OVERLINE_EN);
    const action = root.findByProps({ accessibilityRole: 'button' });
    const actionText = action.find(node => Object.is(node.type, 'Text'));

    expect((label.props.className as string).split(' ')).toContain('tracking-[1.5px]');
    expect((actionText.props.className as string).split(' ')).toContain('uppercase');
    expect(label.props.style).toBeUndefined();
    expect(actionText.props.style).toBeUndefined();
  });
});

describe('bottom-nav labels with real copy', () => {
  it.each(NAV)('clears the tracked letter-spacing on the Arabic $name label', ({ ar: label }) => {
    const text = hostTextWithChildren(
      mount(createElement(TabBarLabel, { label: label, focused: false })),
      label
    );

    expect(text.props.className as string).toContain('tracking-[0.2px]');
    expect(text.props.style).toContainEqual({ letterSpacing: 0 });
  });

  it.each(NAV)('keeps the Latin tracking on the English $name label', ({ en: label }) => {
    const text = hostTextWithChildren(
      mount(createElement(TabBarLabel, { label: label, focused: false })),
      label
    );

    expect(text.props.className as string).toContain('tracking-[0.2px]');
    expect(text.props.style).toBeUndefined();
  });

  it.each([en.common.kiloclaw, en.tabs.kiloclawWrapped])(
    'never clears the spacing on the Latin KiloClaw label %j',
    label => {
      const text = hostTextWithChildren(
        mount(createElement(TabBarLabel, { label: label, focused: false })),
        label
      );

      expect(text.props.style).toBeUndefined();
    }
  );
});
