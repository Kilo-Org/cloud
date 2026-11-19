import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  BackendInputError,
  BackendRequestError,
  type ChatBackendDraft,
  type StoredChatBackend,
} from '@/lib/chat/backend-store';
import { act, TestRenderer } from '@/test/renderer';

import { BackendForm } from './backend-form';

const requests = vi.hoisted(() => ({
  check: vi.fn().mockResolvedValue(undefined),
  discover: vi.fn().mockResolvedValue([]),
}));
const alerts = vi.hoisted(() => ({ alert: vi.fn() }));

vi.mock('react-native', () => ({
  View: 'View',
  Pressable: 'Pressable',
  Alert: alerts,
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/i18n', () => ({ i18n: { t: (key: string) => key } }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/choice-row', () => ({ ChoiceRow: 'ChoiceRow' }));
vi.mock('@/components/ui/form-field', () => ({ FormField: 'FormField' }));
vi.mock('@/components/ui/icons', () => ({ Eye: 'Eye', EyeOff: 'EyeOff' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#888' }),
}));
vi.mock('@/lib/auth/auth-epoch', () => ({
  currentAuthEpoch: () => 0,
  isCurrentAuthEpoch: () => true,
}));
vi.mock('@/lib/chat/backend-transport', () => ({ assertBackendTransport: vi.fn() }));
vi.mock('@/lib/chat/backend-request', () => ({
  checkBackendConnection: requests.check,
  discoverBackendModels: requests.discover,
}));
vi.mock('./backend-model-row', () => ({ BackendModelRow: 'BackendModelRow' }));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'model-row' }));
vi.mock('@sentry/react-native', () => ({ captureException: vi.fn() }));
vi.mock('sonner-native', () => ({ toast: { error: vi.fn() } }));
vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn().mockResolvedValue(null),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));

const backend: StoredChatBackend = {
  id: 'custom',
  revision: 1,
  name: 'Custom',
  baseUrl: 'https://models.example/v1',
  apiKind: 'chat_completions',
  apiKey: '',
  headers: { Authorization: 'Bearer stored-secret', 'X-API-Key': 'stored-api-key' },
  models: [{ id: 'model', name: 'Model', tools: false, images: false, reasoning: false }],
  allowLocalHttp: false,
};

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;
const save = vi.fn<(draft: ChatBackendDraft) => void>();

async function mount() {
  await act(async () => {
    renderer = TestRenderer.create(createElement(BackendForm, { backend, onSave: save }));
    await Promise.resolve();
  });
}

function root() {
  if (!renderer) {
    throw new Error('not mounted');
  }
  return renderer.root;
}

function callHandler(handler: unknown, ...args: unknown[]): void {
  if (!isHandler(handler)) {
    throw new TypeError('Expected an event handler');
  }
  handler(...args);
}

function isHandler(value: unknown): value is (...args: unknown[]) => unknown {
  return typeof value === 'function';
}

function headersField() {
  return root().findAll(
    node => String(node.type) === 'FormField' && node.props.label === 'profiles.mcp.headers'
  );
}

async function toggleHeaders() {
  await act(async () => {
    callHandler(root().find(node => String(node.type) === 'Pressable').props.onPress);
    await Promise.resolve();
  });
}

/** The reveal control's accessible and visible copy: the key the shared toggle resolves. */
function revealLabel() {
  return root().find(
    node =>
      String(node.type) === 'Pressable' &&
      /^profiles\.secrets\.(reveal|hide)$/.test(String(node.props.accessibilityLabel))
  ).props.accessibilityLabel;
}

async function pressSave() {
  await act(async () => {
    callHandler(
      root().find(
        node =>
          String(node.type) === 'Button' &&
          node.findAll(child => child.children.includes('common.save')).length > 0
      ).props.onPress
    );
    await Promise.resolve();
  });
}

async function checkModel() {
  await act(async () => {
    callHandler(root().find(node => String(node.type) === 'BackendModelRow').props.onCheck);
    await Promise.resolve();
  });
}

async function pressDiscover() {
  await act(async () => {
    callHandler(
      root().find(
        node =>
          String(node.type) === 'Button' &&
          node.findAll(child => child.children.includes('modelChat.backends.discover')).length > 0
      ).props.onPress
    );
    await Promise.resolve();
  });
}

/** The status line's copy, or null while the form shows no status. */
function statusLine(): string | null {
  const line = root().findAll(
    node => String(node.type) === 'Text' && node.props.accessibilityRole === 'alert'
  )[0];
  if (!line) {
    return null;
  }
  return line.children.filter((child): child is string => typeof child === 'string').join('');
}

/** Let a settled request's continuations run inside the renderer's act scope. */
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

afterEach(() => {
  renderer?.unmount();
  renderer = undefined;
  vi.clearAllMocks();
});

describe('backend header credentials', () => {
  it('never mounts stored header values before explicit reveal, but retains them for save and check', async () => {
    await mount();
    expect(headersField()).toHaveLength(0);
    expect(JSON.stringify(renderer?.toJSON())).not.toContain('stored-secret');
    expect(JSON.stringify(renderer?.toJSON())).not.toContain('stored-api-key');

    await checkModel();
    expect(requests.check.mock.calls[0]?.[0]).toMatchObject({ headers: backend.headers });
    await pressSave();
    expect(save.mock.calls[0]?.[0]).toMatchObject({ headers: backend.headers });
  });

  it('reveals editable multiline JSON only on request and retains edits after hiding', async () => {
    await mount();
    expect(revealLabel()).toBe('profiles.secrets.reveal');
    await toggleHeaders();
    // The same control now names the action it performs: hiding what it shows.
    expect(revealLabel()).toBe('profiles.secrets.hide');
    expect(headersField()[0]?.props).toMatchObject({
      defaultValue: JSON.stringify(backend.headers, null, 2),
      multiline: true,
    });
    expect(headersField()[0]?.props.secureTextEntry).toBeUndefined();
    const edited = { Authorization: 'Bearer edited-secret', 'X-API-Key': 'edited-api-key' };
    await act(async () => {
      callHandler(headersField()[0]?.props.onChangeText, JSON.stringify(edited, null, 2));
      await Promise.resolve();
    });
    await toggleHeaders();
    expect(headersField()).toHaveLength(0);
    expect(revealLabel()).toBe('profiles.secrets.reveal');
    expect(JSON.stringify(renderer?.toJSON())).not.toContain('edited-secret');
    await checkModel();
    expect(requests.check.mock.calls[0]?.[0]).toMatchObject({ headers: edited });
    await pressSave();
    expect(save.mock.calls[0]?.[0]).toMatchObject({ headers: edited });
    await toggleHeaders();
    expect(headersField()[0]?.props.defaultValue).toBe(JSON.stringify(edited, null, 2));
  });
});

describe('backend request failures', () => {
  it('reports an unauthorized discovery with the request problem copy', async () => {
    requests.discover.mockRejectedValueOnce(new BackendRequestError('unauthorized'));
    await mount();
    await pressDiscover();
    await flush();
    expect(statusLine()).toBe('modelChat.backends.requestUnauthorized');
  });

  it('reports a timed-out connection check with the request problem copy', async () => {
    requests.check.mockRejectedValueOnce(new BackendRequestError('timedOut'));
    await mount();
    await checkModel();
    await flush();
    expect(statusLine()).toBe('modelChat.backends.requestTimedOut');
  });

  it('shows no status when the request reports a cancel', async () => {
    requests.discover.mockRejectedValueOnce(new BackendRequestError('cancelled'));
    await mount();
    await pressDiscover();
    await flush();
    expect(statusLine()).toBeNull();
    expect(alerts.alert).not.toHaveBeenCalled();
  });

  it('ignores an aborted attempt that a newer attempt superseded', async () => {
    const first = Promise.withResolvers<unknown>();
    requests.discover.mockReturnValueOnce(first.promise);
    await mount();
    await pressDiscover();
    await pressDiscover();
    await flush();
    expect(statusLine()).toBe('modelChat.backends.discoverySucceeded');
    await act(async () => {
      first.reject(new BackendRequestError('unreachable'));
      await Promise.resolve();
    });
    await flush();
    expect(statusLine()).toBe('modelChat.backends.discoverySucceeded');
  });

  it('keeps the local HTTP approval dialog when the request needs approval', async () => {
    requests.discover.mockRejectedValueOnce(new BackendInputError('httpApprovalRequired'));
    await mount();
    await pressDiscover();
    await flush();
    expect(alerts.alert).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(alerts.alert.mock.calls[0])).toContain('modelChat.backends.allowHttp');
    expect(statusLine()).toBeNull();
  });
});
