import { act, createElement, type ElementType } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { CenteredState } from '@/components/centered-state';
import { Button } from '@/components/ui/button';
import { renderWithProviders } from '@/test/render-with-providers';
import { SecurityAgentSetup } from './security-agent-setup';

const authorization = vi.hoisted(() => vi.fn());
const reportLate = vi.hoisted(() => vi.fn());
vi.mock('@/components/ui/activity-indicator', () => ({ ActivityIndicator: 'ActivityIndicator' }));
vi.mock('react-native', () => ({
  View: 'View',
  ActivityIndicator: 'ActivityIndicator',
  Platform: { OS: 'ios' },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/ui/icons', () => ({ ShieldCheck: 'ShieldCheck' }));
vi.mock('@/components/centered-state', () => ({ CenteredState: 'CenteredState' }));
vi.mock('@/components/ui/accessible-status', () => ({ AccessibleStatus: 'AccessibleStatus' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({ useThemeColors: () => ({}) }));
vi.mock('@/lib/pr-review/connect-gate-platform', () => ({
  openAuthorizationAndWaitForReturn: authorization,
  reportLateLaunchFailure: reportLate,
}));

let mounted: Awaited<ReturnType<typeof renderWithProviders>> | undefined = undefined;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  authorization.mockReset().mockResolvedValue(undefined);
  reportLate.mockReset();
});
afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
  vi.unstubAllGlobals();
});

it('centers setup, disables Connect while authorizing, and refreshes on return', async () => {
  const result = Promise.withResolvers<undefined>();
  authorization.mockReturnValueOnce(result.promise);
  const onConnected = vi.fn().mockResolvedValue(undefined);
  mounted = await renderWithProviders(
    createElement(SecurityAgentSetup, {
      title: 'Connect GitHub',
      description: 'Authorize the GitHub App.',
      buttonLabel: 'Connect',
      url: 'https://github.com/apps/kilo',
      resolveUrl: async () => {
        await Promise.resolve();
        return 'https://github.com/apps/kilo';
      },
      onConnected,
    })
  );
  const body = mounted.renderer.root.findByType(CenteredState);
  const button = body.findByType(Button);
  expect(button.props.disabled).toBe(false);
  act(button.props.onPress as () => void);
  await act(async () => {
    await Promise.resolve();
  });
  expect(button.props.disabled).toBe(true);
  expect(authorization).toHaveBeenCalledWith('https://github.com/apps/kilo');
  expect(onConnected).not.toHaveBeenCalled();
  await act(async () => {
    result.resolve(undefined);
    await result.promise;
  });
  expect(onConnected).toHaveBeenCalledOnce();
  expect(button.props.disabled).toBe(false);
});

it('shows the setup failure in the body and stays mounted when no URL can be resolved', async () => {
  const onConnected = vi.fn().mockResolvedValue(undefined);
  mounted = await renderWithProviders(
    createElement(SecurityAgentSetup, {
      title: 'Connect GitHub',
      description: 'Authorize the GitHub App.',
      buttonLabel: 'Connect',
      resolveUrl: async () => {
        await Promise.resolve();
        return undefined;
      },
      onConnected,
    })
  );
  const body = mounted.renderer.root.findByType(CenteredState);
  const button = body.findByType(Button);
  act(button.props.onPress as () => void);
  await act(async () => {
    await Promise.resolve();
  });
  expect(authorization).not.toHaveBeenCalled();
  expect(onConnected).not.toHaveBeenCalled();
  expect(body.findByType('AccessibleStatus' as ElementType).props.message).toBe(
    'securityAgent.scopeEntry.setupFailed'
  );
  expect(button.props.disabled).toBe(false);
});

it('reports a launch that never opened and clears the line on the next press', async () => {
  // The wait settles on the foreground edge while the browser's own report is
  // still pending; a late failure arrives after `onConnected` already ran.
  authorization.mockResolvedValue({
    reported: new Promise<undefined>(() => undefined),
    settledByLaunch: false,
  });
  let onLateFailure: (() => void) | undefined = undefined;
  reportLate.mockImplementationOnce((_wait: unknown, handlers: { onFailure: () => void }) => {
    onLateFailure = handlers.onFailure;
  });
  mounted = await renderWithProviders(
    createElement(SecurityAgentSetup, {
      title: 'Connect GitHub',
      description: 'Authorize the GitHub App.',
      buttonLabel: 'Connect',
      url: 'https://github.com/apps/kilo',
      resolveUrl: () => Promise.resolve('https://github.com/apps/kilo'),
      onConnected: vi.fn().mockResolvedValue(undefined),
    })
  );
  const body = mounted.renderer.root.findByType(CenteredState);
  const button = body.findByType(Button);
  expect(body.findAllByType('AccessibleStatus' as ElementType)[0]?.props.message).toBeNull();
  act(button.props.onPress as () => void);
  await act(async () => {
    await Promise.resolve();
  });
  expect(onLateFailure).toBeDefined();
  act(() => {
    onLateFailure?.();
  });
  expect(body.findByType('AccessibleStatus' as ElementType).props.message).toBe(
    'securityAgent.setup.couldNotOpenGithub'
  );
  act(button.props.onPress as () => void);
  expect(body.findByType('AccessibleStatus' as ElementType).props.message).toBeNull();
  await act(async () => {
    await Promise.resolve();
  });
});
