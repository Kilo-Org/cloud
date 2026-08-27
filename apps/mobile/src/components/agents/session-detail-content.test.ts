import { describe, expect, it, vi } from 'vitest';

import {
  resolveSendAttachmentKind,
  shouldRefuseSilentAttachmentDrop,
} from '@/components/agents/session-detail-send-attachment';

// Mock every RN / Expo / SDK side-effect import that `mobile-session-manager.ts`
// pulls in transitively before loading the two pure cancel helpers under test.
vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(),
}));
vi.mock('sonner-native', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));
vi.mock('@kilocode/cloud-agent-sdk', () => ({
  createSessionManager: vi.fn(),
}));
vi.mock('@/lib/auth/token-owner', () => ({
  getAuthTokenForRequest: vi.fn(() => 'test-token'),
}));
vi.mock('@/components/agents/mobile-session-transport-payload', () => ({
  normalizeTransportPayload: vi.fn((x: unknown) => x),
}));
vi.mock('@/components/agents/mobile-session-diagnostics', () => ({
  formatSafeCloudAgentFailureDiagnostic: vi.fn(),
  withCloudAgentDiagnostics: vi.fn((_op: string, _org: unknown, fn: () => unknown) => fn()),
}));
vi.mock('@/components/agents/mobile-session-page-adapter', () => ({
  fetchMobileSessionSnapshotPage: vi.fn(),
}));
vi.mock('@/lib/config', () => ({
  API_BASE_URL: 'https://api.test',
  CLOUD_AGENT_WS_URL: 'wss://ws.test',
  WEB_BASE_URL: 'https://web.test',
}));
vi.mock('@/lib/user-web-connection-lifecycle', () => ({
  createNativeUserWebConnectionLifecycleHooks: vi.fn(() => ({})),
}));
vi.mock('@/components/agents/tool-card-image-cache', () => ({
  cacheToolAttachment: vi.fn(),
  cacheToolCardImage: vi.fn(),
}));
vi.mock('@/components/agents/file-part-cache', () => ({
  cacheFilePart: vi.fn(),
}));
vi.mock('@/lib/trpc', () => ({
  trpcClient: {
    cloudAgentNext: {
      getAttachmentDownloadUrl: { mutate: vi.fn() },
      prepareSession: { mutate: vi.fn() },
      sendMessage: { mutate: vi.fn() },
      cancelQueuedMessage: { mutate: vi.fn() },
    },
    organizations: {
      cloudAgentNext: {
        prepareSession: { mutate: vi.fn() },
        sendMessage: { mutate: vi.fn() },
        cancelQueuedMessage: { mutate: vi.fn() },
      },
    },
  },
}));

const { isCancelQueuedUpgradeRequired, resolveCancelQueuedRestoreOutcome } =
  await import('@/components/agents/mobile-session-manager');

describe('resolveSendAttachmentKind', () => {
  it.each([
    { activeSessionType: 'cloud-agent' as const, supports: true, has: true, expected: 'cloud' },
    { activeSessionType: 'cloud-agent' as const, supports: false, has: true, expected: 'cloud' },
    { activeSessionType: 'remote' as const, supports: true, has: true, expected: 'remote-capable' },
    { activeSessionType: 'remote' as const, supports: false, has: true, expected: 'none' },
    { activeSessionType: 'read-only' as const, supports: true, has: true, expected: 'none' },
    { activeSessionType: null, supports: true, has: true, expected: 'none' },
    { activeSessionType: undefined, supports: true, has: true, expected: 'none' },
    { activeSessionType: 'cloud-agent' as const, supports: true, has: false, expected: 'none' },
    { activeSessionType: 'remote' as const, supports: true, has: false, expected: 'none' },
  ])(
    'returns $expected for sessionType=$activeSessionType, supports=$supports, has=$has',
    ({ activeSessionType, supports, has, expected }) => {
      expect(resolveSendAttachmentKind(activeSessionType, supports, has)).toBe(expected);
    }
  );
});

describe('shouldRefuseSilentAttachmentDrop', () => {
  it.each([
    { kind: 'none' as const, hasAttachments: true, expected: true },
    { kind: 'none' as const, hasAttachments: false, expected: false },
    { kind: 'cloud' as const, hasAttachments: true, expected: false },
    { kind: 'cloud' as const, hasAttachments: false, expected: false },
    { kind: 'remote-capable' as const, hasAttachments: true, expected: false },
    { kind: 'remote-capable' as const, hasAttachments: false, expected: false },
  ])(
    'returns $expected for kind=$kind, hasAttachments=$hasAttachments',
    ({ kind, hasAttachments, expected }) => {
      expect(shouldRefuseSilentAttachmentDrop(kind, hasAttachments)).toBe(expected);
    }
  );
});

describe('isCancelQueuedUpgradeRequired', () => {
  it('returns true for a CLI_UPGRADE_REQUIRED error', () => {
    expect(
      isCancelQueuedUpgradeRequired(
        Object.assign(new Error('old cli'), { code: 'CLI_UPGRADE_REQUIRED' })
      )
    ).toBe(true);
  });

  it('returns false for a TIMEOUT error', () => {
    expect(
      isCancelQueuedUpgradeRequired(Object.assign(new Error('timeout'), { code: 'TIMEOUT' }))
    ).toBe(false);
  });
});

describe('resolveCancelQueuedRestoreOutcome', () => {
  it("returns 'restore' when the composer has no content", () => {
    expect(resolveCancelQueuedRestoreOutcome(false)).toBe('restore');
  });

  it("returns 'keep-restore' when the composer has content", () => {
    expect(resolveCancelQueuedRestoreOutcome(true)).toBe('keep-restore');
  });
});
