import { afterEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { TestRenderer } from '@/test/renderer';

import { renderProfileRow } from './new-session-profile-row';

vi.mock('react-native', () => ({ View: 'View' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));

type RowProps = Parameters<typeof renderProfileRow>[0];

const PROFILE = {
  id: 'profile-1',
  name: 'Production',
  commandCount: 3,
  mcpServerCount: 1,
  skillCount: 2,
  agentCount: 4,
};

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;

afterEach(() => {
  renderer?.unmount();
  renderer = undefined;
});

function renderRow(overrides: Partial<RowProps> = {}) {
  const element = (
    <>
      {renderProfileRow({
        t: i18n.t.bind(i18n),
        profile: null,
        isProfileLoading: false,
        isProfileError: false,
        onRetryProfile: vi.fn<() => void>(),
        ...overrides,
      })}
    </>
  );
  TestRenderer.act(() => {
    if (renderer) {
      renderer.update(element);
    } else {
      renderer = TestRenderer.create(element);
    }
  });
  if (!renderer) {
    throw new Error('Profile row did not mount');
  }
  return renderer.root;
}

function text(root: TestRenderer.ReactTestInstance) {
  return root.findAllByType('Text').map(node => node.props.children);
}

function body(root: TestRenderer.ReactTestInstance) {
  return root.findByProps({ className: 'min-w-0 flex-1 gap-1' });
}

describe('new-session environment feedback', () => {
  it('renders loading feedback immediately without a false default, stale profile, or Retry', () => {
    const root = renderRow({ isProfileLoading: true, profile: PROFILE });

    expect(text(root)).toEqual(['Environment', 'Loading…', '\u00A0']);
    expect(root.findByProps({ children: 'Loading…' }).props).toMatchObject({
      accessibilityLiveRegion: 'polite',
      accessibilityState: { busy: true },
    });
    expect(root.findAllByType('Skeleton')).toHaveLength(1);
    expect(root.findAllByType('Button')).toHaveLength(0);
  });

  it('shows the resolved profile and summary without a loading indicator or extra action', () => {
    const root = renderRow({ profile: PROFILE });

    expect(text(root)).toEqual([
      'Environment',
      'Production',
      '3 commands · 1 MCP · 2 skills · 4 agents',
    ]);
    expect(root.findAllByType('Skeleton')).toHaveLength(0);
    expect(root.findAllByType('Button')).toHaveLength(0);
  });

  it('shows the default only after the query settles empty and hides the blank slot from accessibility', () => {
    const root = renderRow();

    expect(text(root)).toEqual(['Environment', 'Default environment', '\u00A0']);
    expect(
      root.findByProps({ importantForAccessibility: 'no-hide-descendants' }).props
    ).toMatchObject({
      accessibilityElementsHidden: true,
    });
    expect(root.findAllByType('Skeleton')).toHaveLength(0);
    expect(root.findAllByType('Button')).toHaveLength(0);
  });

  it('retries a failed request and replaces the error in place with loading and then content', () => {
    const onRetryProfile = vi.fn<() => void>();
    const root = renderRow({ isProfileError: true, onRetryProfile });
    const slot = body(root);

    expect(text(root)).toContain("Couldn't load your environment");
    const retry = root.findByType('Button');
    expect(retry.props.accessibilityLabel).toBe('Retry loading environment');
    const onPress = retry.props.onPress as () => void;
    TestRenderer.act(onPress);
    expect(onRetryProfile).toHaveBeenCalledExactlyOnceWith();

    const pending = renderRow({ isProfileLoading: true, isProfileError: true });
    expect(body(pending)).toBe(slot);
    expect(text(pending)).toContain('Loading…');
    expect(text(pending)).not.toContain("Couldn't load your environment");
    expect(pending.findAllByType('Button')).toHaveLength(0);

    const ready = renderRow({ profile: PROFILE });
    expect(body(ready)).toBe(slot);
    expect(text(ready)).toContain('Production');
    expect(ready.findByProps({ children: 'Production' }).props.accessibilityState).toEqual({
      busy: false,
    });
  });

  it.each([{ isProfileLoading: true }, { profile: PROFILE }, { isProfileError: true }, {}])(
    'keeps two font-scaled text lines reserved across a state swap: %j',
    next => {
      const pending = renderRow({ isProfileLoading: true });
      const slot = body(pending);
      expect(pending.findByType('Skeleton').props.className).toContain('absolute inset-y-0');

      const root = renderRow(next);
      expect(body(root)).toBe(slot);
      expect(
        root.findByProps({ className: 'min-h-[36px] flex-row items-center gap-2' })
      ).toBeTruthy();
      const lines = slot.findAllByType('Text');
      expect(lines).toHaveLength(2);
      for (const line of lines) {
        expect(line.props.numberOfLines).toBe(1);
        expect(line.props.className).toContain('text-sm leading-5');
        expect(line.props.children).not.toBe('');
      }
    }
  );
});
