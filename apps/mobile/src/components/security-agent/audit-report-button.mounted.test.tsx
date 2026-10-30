// A fast double tap on the audit-report header action used to push the report
// twice, so one Back press returned to an identical report. The action now
// claims one push per press burst, and the guard clears when the screen regains
// focus so the press after a return still navigates.

import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AuditReportButton } from './audit-report-button';
import { getSecurityAgentPath } from '@/lib/security-agent';

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  focusEffect: { current: undefined as (() => void) | undefined },
}));

vi.mock('expo-router', () => ({
  useRouter: () => ({ push: mocks.push }),
  // The screen is always mounted here, so the focus event is simulated by
  // running the callback the hook registered with `useFocusEffect`.
  useFocusEffect: (effect: () => void) => {
    mocks.focusEffect.current = effect;
  },
}));
vi.mock('@/components/ui/icon-button', () => ({ IconButton: 'IconButton' }));
vi.mock('@/components/ui/icons', () => ({ MoreHorizontal: 'MoreHorizontal' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ foreground: '#000' }),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

type R = TestRenderer.ReactTestRenderer;

function renderButton(scope: string): R {
  const ref: { current: R | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(createElement(AuditReportButton, { scope }));
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

function press(tree: R): void {
  const button = tree.root.findByType('IconButton');
  act(() => {
    (button.props.onPress as () => void)();
  });
}

function pressTwiceInOneBurst(tree: R): void {
  const button = tree.root.findByType('IconButton');
  act(() => {
    (button.props.onPress as () => void)();
    (button.props.onPress as () => void)();
  });
}

describe('AuditReportButton navigation', () => {
  beforeEach(() => {
    mocks.push.mockClear();
    mocks.focusEffect.current = undefined;
  });

  it('opens the audit report on a single tap', () => {
    const tree = renderButton('org_123');

    press(tree);

    expect(mocks.push).toHaveBeenCalledTimes(1);
    expect(mocks.push).toHaveBeenCalledWith(getSecurityAgentPath('org_123', 'audit-report'));
  });

  it('opens the audit report once on a fast double tap', () => {
    const tree = renderButton('personal');

    pressTwiceInOneBurst(tree);

    expect(mocks.push).toHaveBeenCalledTimes(1);
    expect(mocks.push).toHaveBeenCalledWith(getSecurityAgentPath('personal', 'audit-report'));
  });

  it('opens the report again after the screen regains focus', () => {
    const tree = renderButton('personal');

    press(tree);
    press(tree);
    expect(mocks.push).toHaveBeenCalledTimes(1);

    act(() => {
      mocks.focusEffect.current?.();
    });
    press(tree);

    expect(mocks.push).toHaveBeenCalledTimes(2);
  });
});
