import { act, createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { EmptyState } from '@/components/empty-state';
import { Button } from '@/components/ui/button';
import { renderWithProviders } from '@/test/render-with-providers';
import { SecurityAgentSetup } from './security-agent-setup';

const authorization = vi.hoisted(() => vi.fn());
vi.mock('@/components/ui/activity-indicator', () => ({ ActivityIndicator: 'ActivityIndicator' }));
vi.mock('react-native', () => ({
  View: 'View',
  ActivityIndicator: 'ActivityIndicator',
  Platform: { OS: 'ios' },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('sonner-native', () => ({ toast: { error: vi.fn() } }));
vi.mock('@/components/ui/icons', () => ({ ShieldCheck: 'ShieldCheck' }));
vi.mock('@/components/empty-state', () => ({ EmptyState: 'EmptyState' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({ useThemeColors: () => ({}) }));
vi.mock('@/lib/pr-review/connect-gate-platform', () => ({
  openAuthorizationAndWaitForReturn: authorization,
}));

let mounted: Awaited<ReturnType<typeof renderWithProviders>> | undefined = undefined;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  authorization.mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
  vi.unstubAllGlobals();
});

/** The `action` the setup passes to `EmptyState`, so the install button is reached through it. */
type SetupAction = ReactElement<{ disabled: boolean; onPress: () => void; children?: ReactNode }>;

/** The button label lives in the action's `Text` child; `EmptyState` renders the action itself. */
function actionLabel(action: SetupAction): string | undefined {
  const children: ReactNode[] = Array.isArray(action.props.children)
    ? action.props.children
    : [action.props.children];
  const text = children.find(
    (child): child is ReactElement<{ children: string }> =>
      isValidElement<{ children?: ReactNode }>(child) && typeof child.props.children === 'string'
  );
  return text?.props.children;
}

it('mounts the connect copy through the shared EmptyState with the install action', async () => {
  mounted = await renderWithProviders(
    createElement(SecurityAgentSetup, {
      title: 'Connect GitHub',
      description: 'Authorize the GitHub App.',
      buttonLabel: 'Install GitHub App',
      url: 'https://github.com/apps/kilo',
      onConnected: vi.fn().mockResolvedValue(undefined),
    })
  );
  const empty = mounted.renderer.root.findByType(EmptyState);
  expect(empty.props.title).toBe('Connect GitHub');
  expect(empty.props.description).toBe('Authorize the GitHub App.');
  const action = empty.props.action as SetupAction;
  expect(action.type).toBe(Button);
  expect(actionLabel(action)).toBe('Install GitHub App');
});

it('mounts the reauthorize copy through the shared EmptyState', async () => {
  mounted = await renderWithProviders(
    createElement(SecurityAgentSetup, {
      title: 'securityAgent.scopeEntry.reauthorizeTitle',
      description: 'securityAgent.scopeEntry.reauthorizeDescription',
      buttonLabel: 'securityAgent.scopeEntry.reauthorizeButton',
      url: 'https://github.com/apps/kilo',
      onConnected: vi.fn().mockResolvedValue(undefined),
    })
  );
  const empty = mounted.renderer.root.findByType(EmptyState);
  expect(empty.props.title).toBe('securityAgent.scopeEntry.reauthorizeTitle');
  expect(empty.props.description).toBe('securityAgent.scopeEntry.reauthorizeDescription');
  expect(actionLabel(empty.props.action as SetupAction)).toBe(
    'securityAgent.scopeEntry.reauthorizeButton'
  );
});

it('disables the connect action while authorizing, and refreshes on return', async () => {
  const result = Promise.withResolvers<undefined>();
  authorization.mockReturnValueOnce(result.promise);
  const onConnected = vi.fn().mockResolvedValue(undefined);
  mounted = await renderWithProviders(
    createElement(SecurityAgentSetup, {
      title: 'Connect GitHub',
      description: 'Authorize the GitHub App.',
      buttonLabel: 'Connect',
      url: 'https://github.com/apps/kilo',
      onConnected,
    })
  );
  const root = mounted.renderer.root;
  const actionOf = () => root.findByType(EmptyState).props.action as SetupAction;
  expect(actionOf().props.disabled).toBe(false);
  act(actionOf().props.onPress);
  expect(actionOf().props.disabled).toBe(true);
  expect(authorization).toHaveBeenCalledWith('https://github.com/apps/kilo');
  expect(onConnected).not.toHaveBeenCalled();
  await act(async () => {
    result.resolve(undefined);
    await result.promise;
  });
  expect(onConnected).toHaveBeenCalledOnce();
  expect(actionOf().props.disabled).toBe(false);
});
