// A fast double tap on the audit-report header action used to push the report
// twice, so one Back press returned to an identical report. The action now
// claims one push per press burst, which these cases pin: the burst pushes
// once, and a press on a different destination in the same burst still opens.

import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AuditReportButton } from './audit-report-button';
import { getSecurityAgentPath } from '@/lib/security-agent';

const mocks = vi.hoisted(() => ({ push: vi.fn() }));

vi.mock('expo-router', () => ({
  useRouter: () => ({ push: mocks.push }),
  useFocusEffect: () => undefined,
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
  });

  it('opens the audit report once on a fast double tap', () => {
    const tree = renderButton('personal');

    pressTwiceInOneBurst(tree);

    expect(mocks.push).toHaveBeenCalledTimes(1);
    expect(mocks.push).toHaveBeenCalledWith(getSecurityAgentPath('personal', 'audit-report'));
  });

  it('opens the audit report on a single tap', () => {
    const tree = renderButton('org_123');

    press(tree);

    expect(mocks.push).toHaveBeenCalledTimes(1);
    expect(mocks.push).toHaveBeenCalledWith(getSecurityAgentPath('org_123', 'audit-report'));
  });

  it('still navigates when the mount is new after a return', () => {
    press(renderButton('personal'));
    // A return unmounts the report and remounts the scope entry, so the guard
    // state is new: the next press must navigate again.
    press(renderButton('personal'));

    expect(mocks.push).toHaveBeenCalledTimes(2);
  });
});
