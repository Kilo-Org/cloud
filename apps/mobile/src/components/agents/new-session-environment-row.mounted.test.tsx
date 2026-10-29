import { afterEach, describe, expect, it, vi } from 'vitest';

import { TestRenderer } from '@/test/renderer';

import { NewSessionProfileRow } from './new-session-environment-row';

import { ROW_TARGET_CLASS } from '@/lib/a11y/tap-target';

import { i18n } from '@/i18n';

vi.mock('react-native', () => ({ Pressable: 'Pressable', View: 'View' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/icons', () => ({
  ChevronDown: 'ChevronDown',
  RefreshCw: 'RefreshCw',
  SlidersHorizontal: 'SlidersHorizontal',
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#666' }),
}));

type RowProps = Parameters<typeof NewSessionProfileRow>[0];

const PROFILE = {
  id: 'profile-1',
  name: 'Production',
  varCount: 2,
  mcpServerCount: 1,
  skillCount: 2,
  kiloCommandCount: 4,
  commandCount: 3,
  agentCount: 4,
};

const EMPTY_PROFILE = {
  ...PROFILE,
  varCount: 0,
  mcpServerCount: 0,
  skillCount: 0,
  kiloCommandCount: 0,
  commandCount: 0,
  agentCount: 0,
};

const CARD_CHROME = `${ROW_TARGET_CLASS} flex-row items-center gap-3 rounded-lg border border-border bg-card px-3 py-2.5`;

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;

afterEach(() => {
  renderer?.unmount();
  renderer = undefined;
});

function renderRow(overrides: Partial<RowProps> = {}) {
  const element = (
    <NewSessionProfileRow
      profile={null}
      isProfileLoading={false}
      isProfileError={false}
      overrideNeedsAttention={false}
      onRetryProfile={vi.fn<() => void>()}
      onOpenProfilePicker={vi.fn<() => void>()}
      {...overrides}
    />
  );
  TestRenderer.act(() => {
    if (renderer) {
      renderer.update(element);
    } else {
      renderer = TestRenderer.create(element);
    }
  });
  if (!renderer) {
    throw new Error('Environment row did not mount');
  }
  return renderer.root;
}

describe('new-session environment row accessible name', () => {
  it('names the picked profile after its pick purpose', () => {
    const control = renderRow({ profile: PROFILE }).findAllByType('Pressable')[0];

    expect(control?.props.accessibilityLabel).toBe(
      i18n.t('agentChat.newSession.environmentAccessibility', {
        purpose: i18n.t('agentChat.newSession.pickProfile'),
        label: 'Production',
      })
    );
    expect(control?.props.accessibilityHint).toBeUndefined();
  });

  it('keeps a non-Latin profile name in the accessible name', () => {
    const name = 'Cliente عميل بيروت';
    const control = renderRow({ profile: { ...PROFILE, name } }).findAllByType('Pressable')[0];

    expect(control?.props.accessibilityLabel).toContain(name);
    expect(control?.props.accessibilityLabel).not.toBe(i18n.t('agentChat.newSession.pickProfile'));
  });

  it('names the default environment when no profile resolves', () => {
    const control = renderRow().findAllByType('Pressable')[0];

    expect(control?.props.accessibilityLabel).toBe(
      i18n.t('agentChat.newSession.environmentAccessibility', {
        purpose: i18n.t('agentChat.newSession.pickProfile'),
        label: i18n.t('agentChat.newSession.defaultEnvironment'),
      })
    );
  });

  it('announces the attention line in the accessible name', () => {
    const control = renderRow({ profile: PROFILE, overrideNeedsAttention: true }).findAllByType(
      'Pressable'
    )[0];

    expect(control?.props.accessibilityLabel).toBe(
      i18n.t('agentChat.newSession.environmentAccessibilityNeedsAttention', {
        purpose: i18n.t('agentChat.newSession.pickProfile'),
        label: 'Production',
        attention: i18n.t('agentChat.newSession.configNeedsAttention'),
      })
    );
  });
});

describe('new-session environment row height', () => {
  it('renders a one-line summary at the placeholder height', () => {
    const root = renderRow({ profile: { ...PROFILE, kiloCommandCount: 0, commandCount: 0 } });
    const summary = root
      .findAllByType('Text')
      .map(node => node.props as { className?: string; numberOfLines?: number; children?: unknown })
      .find(props => props.className?.includes('min-h-10'));

    expect(summary?.numberOfLines).toBe(2);
    expect(summary?.children).toBe('2 vars · 1 MCP · 2 skills · 4 agents');
  });

  it.each([
    ['an unconfigured profile', { profile: EMPTY_PROFILE }],
    ['the default environment', {}],
  ])('keeps the two-line placeholder for %s', (_label, overrides) => {
    const root = renderRow(overrides);
    const summary = root
      .findAllByType('Text')
      .map(node => node.props as { className?: string; children?: unknown })
      .find(props => props.className?.includes('min-h-10'));

    expect(summary?.children).toBe('\u00A0\n\u00A0');
    expect(
      root.findByProps({ importantForAccessibility: 'no-hide-descendants' }).props
    ).toMatchObject({ accessibilityElementsHidden: true });
  });

  it.each([
    ['loading', { isProfileLoading: true }],
    ['failure', { isProfileError: true }],
    ['a resolved profile', { profile: PROFILE }],
    ['an unconfigured profile', { profile: EMPTY_PROFILE }],
    ['the default environment', {}],
  ])('renders %s inside the same card', (_label, overrides) => {
    const root = renderRow(overrides);
    const cards = [...root.findAllByType('View'), ...root.findAllByType('Pressable')]
      .map(node => node.props.className as unknown)
      .filter((className): className is string => typeof className === 'string')
      .filter(className => className.includes(CARD_CHROME));

    expect(cards).toHaveLength(1);
  });
});
