import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => {
  const client = {
    register: vi.fn(),
    setPersonPropertiesForFlags: vi.fn(),
    onFeatureFlags: vi.fn(),
  };
  const holder: { options?: Record<string, unknown> } = {};
  const device: { deviceType: number | null } = { deviceType: null };
  return { client, holder, device };
});

vi.mock('posthog-react-native', () => ({
  // Must be a `function`, not an arrow: arrows are not constructible and
  // `new PostHog(...)` throws "not a constructor". A `function` returning an
  // object makes `new` yield that object.
  default: vi.fn(function PostHogMock(_key: string, options: Record<string, unknown>) {
    hoisted.holder.options = options;
    return hoisted.client;
  }),
}));

vi.mock('expo-device', () => ({
  DeviceType: { UNKNOWN: 0, PHONE: 1, TABLET: 2, DESKTOP: 3, TV: 4 },
  // Getter: reads the holder at access time, so per-test values take effect.
  get deviceType() {
    return hoisted.device.deviceType;
  },
}));

// Required: the real expo-application import pulls in react-native, which
// pure vitest cannot load.
vi.mock('expo-application', () => ({
  nativeApplicationVersion: '1.2.3',
  nativeBuildVersion: '45',
}));

vi.mock('@/lib/config', () => ({ POSTHOG_API_KEY: 'test-key' }));

vi.stubGlobal('__DEV__', false);

type CustomAppProperties = (properties: Record<string, unknown>) => Record<string, unknown>;

function readCustomAppProperties(): CustomAppProperties {
  const customAppProperties = hoisted.holder.options?.customAppProperties;
  expect(customAppProperties).toEqual(expect.any(Function));
  return customAppProperties as CustomAppProperties;
}

async function loadInitPostHog() {
  vi.resetModules();
  const module = await import('./posthog');
  return module.initPostHog;
}

describe('initPostHog device_form_factor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.holder.options = undefined;
    hoisted.device.deviceType = null;
  });

  it.each([
    { deviceType: 1, expected: 'phone' },
    { deviceType: 2, expected: 'tablet' },
    { deviceType: 3, expected: 'desktop' },
    { deviceType: 4, expected: 'tv' },
    { deviceType: 0, expected: 'unknown' },
    { deviceType: null, expected: 'unknown' },
  ] as const)(
    'maps deviceType $deviceType to device_form_factor $expected',
    async ({ deviceType, expected }) => {
      hoisted.device.deviceType = deviceType;
      const initPostHog = await loadInitPostHog();
      initPostHog();

      const customAppProperties = readCustomAppProperties();
      expect(customAppProperties({ $device_type: 'Mobile' })).toEqual({
        $device_type: 'Mobile',
        device_form_factor: expected,
      });
    }
  );

  it('registers platform: mobile once', async () => {
    hoisted.device.deviceType = 1;
    const initPostHog = await loadInitPostHog();
    initPostHog();

    expect(hoisted.client.register).toHaveBeenCalledTimes(1);
    expect(hoisted.client.register).toHaveBeenCalledWith({ platform: 'mobile' });
  });

  it('constructs PostHog only once when init is called twice', async () => {
    hoisted.device.deviceType = 1;
    const initPostHog = await loadInitPostHog();
    const posthogModule = await import('posthog-react-native');
    const PostHog = posthogModule.default;

    initPostHog();
    initPostHog();

    expect(PostHog).toHaveBeenCalledTimes(1);
  });
});
