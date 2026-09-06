import { act, createElement, type ElementType, type ReactElement } from 'react';
import { Platform } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CenteredState } from '@/components/centered-state';
import { AccessRequiredScreen, type AccessRequiredSubcase } from '../access-required-screen';
import { EmptyStateContent } from '../empty-state-content';
import { OnboardingFlow } from '../onboarding-flow';
import { openExternalUrl } from '@/lib/external-link';
import { SUPPORT_EMAIL } from '@/lib/kiloclaw/access-issue';
import { INITIAL_STATE } from '@/lib/onboarding';
import { renderWithProviders } from '@/test/render-with-providers';
import { CompleteStep } from './complete-step';
import { FlowBody } from './flow-body';
import { ProvisioningStep } from './provisioning-step';

const mocks = vi.hoisted(() => ({
  onboarding: vi.fn(),
  retry: vi.fn<() => void>(),
  background: vi.fn<() => void>(),
  mutations: {
    start: { mutate: vi.fn() },
    provision: { mutate: vi.fn() },
    patchBotIdentity: { mutate: vi.fn() },
    patchExecPreset: { mutate: vi.fn() },
  },
}));

vi.mock('react-native', () => ({
  View: 'View',
  Pressable: 'Pressable',
  ActivityIndicator: 'ActivityIndicator',
  Platform: { OS: 'android' },
  Linking: { openURL: vi.fn() },
}));
vi.mock('react-native-reanimated', () => ({
  default: { View: 'AnimatedView' },
  cancelAnimation: vi.fn(),
  FadeIn: { duration: vi.fn() },
  FadeOut: { duration: vi.fn() },
  LinearTransition: {},
  ZoomIn: { springify: () => ({ damping: () => ({ stiffness: vi.fn() }) }) },
  useAnimatedStyle: vi.fn(),
  useSharedValue: (value: number) => ({ value }),
  withDelay: vi.fn(),
  withSequence: vi.fn(),
  withTiming: vi.fn(),
}));
vi.mock('@/lib/a11y/motion', () => ({
  useMotionPolicy: () => ({ reducedMotion: true, scrollAnimated: false }),
}));
vi.mock('@/components/ui/activity-indicator', () => ({
  ActivityIndicator: 'ActivityIndicator',
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/i18n', () => ({ i18n: { t: (key: string) => key, language: 'en' } }));
vi.mock('expo-router', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), back: vi.fn() }),
}));
vi.mock('@/components/centered-state', () => ({ CenteredState: 'CenteredState' }));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
vi.mock('@/components/ui/icons', () => ({
  AlertCircle: 'AlertCircle',
  AlertTriangle: 'AlertTriangle',
  Clock: 'Clock',
  ExternalLink: 'ExternalLink',
  LifeBuoy: 'LifeBuoy',
  PauseCircle: 'PauseCircle',
  ShieldAlert: 'ShieldAlert',
  Lock: 'Lock',
  SearchX: 'SearchX',
  ServerCrash: 'ServerCrash',
  WifiOff: 'WifiOff',
  Server: 'Server',
  X: 'X',
  Plus: 'Plus',
}));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/accessible-status', () => ({ AccessibleStatus: 'AccessibleStatus' }));
vi.mock('@/components/ui/status-dot', () => ({ StatusDot: 'StatusDot' }));
vi.mock('@/components/kiloclaw/bot-avatar', () => ({ BotAvatar: 'BotAvatar' }));
vi.mock('./identity-step', () => ({ IdentityStep: 'IdentityStep' }));
vi.mock('./notifications-step', () => ({ NotificationsStep: 'NotificationsStep' }));
vi.mock('@/lib/hooks/use-kiloclaw-queries', () => ({
  useKiloClawStatus: () => ({ data: undefined, isError: false }),
  useKiloClawMutations: () => mocks.mutations,
  useKiloClawMobileOnboardingState: mocks.onboarding,
  useKiloClawGatewayReady: () => ({ data: undefined, isError: false }),
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ foreground: '#000000', mutedForeground: '#666666' }),
}));
vi.mock('@/lib/trpc', () => ({ useTRPC: () => ({ kiloclaw: {} }) }));
vi.mock('@/lib/config', () => ({ WEB_BASE_URL: 'https://example.test' }));
vi.mock('@/lib/external-link', () => ({ openExternalUrl: vi.fn() }));
vi.mock('@/lib/appsflyer', () => ({ trackEvent: vi.fn() }));

const mounted: Awaited<ReturnType<typeof renderWithProviders>>[] = [];
async function mount(ui: ReactElement) {
  const result = await renderWithProviders(ui);
  mounted.push(result);
  return result.renderer.root;
}

function press(node: { props: unknown }) {
  (node.props as { onPress: () => void }).onPress();
}

function buttonLabel(button: { findByType(type: ElementType): { children: unknown[] } }) {
  return button
    .findByType('Text' as ElementType)
    .children.filter((child): child is string => typeof child === 'string')
    .join('');
}

beforeEach(() => {
  vi.clearAllMocks();
  Platform.OS = 'android';
  mocks.onboarding.mockReturnValue({
    data: undefined,
    isError: true,
    isPending: false,
    refetch: mocks.retry,
  });
});

afterEach(() => {
  for (const result of mounted.splice(0)) {
    result.unmount();
  }
  vi.useRealTimers();
});

describe('KiloClaw onboarding full-body states', () => {
  it('shows the initial onboarding error instead of an indefinite skeleton', async () => {
    const root = await mount(createElement(OnboardingFlow));
    expect(root.findAllByType(CenteredState)).toHaveLength(1);
    press(root.findByType('Button' as ElementType));
    expect(mocks.retry).toHaveBeenCalledOnce();
  });

  it.each(['pending_settlement', 'signup_unavailable'] as const)(
    'centers %s in the tab and onboarding without nesting states',
    async state => {
      mocks.onboarding.mockReturnValue({
        data: { state, instanceId: null },
        isError: false,
        isPending: false,
      });
      const onboarding = await mount(createElement(OnboardingFlow));
      expect(onboarding.findAllByType(CenteredState)).toHaveLength(1);
      const tab = await mount(
        createElement(EmptyStateContent, {
          state: { state, instanceId: null },
          foregroundColor: '#000000',
          onCreate: mocks.retry,
        })
      );
      expect(tab.findAllByType(CenteredState)).toHaveLength(1);
    }
  );

  it.each<AccessRequiredSubcase>([
    'trial_expired',
    'subscription_canceled',
    'subscription_past_due',
    'quarantined',
    'multiple_current_conflict',
    'non_canonical_earlybird',
  ])('centers access state %s and preserves the iOS action restriction', async subcase => {
    const android = await mount(createElement(AccessRequiredScreen, { subcase }));
    expect(android.findAllByType(CenteredState)).toHaveLength(1);
    expect(android.findAllByType('Button' as ElementType)).toHaveLength(1);
    Platform.OS = 'ios';
    const ios = await mount(createElement(AccessRequiredScreen, { subcase }));
    expect(ios.findAllByType(CenteredState)).toHaveLength(1);
    expect(ios.findAllByType('Button' as ElementType)).toHaveLength(0);
  });

  it('gives quarantined its own support label and opens the support inbox, not the site', async () => {
    const root = await mount(createElement(AccessRequiredScreen, { subcase: 'quarantined' }));
    const button = root.findByType('Button' as ElementType);
    expect(buttonLabel(button)).toBe('kiloclaw.accessRequired.quarantinedCta');
    press(button);
    expect(openExternalUrl).toHaveBeenCalledWith(`mailto:${SUPPORT_EMAIL}`, {
      label: SUPPORT_EMAIL,
    });
  });

  it('gives non_canonical_earlybird its own review label instead of sharing the conflict CTA', async () => {
    const earlybird = await mount(
      createElement(AccessRequiredScreen, { subcase: 'non_canonical_earlybird' })
    );
    expect(buttonLabel(earlybird.findByType('Button' as ElementType))).toBe(
      'kiloclaw.accessRequired.nonCanonicalEarlybirdCta'
    );

    const conflict = await mount(
      createElement(AccessRequiredScreen, { subcase: 'multiple_current_conflict' })
    );
    expect(buttonLabel(conflict.findByType('Button' as ElementType))).toBe(
      'kiloclaw.accessRequired.multipleCurrentConflictCta'
    );
  });

  it.each(['access_conflict', 'generic'] as const)(
    'centers the %s onboarding terminal',
    async errorCategory => {
      const root = await mount(
        createElement(FlowBody, {
          state: { ...INITIAL_STATE, errorCategory },
          onIdentityContinue: mocks.retry,
          onNotificationsComplete: mocks.retry,
          onProvisioningComplete: mocks.retry,
          onRetry: mocks.retry,
          onGraceElapsed: mocks.retry,
          onContinueInBackground: mocks.background,
          onOpenInstance: mocks.retry,
        })
      );
      expect(root.findAllByType(CenteredState)).toHaveLength(1);
    }
  );

  it.each([{ queryErrored: true }, { instanceStatus: 'stopped' }, { gateway502Expired: true }])(
    'centers provisioning failures and preserves both actions',
    async state => {
      const root = await mount(
        createElement(ProvisioningStep, {
          state: { ...INITIAL_STATE, ...state },
          onComplete: mocks.retry,
          onGraceElapsed: mocks.retry,
          onRetry: mocks.retry,
          onContinueInBackground: mocks.background,
        })
      );
      expect(root.findAllByType(CenteredState)).toHaveLength(1);
      const [retry, background] = root.findAllByType('Button' as ElementType);
      if (!retry || !background) {
        throw new Error('Expected retry and background buttons');
      }
      press(retry);
      press(background);
      expect(mocks.retry).toHaveBeenCalledOnce();
      expect(mocks.background).toHaveBeenCalledOnce();
    }
  );

  it('centers provisioning waits and timeout actions', async () => {
    vi.useFakeTimers();
    const root = await mount(
      createElement(ProvisioningStep, {
        state: INITIAL_STATE,
        onComplete: mocks.retry,
        onGraceElapsed: mocks.retry,
        onRetry: mocks.retry,
        onContinueInBackground: mocks.background,
      })
    );
    expect(root.findAllByType(CenteredState)).toHaveLength(1);
    expect(root.findAllByType('Button' as ElementType)).toHaveLength(0);
    act(() => {
      vi.advanceTimersByTime(150_000);
    });
    expect(root.findAllByType(CenteredState)).toHaveLength(1);
    expect(root.findAllByType('Button' as ElementType)).toHaveLength(2);
  });

  it('preserves the successful completion layout and action through the flow body', async () => {
    const root = await mount(
      createElement(FlowBody, {
        state: { ...INITIAL_STATE, step: 'done', provisionSuccess: true },
        onIdentityContinue: mocks.retry,
        onNotificationsComplete: mocks.retry,
        onProvisioningComplete: mocks.retry,
        onRetry: mocks.retry,
        onGraceElapsed: mocks.retry,
        onContinueInBackground: mocks.background,
        onOpenInstance: mocks.retry,
      })
    );
    expect(root.findAllByType(CenteredState)).toHaveLength(0);
    expect(root.findByType(CompleteStep).parent?.props.className).toBe('flex-1');
    press(root.findByType('Button' as ElementType));
    expect(mocks.retry).toHaveBeenCalledOnce();
  });
});
