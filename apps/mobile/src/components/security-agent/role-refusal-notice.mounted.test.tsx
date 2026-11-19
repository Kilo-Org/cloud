import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, TestRenderer } from '@/test/renderer';

import { RoleRefusalNotice } from './role-refusal-notice';

const MESSAGE = 'Only organization owners can choose a repository.';

const platform = vi.hoisted(() => ({ os: 'android' as string }));
const announceForA11y = vi.hoisted(() => vi.fn<(message: string) => void>());

vi.mock('react-native', () => ({
  View: 'View',
  Platform: {
    get OS() {
      return platform.os;
    },
  },
}));
vi.mock('@/lib/a11y/announce', () => ({ announceForA11y }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/icons', () => ({ Info: 'Info' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({ useThemeColors: () => ({}) }));
// The component shares its classes through the app's own `cn`, which imports
// the i18n instance; this suite does not need that chain.
vi.mock('@/lib/utils', () => ({
  cn: (...inputs: unknown[]) => inputs.filter(input => typeof input === 'string').join(' '),
}));

let mounted: TestRenderer.ReactTestRenderer | undefined = undefined;

afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
  announceForA11y.mockReset();
});

async function renderNotice() {
  await act(() => {
    mounted = TestRenderer.create(createElement(RoleRefusalNotice, { message: MESSAGE }));
  });
  const renderer = mounted;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

describe('RoleRefusalNotice mounted', () => {
  it('renders the message once, whole', async () => {
    platform.os = 'android';
    const renderer = await renderNotice();

    const carriers = renderer.root.findAll(node => node.props.children === MESSAGE);
    expect(carriers).toHaveLength(1);
  });

  it('announces once on iOS, which has no live region', async () => {
    platform.os = 'ios';
    const renderer = await renderNotice();

    expect(announceForA11y).toHaveBeenCalledTimes(1);
    expect(announceForA11y).toHaveBeenCalledWith(MESSAGE);
    const notice = renderer.root.findAll(node => node.props.accessibilityRole === 'alert');
    expect(notice).toHaveLength(1);
    expect(notice[0]?.props.accessibilityLiveRegion).toBeUndefined();
  });

  it('lets Android read the polite live region instead of announcing as well', async () => {
    platform.os = 'android';
    const renderer = await renderNotice();

    expect(announceForA11y).not.toHaveBeenCalled();
    const notice = renderer.root.findAll(node => node.props.accessibilityRole === 'alert');
    expect(notice).toHaveLength(1);
    expect(notice[0]?.props.accessible).toBe(true);
    expect(notice[0]?.props.accessibilityLiveRegion).toBe('polite');
  });

  it('does not announce a second time when the same message re-renders', async () => {
    platform.os = 'ios';
    const renderer = await renderNotice();
    expect(announceForA11y).toHaveBeenCalledTimes(1);

    await act(() => {
      renderer.update(createElement(RoleRefusalNotice, { message: MESSAGE }));
    });

    expect(announceForA11y).toHaveBeenCalledTimes(1);
  });
});
