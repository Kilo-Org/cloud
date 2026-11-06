import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as Config from '@/lib/config';

// config.ts evaluates its values at import: it needs the baked extra, and the
// URL contract runs over the required keys. The mock reads `state.extra` when
// config.ts loads, so each case sets it before the dynamic import.
const state = vi.hoisted(() => ({ extra: undefined as Record<string, unknown> | undefined }));

vi.mock('expo-constants', () => ({
  default: {
    get expoConfig() {
      return { extra: state.extra };
    },
  },
}));

const REQUIRED_EXTRA = {
  apiBaseUrl: 'https://api.kilo.ai',
  webBaseUrl: 'https://app.kilo.ai',
  cloudAgentWsUrl: 'wss://cloud-agent-next.kilosessions.ai',
  sessionIngestWsUrl: 'wss://ingest.kilosessions.ai',
  appsFlyerDevKey: 'apps-flyer-dev-key',
  appsFlyerAppId: 'apps-flyer-app-id',
  kiloChatUrl: 'https://chat.kiloapps.io',
  eventServiceUrl: 'https://events.kiloapps.io',
  notificationsUrl: 'https://notifications.kiloapps.io',
  posthogApiKey: 'posthog-key',
};

const PRODUCTION_MCP_URL = 'https://mcp.kiloapps.io';

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal('__DEV__', false);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

// vitest.setup.ts stubs '@/lib/config' for every pure suite, so a plain import
// returns the stub. importActual loads the real module over the mocked extra.
async function mcpUrl(): Promise<string | undefined> {
  const config = await vi.importActual<typeof Config>('@/lib/config');
  return config.KILO_MCP_URL;
}

describe('KILO_MCP_URL', () => {
  it('resolves the public Kilo MCP server in a production build with no override', async () => {
    state.extra = { ...REQUIRED_EXTRA, isProductionBuild: true };
    await expect(mcpUrl()).resolves.toBe(PRODUCTION_MCP_URL);
  });

  it('stays undefined outside a production build with no override', async () => {
    state.extra = { ...REQUIRED_EXTRA, isProductionBuild: false };
    await expect(mcpUrl()).resolves.toBeUndefined();
  });

  it('uses KILO_MCP_URL when the build supplies one', async () => {
    state.extra = {
      ...REQUIRED_EXTRA,
      isProductionBuild: true,
      kiloMcpUrl: 'http://localhost:8815',
    };
    await expect(mcpUrl()).resolves.toBe('http://localhost:8815');
  });
});

describe('SESSION_SYNC_URL', () => {
  async function syncUrl() {
    const config = await vi.importActual<typeof Config>('@/lib/config');
    return config.SESSION_SYNC_URL;
  }

  it('uses the public native relay only in production builds', async () => {
    state.extra = { ...REQUIRED_EXTRA, isProductionBuild: true };
    await expect(syncUrl()).resolves.toBe('https://session-sync.kiloapps.io');
  });

  it('requires an explicit isolated relay outside production', async () => {
    state.extra = { ...REQUIRED_EXTRA, isProductionBuild: false };
    await expect(syncUrl()).resolves.toBeUndefined();
  });

  it('accepts the local relay only in a development bundle', async () => {
    vi.stubGlobal('__DEV__', true);
    vi.stubEnv('EXPO_PUBLIC_SESSION_SYNC_URL', 'http://localhost:8817');
    state.extra = REQUIRED_EXTRA;
    await expect(syncUrl()).resolves.toBe('http://localhost:8817');
  });

  it('rejects an insecure relay in a release bundle', async () => {
    vi.stubEnv('EXPO_PUBLIC_SESSION_SYNC_URL', 'http://localhost:8817');
    state.extra = { ...REQUIRED_EXTRA, isProductionBuild: true };
    await expect(syncUrl()).rejects.toThrow('Invalid scheme');
  });

  it('rejects a production override outside the host allowlist', async () => {
    vi.stubEnv('EXPO_PUBLIC_SESSION_SYNC_URL', 'https://unowned.example.com');
    state.extra = { ...REQUIRED_EXTRA, isProductionBuild: true };
    await expect(syncUrl()).rejects.toThrow('outside the allowlist');
  });
});
