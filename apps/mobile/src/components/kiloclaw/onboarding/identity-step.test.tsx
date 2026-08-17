import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { IdentityStep } from './identity-step';

const locationMocks = vi.hoisted(() => ({
  requestForegroundPermissionsAsync: vi.fn<() => Promise<{ status: string }>>(),
  getCurrentPositionAsync: vi.fn<() => Promise<unknown>>(),
}));

const mutationMocks = vi.hoisted(() => ({
  mutateAsync: vi.fn<() => Promise<unknown>>(),
  mutate: vi.fn(),
}));

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof React>('react');
  return {
    ...actual,
    useState: vi.fn(
      <T,>(initial: T) => [initial, vi.fn() as () => void] as [T, (value: T) => void]
    ),
    useMemo: vi.fn(<T,>(factory: () => T) => factory()),
    useRef: vi.fn(<T,>(initial: T) => {
      const ref: React.RefObject<T> = { current: initial };
      return ref;
    }),
    useCallback: vi.fn(<T extends (...args: never[]) => unknown>(fn: T) => fn),
  };
});

vi.mock('@sentry/react-native', () => ({ captureException: vi.fn() }));

vi.mock('expo-location', () => ({
  requestForegroundPermissionsAsync: locationMocks.requestForegroundPermissionsAsync,
  getCurrentPositionAsync: locationMocks.getCurrentPositionAsync,
  PermissionStatus: { GRANTED: 'granted' },
  Accuracy: { Lowest: 1 },
}));

vi.mock('@tanstack/react-query', () => ({
  useMutation: () => ({
    mutateAsync: mutationMocks.mutateAsync,
    mutate: mutationMocks.mutate,
    isPending: false,
  }),
}));

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Alert: { alert: vi.fn() },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  TextInput: 'TextInput',
  View: 'View',
}));

vi.mock('react-native-reanimated', () => ({
  default: { View: 'Animated.View' },
  LinearTransition: 'LinearTransition',
}));

vi.mock('@/components/ui/icons', () => ({
  ChevronDown: () => null,
  ChevronRight: () => null,
  ChevronUp: () => null,
  MapPin: () => null,
}));

vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/kiloclaw/bot-avatar', () => ({ BotAvatar: () => null }));
vi.mock('@/components/kiloclaw/bot-avatar-options', () => ({ botAvatarName: () => 'bot' }));

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    kiloclaw: { validateWeatherLocation: { mutationOptions: () => ({}) } },
  }),
}));

vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    foreground: '#000000',
    mutedForeground: '#666666',
    primaryForeground: '#ffffff',
  }),
}));

type Node = { props?: Record<string, unknown> } | null | undefined | string | number | boolean;

function findByAccessibilityLabel(node: Node, label: string): Record<string, unknown> | null {
  if (node === null || typeof node !== 'object') {
    return null;
  }
  const props = node.props ?? {};
  if (props.accessibilityLabel === label) {
    return props;
  }
  const children = props.children;
  for (const child of Array.isArray(children) ? children : [children]) {
    const found = findByAccessibilityLabel(child as Node, label);
    if (found) {
      return found;
    }
  }
  return null;
}

function pressGpsButton() {
  // eslint-disable-next-line new-cap -- called as a plain function, matching pr-review-screen.test.tsx
  const element = IdentityStep({ onContinue: vi.fn<() => void>() }) as Node;
  const props = findByAccessibilityLabel(element, 'Use current location');
  if (!props) {
    throw new Error('GPS button not found in the rendered tree');
  }
  (props.onPress as () => void)();
}

describe('IdentityStep GPS error reporting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    locationMocks.requestForegroundPermissionsAsync.mockResolvedValue({ status: 'granted' });
  });

  it('reports a weather-location validation failure to Sentry', async () => {
    const Sentry = await import('@sentry/react-native');
    const validateError = new Error('weather backend down');
    locationMocks.getCurrentPositionAsync.mockResolvedValue({
      coords: { latitude: 52.37, longitude: 4.9 },
    });
    mutationMocks.mutateAsync.mockRejectedValue(validateError);

    pressGpsButton();

    await vi.waitFor(() => {
      expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    });
    expect(vi.mocked(Sentry.captureException).mock.calls[0]?.[0]).toBe(validateError);
  });

  it.each(['timeout', 'Location request failed due to unsatisfied device settings'])(
    'does not report an expected location failure (%s) to Sentry',
    async message => {
      const Sentry = await import('@sentry/react-native');
      locationMocks.getCurrentPositionAsync.mockRejectedValue(new Error(message));

      pressGpsButton();

      await vi.waitFor(() => {
        expect(locationMocks.getCurrentPositionAsync).toHaveBeenCalledTimes(1);
      });
      await new Promise(resolve => {
        setTimeout(resolve, 0);
      });

      expect(Sentry.captureException).not.toHaveBeenCalled();
      expect(mutationMocks.mutateAsync).not.toHaveBeenCalled();
    }
  );
});
