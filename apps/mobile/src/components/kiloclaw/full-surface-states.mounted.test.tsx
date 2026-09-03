import type * as ReactQuery from '@tanstack/react-query';
import {
  act,
  type ComponentProps,
  createElement,
  type ElementType,
  type ReactElement,
} from 'react';
import { ScrollView } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import BillingScreen from '@/app/(app)/kiloclaw/[instance-id]/billing';
import ChannelsScreen from '@/app/(app)/kiloclaw/[instance-id]/settings/channels';
import GoogleScreen from '@/app/(app)/kiloclaw/[instance-id]/settings/google';
import ModelListScreen from '@/app/(app)/kiloclaw/[instance-id]/settings/model-list';
import SecretsScreen from '@/app/(app)/kiloclaw/[instance-id]/settings/secrets';
import InstancePickerScreen from '@/app/(app)/(tabs)/(1_kiloclaw)/chat/instance-picker';
import { CenteredState } from '@/components/centered-state';
import { EmptyState } from '@/components/empty-state';
import { QueryError } from '@/components/query-error';
import { renderWithProviders } from '@/test/render-with-providers';
import { InstanceContextBoundary } from './instance-context-boundary';

const mocks = vi.hoisted(() => ({
  context: vi.fn(),
  billing: vi.fn(),
  catalog: vi.fn(),
  status: vi.fn(),
  setup: vi.fn(),
  config: vi.fn(),
  models: vi.fn(),
  instances: vi.fn(),
  copy: vi.fn(),
  refetch: vi.fn<() => void>(),
  replace: vi.fn(),
  push: vi.fn(),
  openURL: vi.fn(),
  mutations: {
    updateModel: { isPending: false, mutate: vi.fn() },
    restartMachine: { isPending: false, mutate: vi.fn() },
    setGmailNotifications: { isPending: false, mutate: vi.fn() },
    disconnectGoogle: { isPending: false, mutate: vi.fn() },
  },
}));

vi.mock('react-native', () => ({
  View: 'View',
  ScrollView: 'ScrollView',
  FlatList: 'FlatList',
  TextInput: 'TextInput',
  Pressable: 'Pressable',
  ActivityIndicator: 'ActivityIndicator',
  Alert: { alert: vi.fn() },
  Platform: { OS: 'android' },
  Linking: { openURL: mocks.openURL },
}));
vi.mock('react-native-reanimated', () => ({
  default: { View: 'AnimatedView' },
  FadeIn: { duration: vi.fn() },
  FadeOut: { duration: vi.fn() },
  LinearTransition: {},
}));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/i18n', () => ({ i18n: { t: (key: string) => key, language: 'en' } }));
vi.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ 'instance-id': 'instance-1', currentId: 'instance-1' }),
  useRouter: () => ({
    replace: mocks.replace,
    push: mocks.push,
    back: vi.fn(),
    dismissAll: vi.fn(),
  }),
}));
vi.mock('expo-haptics', () => ({ selectionAsync: vi.fn() }));
vi.mock('expo-clipboard', () => ({ setStringAsync: mocks.copy }));
vi.mock('sonner-native', () => ({ toast: { error: vi.fn() } }));
vi.mock('@tanstack/react-query', async importOriginal => ({
  ...(await importOriginal<typeof ReactQuery>()),
  useQuery: mocks.models,
}));
vi.mock('@/components/centered-state', () => ({
  CenteredState: ({ children, refreshControl }: ComponentProps<typeof CenteredState>) =>
    createElement(ScrollView, { refreshControl }, children),
}));
vi.mock('@/components/detail-screen', () => ({ DetailScreenScrollView: 'DetailScreenScrollView' }));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
vi.mock('@/components/sheet-header', () => ({ SheetHeader: 'SheetHeader' }));
vi.mock('@/components/ui/icons', () => ({
  AlertCircle: 'AlertCircle',
  ExternalLink: 'ExternalLink',
  Lock: 'Lock',
  SearchX: 'SearchX',
  ServerCrash: 'ServerCrash',
  WifiOff: 'WifiOff',
  CreditCard: 'CreditCard',
  Check: 'Check',
  Eye: 'Eye',
  Search: 'Search',
  RefreshCw: 'RefreshCw',
  Unplug: 'Unplug',
  MessageSquare: 'MessageSquare',
  KeyRound: 'KeyRound',
  Server: 'Server',
}));
vi.mock('@/components/icons', () => ({ GoogleIcon: 'GoogleIcon', GmailIcon: 'GmailIcon' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/accessible-status', () => ({ AccessibleStatus: 'AccessibleStatus' }));
vi.mock('@/components/kiloclaw/settings-card', () => ({ SettingsCard: 'SettingsCard' }));
vi.mock('@/components/kiloclaw/status-badge', () => ({ StatusBadge: 'StatusBadge' }));
vi.mock('@/lib/hooks/use-instance-context', () => ({
  useInstanceContext: mocks.context,
  instanceOrgId: () => null,
  useAllKiloClawInstances: mocks.instances,
}));
vi.mock('@/lib/hooks/use-kiloclaw-queries', () => ({
  useKiloClawBillingStatus: mocks.billing,
  useKiloClawChannelCatalog: mocks.catalog,
  useKiloClawSecretCatalog: mocks.catalog,
  useKiloClawStatus: mocks.status,
  useKiloClawGoogleSetup: mocks.setup,
  useKiloClawConfig: mocks.config,
  useKiloClawMutations: () => mocks.mutations,
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ foreground: '#000000', mutedForeground: '#666666' }),
}));
vi.mock('@/lib/hooks/use-language-preference', () => ({ getResolvedLanguage: () => 'en' }));
vi.mock('@/lib/screen-insets', () => ({ useDetailScreenBottomPadding: () => 0 }));
vi.mock('@/lib/trpc', () => ({ useTRPC: () => ({ models: { list: { queryOptions: vi.fn() } } }) }));
vi.mock('@/lib/config', () => ({ WEB_BASE_URL: 'https://example.test' }));
vi.mock('@/lib/analytics/posthog', () => ({
  captureEvent: vi.fn(),
  INSTANCE_ACTION_EVENT: 'action',
}));

const mounted: Awaited<ReturnType<typeof renderWithProviders>>[] = [];
async function mount(ui: ReactElement) {
  const result = await renderWithProviders(ui);
  mounted.push(result);
  return result.renderer.root;
}

function press(node: { props: unknown }) {
  (node.props as { onPress: () => void }).onPress();
}

function query(data: unknown, isError = false) {
  return {
    data,
    isError,
    isPending: false,
    isLoading: false,
    isSuccess: !isError,
    refetch: mocks.refetch,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.context.mockReturnValue({ status: 'ready', isOrg: false });
  mocks.billing.mockReturnValue(query({ subscription: null, trial: null, earlybird: null }));
  mocks.catalog.mockReturnValue(query([]));
  mocks.status.mockReturnValue(query({ googleConnected: false }));
  mocks.setup.mockReturnValue(query({ command: 'connect-google' }));
  mocks.config.mockReturnValue(query({}));
  mocks.models.mockReturnValue(query([]));
  mocks.instances.mockReturnValue(query([]));
});

afterEach(() => {
  for (const result of mounted.splice(0)) {
    result.unmount();
  }
  vi.useRealTimers();
});

describe('KiloClaw full-body states', () => {
  it('centers no-plan billing with its manage action outside the loaded scroller', async () => {
    const root = await mount(createElement(BillingScreen));
    expect(root.findAllByType(CenteredState)).toHaveLength(1);
    expect(root.findAllByType('DetailScreenScrollView' as ElementType)).toHaveLength(0);
    expect(root.findByType(EmptyState).props.title).toBe('kiloclaw.billing.noActivePlan');
    press(root.findByType('Button' as ElementType));
    expect(mocks.openURL).toHaveBeenCalledWith('https://example.test/claw');
  });

  it.each([
    { trial: { expired: false, daysRemaining: 2, endsAt: '2026-09-03T00:00:00Z' } },
    { earlybird: { daysRemaining: 0, expiresAt: '2026-09-01T00:00:00Z' } },
  ])('keeps existing billing details in the loaded scroller', async billing => {
    mocks.billing.mockReturnValue(query(billing));
    const root = await mount(createElement(BillingScreen));
    expect(root.findAllByType(CenteredState)).toHaveLength(0);
    expect(root.findAllByType('DetailScreenScrollView' as ElementType)).toHaveLength(1);
  });

  it('treats an expired trial without another plan as empty billing', async () => {
    mocks.billing.mockReturnValue(query({ trial: { expired: true } }));
    const root = await mount(createElement(BillingScreen));
    expect(root.findByType(EmptyState).props.title).toBe('kiloclaw.billing.noActivePlan');
  });

  it('keeps organization billing read-only', async () => {
    mocks.context.mockReturnValue({ status: 'ready', isOrg: true });
    const root = await mount(createElement(BillingScreen));
    expect(root.findAllByType(CenteredState)).toHaveLength(1);
    expect(root.findAllByType('Button' as ElementType)).toHaveLength(0);
  });

  it('centers disconnected Google setup and preserves copying the command', async () => {
    vi.useFakeTimers();
    const root = await mount(createElement(GoogleScreen));
    expect(root.findAllByType(CenteredState)).toHaveLength(1);
    expect(root.findAllByType('DetailScreenScrollView' as ElementType)).toHaveLength(0);
    await act(async () => {
      press(root.findByType('Button' as ElementType));
      await Promise.resolve();
    });
    expect(mocks.copy).toHaveBeenCalledWith('connect-google');
  });

  it('keeps command failures inside the centered Google setup', async () => {
    mocks.setup.mockReturnValue(query(undefined, true));
    const root = await mount(createElement(GoogleScreen));
    expect(root.findAllByType(CenteredState)).toHaveLength(1);
    const [retry, copy] = root.findAllByType('Button' as ElementType);
    if (!retry || !copy) {
      throw new Error('Expected retry and copy buttons');
    }
    press(retry);
    expect(mocks.refetch).toHaveBeenCalledOnce();
    expect(copy.props.disabled).toBe(true);
  });

  it('preserves connected Google spacing and settings actions in one scroller', async () => {
    mocks.status.mockReturnValue(query({ googleConnected: true }));
    const root = await mount(createElement(GoogleScreen));
    expect(root.findAllByType(CenteredState)).toHaveLength(0);
    const scroller = root.findByType('DetailScreenScrollView' as ElementType);
    expect(scroller.props.contentContainerClassName).toBe('px-4 pt-4 gap-4');
    press(scroller.findByProps({ size: 'sm' }));
    expect(mocks.mutations.setGmailNotifications.mutate).toHaveBeenCalledWith({ enabled: true });
  });

  it.each([ChannelsScreen, SecretsScreen, ModelListScreen, InstancePickerScreen])(
    'renders an empty body outside the list and picker scrollers for %s',
    async Screen => {
      const root = await mount(createElement(Screen));
      expect(root.findAllByType(CenteredState)).toHaveLength(1);
      expect(root.findAllByType('FlatList' as ElementType)).toHaveLength(0);
      expect(root.findAllByType(ScrollView)).toHaveLength(1);
    }
  );

  it('keeps model search visible and clears an empty search without nesting the state', async () => {
    mocks.models.mockReturnValue(query([{ id: 'model-1', name: 'Model one', isPreferred: false }]));
    const root = await mount(createElement(ModelListScreen));
    const search = root.findByType('TextInput' as ElementType).props as {
      onChangeText: (text: string) => void;
    };
    act(() => {
      search.onChangeText('missing');
    });
    expect(root.findAllByType('FlatList' as ElementType)).toHaveLength(0);
    expect(root.findAllByType(CenteredState)).toHaveLength(1);
    expect(root.findByType(EmptyState).props.title).toBe('kiloclaw.modelList.noMatches');
    act(() => {
      press(root.findByType('Button' as ElementType));
    });
    expect(root.findAllByType(CenteredState)).toHaveLength(0);
    expect(root.findAllByType('FlatList' as ElementType)).toHaveLength(1);
  });

  it('keeps one picker scroller and preserves setup and retry actions', async () => {
    const empty = await mount(createElement(InstancePickerScreen));
    expect(empty.findAllByType(ScrollView)).toHaveLength(1);
    press(empty.findByType('Button' as ElementType));
    expect(mocks.push).toHaveBeenCalledWith('/(app)/onboarding');
    mocks.instances.mockReturnValue(query(undefined, true));
    const error = await mount(createElement(InstancePickerScreen));
    expect(error.findAllByType(CenteredState)).toHaveLength(1);
    expect(error.findAllByType(ScrollView)).toHaveLength(1);
    press(error.findByType('Button' as ElementType));
    expect(mocks.refetch).toHaveBeenCalledOnce();
  });

  it('preserves the instance-boundary retry and missing-instance action', async () => {
    const error = await mount(
      createElement(InstanceContextBoundary, {
        title: 'Instance',
        context: { status: 'error', refetch: mocks.refetch },
      })
    );
    expect(error.findAllByType(CenteredState)).toHaveLength(1);
    expect(error.findAllByType(QueryError)).toHaveLength(1);
    press(error.findByType('Button' as ElementType));
    expect(mocks.refetch).toHaveBeenCalledOnce();
    const missing = await mount(
      createElement(InstanceContextBoundary, {
        title: 'Instance',
        context: { status: 'not_found' },
      })
    );
    expect(missing.findAllByType(CenteredState)).toHaveLength(1);
    press(missing.findByType('Button' as ElementType));
    expect(mocks.replace).toHaveBeenCalledWith('/(app)/(tabs)/(1_kiloclaw)');
  });
});
