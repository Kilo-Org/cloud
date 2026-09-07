/* eslint-disable typescript-eslint/no-deprecated -- DOM-free mounted React Native layout regression tests. */
import { type ComponentProps, createElement } from 'react';
import { View } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { SessionRow } from './session-row';

vi.mock('react-native', () => ({
  I18nManager: { isRTL: false },
  Pressable: 'Pressable',
  Text: 'Text',
  View: 'View',
}));
vi.mock('@rn-primitives/slot', () => ({ Text: 'Slot.Text' }));
vi.mock('@/components/ui/agent-badge', () => ({ AgentBadge: 'AgentBadge' }));
vi.mock('@/components/ui/session-status-icon', () => ({ SessionStatusIcon: 'SessionStatusIcon' }));
vi.mock('@/components/ui/directional-icons', () => ({ DirectionalChevronRight: 'ChevronRight' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedSoft: '#777777' }),
}));

type Props = ComponentProps<typeof SessionRow>;
const content = {
  agentLabel: 'Gefel',
  title: 'I4 Long Live Accessibility Title 12345678901234567',
  subtitle: 'feature/long-accessibility-regression-branch',
} satisfies Props;
const meta = '$0.0041 · 12 MINUTES AGO';
const platformIcon = createElement(View, { testID: 'platform-icon', accessible: false });
let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;

function renderRow(props: Partial<Props> = {}) {
  act(() => {
    const element = createElement(SessionRow, { ...content, ...props });
    if (renderer) {
      renderer.update(element);
    } else {
      renderer = TestRenderer.create(element);
    }
  });
  if (!renderer) {
    throw new Error('Missing SessionRow renderer');
  }
  return renderer.root;
}
function textNode(root: TestRenderer.ReactTestInstance, value: string) {
  return root.find(node => Object.is(node.type, 'Text') && node.children.includes(value));
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
});

describe('SessionRow mounted layout', () => {
  // Host props protect the layout contract; only native I4 can prove scaled glyph rendering.
  it.each([
    { name: 'plain metadata', live: false, icon: false },
    { name: 'metadata beside a platform icon', live: false, icon: true },
    { name: 'live metadata', live: true, icon: false },
    { name: 'live metadata beside a platform icon', live: true, icon: true },
  ])('bounds $name and requests an ellipsis instead of clipping', ({ live, icon }) => {
    const root = renderRow({
      live,
      meta,
      metaWhileLive: true,
      platformIcon: icon ? platformIcon : undefined,
    });
    const text = textNode(root, meta);
    expect(text.props.numberOfLines).toBe(1);
    expect(text.props.ellipsizeMode).toBe('tail');
    expect((text.props.className as string).split(' ')).toEqual(
      expect.arrayContaining(['shrink', 'font-mono-medium', 'text-xs', 'text-ink2'])
    );
    expect(text.props.allowFontScaling).not.toBe(false);
    expect(text.props.maxFontSizeMultiplier).toBeUndefined();
    expect(text.children).toEqual([meta]);

    if (live) {
      const cluster = root.findByProps({ kind: 'running' }).parent;
      expect((cluster?.props.className as string | undefined)?.split(' ')).toEqual(
        expect.arrayContaining(['shrink', 'min-w-0'])
      );
    }
    if (icon) {
      const cluster = root.findByProps({ testID: 'platform-icon' }).parent;
      expect((cluster?.props.className as string | undefined)?.split(' ')).toContain('shrink');
    }
  });

  it.each<{
    name: string;
    props: Partial<Props>;
    visibleMeta: boolean;
    needsInput: boolean;
    kind: 'needsInput' | 'running' | 'idle' | null;
    icon: boolean;
  }>([
    {
      name: 'needs-input priority',
      props: { live: true, needsInput: true, meta, metaWhileLive: true, platformIcon },
      visibleMeta: false,
      needsInput: true,
      kind: 'needsInput',
      icon: false,
    },
    {
      name: 'needs-input without live',
      props: { needsInput: true },
      visibleMeta: false,
      needsInput: true,
      kind: 'needsInput',
      icon: false,
    },
    {
      name: 'live with opted-in metadata',
      props: { live: true, meta, metaWhileLive: true, platformIcon },
      visibleMeta: true,
      needsInput: false,
      kind: 'running',
      icon: true,
    },
    {
      name: 'live without metadata opt-in',
      props: { live: true, meta, platformIcon },
      visibleMeta: false,
      needsInput: false,
      kind: 'running',
      icon: true,
    },
    {
      name: 'live without metadata',
      props: { live: true, metaWhileLive: true },
      visibleMeta: false,
      needsInput: false,
      kind: 'running',
      icon: false,
    },
    {
      name: 'live but idle',
      props: { live: true, statusKind: 'idle', meta, metaWhileLive: true },
      visibleMeta: true,
      needsInput: false,
      kind: 'idle',
      icon: false,
    },
    {
      name: 'metadata only',
      props: { meta },
      visibleMeta: true,
      needsInput: false,
      kind: null,
      icon: false,
    },
    {
      name: 'metadata with platform icon',
      props: { meta, platformIcon },
      visibleMeta: true,
      needsInput: false,
      kind: null,
      icon: true,
    },
    {
      name: 'platform icon only',
      props: { platformIcon },
      visibleMeta: false,
      needsInput: false,
      kind: null,
      icon: true,
    },
    {
      name: 'no status or metadata',
      props: {},
      visibleMeta: false,
      needsInput: false,
      kind: null,
      icon: false,
    },
  ])('preserves $name', test => {
    const root = renderRow(test.props);
    const texts = root.findAll(node => Object.is(node.type, 'Text'));
    expect(texts.some(node => node.children.includes(meta))).toBe(test.visibleMeta);
    expect(texts.some(node => node.children.includes('NEEDS INPUT'))).toBe(test.needsInput);
    expect(root.findAllByProps({ testID: 'platform-icon' })).toHaveLength(test.icon ? 1 : 0);
    const glyphs = root.findAll(node => Object.is(node.type, 'SessionStatusIcon'));
    expect(glyphs.map(glyph => glyph.props.kind)).toEqual(test.kind ? [test.kind] : []);
    expect(root.findAll(node => Object.is(node.type, 'Pressable'))).toHaveLength(0);
  });

  it.each(['edge', 'inline'] as const)(
    'retains full text, title identity, and two-line limits with the %s strip',
    stripMode => {
      const root = renderRow({ live: true, meta, metaWhileLive: true, stripMode });
      const title = textNode(root, content.title);
      const subtitle = textNode(root, content.subtitle);
      expect(title.props.numberOfLines).toBe(2);
      expect(title.props.className).toContain('text-sm');
      expect(title.props.className).toContain('text-foreground');
      expect(subtitle.props.numberOfLines).toBe(2);
      expect(subtitle.props.className).toContain('text-muted-foreground');
      expect(root.findAll(node => Object.is(node.type, 'AgentBadge'))).toHaveLength(
        stripMode === 'edge' ? 1 : 0
      );

      const updatedMeta = '$0.0042 · 13 MINUTES AGO';
      renderRow({ live: true, meta: updatedMeta, metaWhileLive: true, stripMode });

      expect(textNode(root, content.title)).toBe(title);
      expect(textNode(root, content.subtitle)).toBe(subtitle);
      expect(title.children).toEqual([content.title]);
      expect(subtitle.children).toEqual([content.subtitle]);
      expect(textNode(root, updatedMeta).props.numberOfLines).toBe(1);
      expect(root.findAll(node => Object.is(node.type, 'ChevronRight'))).toHaveLength(1);
    }
  );
});
