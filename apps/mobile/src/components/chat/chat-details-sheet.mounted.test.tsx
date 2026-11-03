/* eslint-disable typescript-eslint/no-deprecated -- the DOM-free `test-renderer` mounts React/RN trees under vitest (see src/test/renderer.ts) */
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ChatDetailsSheet } from '@/components/chat/chat-details-sheet';
import { type McpSettings } from '@/components/chat/mcp-settings-sheet';
import { i18n } from '@/i18n';
import { type ChatRecord } from '@/lib/chat/store';
import { type SessionModelOption } from '@/lib/hooks/use-session-model-options';
import { act, type ReactTestRenderer, TestRenderer } from '@/test/renderer';

/**
 * The thinking-effort row of the chat details sheet.
 *
 * The row reports the effort the chat's session asks with, which is the value
 * the composer chip and the model picker show for a chat that has sent. It says
 * the model default only for a session that asks with none, and it is not drawn
 * at all for a target that offers no effort.
 */

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  ScrollView: 'ScrollView',
  View: 'View',
}));
vi.mock('react-native-svg', () => ({ default: 'Svg', Circle: 'Circle' }));
// The effort label's module reaches `expo-secure-store` through the auth token
// owner; the node-mounted project has no native bridge for it.
vi.mock('expo-secure-store', () => ({}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
// The factory runs before the file's imports, so the context it returns cannot
// come from a static import.
vi.mock('@/components/ui/text', async () => {
  const React = await import('react');
  return {
    Text: 'Text',
    TextClassContext: React.createContext<string | undefined>(undefined),
  };
});
vi.mock('@/components/sheet-header', () => ({ SheetHeader: 'SheetHeader' }));
vi.mock('@/components/centered-state-surface', () => ({ StateSurface: 'View' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    background: '#000',
    mutedForeground: '#999',
    hairSoft: '#333',
    primary: '#fff',
    warn: '#f90',
    destructive: '#f00',
  }),
}));
vi.mock('@/lib/chat/backend-capabilities', () => ({ useTargetSupportsImages: () => false }));
// The model and tool sections of the same sheet are their own surface; this
// suite reads the rows the sheet draws itself.
vi.mock('@/components/chat/chat-details-sections', () => ({
  backendLabel: () => 'Kilo',
  modelCostLabel: () => '-',
  ModelsSection: 'ModelsSection',
  ToolsSection: 'ToolsSection',
}));

const MODEL: SessionModelOption = {
  id: 'kilo/one',
  name: 'One',
  displayId: 'kilo/one',
  variants: ['low', 'medium', 'high'],
  isPreferred: false,
  showGatewayMetadata: true,
};

function record(effort: string | null): ChatRecord {
  return { createdAt: null, updatedAt: null, usage: {}, prompted: 0, effort };
}

/* The tools section is stubbed in this suite, so this model is never read; the
   row under test needs only the record and the model options. */
const NO_TOOLS: McpSettings = {
  view: {
    enabled: false,
    toggleable: true,
    statusKey: 'modelChat.mcp.off',
    descriptionKey: null,
    toolCount: 0,
    retry: false,
    busy: false,
    tone: 'muted',
  },
  setEnabled: () => undefined,
  retry: () => undefined,
  retrying: false,
  settingsTools: {
    titleKey: 'modelChat.mcp.settingsToolsTitle',
    subtitleKey: 'modelChat.mcp.settingsToolsSubtitle',
    statusKey: 'modelChat.mcp.settingsToolsOff',
    tone: 'muted',
  },
  settingsToolsEnabled: false,
  setSettingsToolsEnabled: () => undefined,
  servers: [],
  loaded: true,
  storedServers: [],
  setServerEnabled: () => undefined,
  retryingServerIds: [],
  retryServer: () => undefined,
  signingInServerIds: [],
  signInServer: () => undefined,
  discoverServers: () => undefined,
  addServer: async () => {
    await Promise.resolve();
    return false;
  },
  updateServer: async () => {
    await Promise.resolve();
    return false;
  },
  deleteServer: async () => {
    await Promise.resolve();
    return false;
  },
  saving: false,
};

function collectText(node: unknown): string[] {
  if (typeof node === 'string' || typeof node === 'number') {
    return [String(node)];
  }
  if (Array.isArray(node)) {
    return node.flatMap(item => collectText(item));
  }
  if (typeof node === 'object' && node !== null) {
    if ('props' in node) {
      return collectText(node.props);
    }
    if ('children' in node) {
      return collectText(node.children);
    }
  }
  return [];
}

let shown: ReactTestRenderer | undefined = undefined;

async function mount(
  effort: string | null,
  models: readonly SessionModelOption[] = [MODEL]
): Promise<string[]> {
  await act(async () => {
    await Promise.resolve();
    shown = TestRenderer.create(
      createElement(ChatDetailsSheet, {
        visible: true,
        onClose: () => undefined,
        model: MODEL.id,
        record: record(effort),
        modelOptions: models,
        backends: [],
        mcp: NO_TOOLS,
      })
    );
  });
  const rendered = shown;
  if (rendered === undefined) {
    throw new Error('the sheet did not mount');
  }
  return rendered.root
    .findAll(node => (node.type as string) === 'Text')
    .flatMap(node => collectText(node.props));
}

afterEach(async () => {
  await act(async () => {
    await Promise.resolve();
    shown?.unmount();
  });
  shown = undefined;
});

describe('the thinking effort of the chat details', () => {
  it('names the effort the session asks with', async () => {
    const texts = await mount('high');

    expect(texts).toContain(i18n.t('agentChat.modelSelector.thinkingEffort'));
    expect(texts).toContain(i18n.t('models.thinkingEffort.high'));
  });

  it('says the model default only for a session that asks with none', async () => {
    const texts = await mount(null);

    expect(texts).toContain(i18n.t('modelChat.details.effortDefault'));
    expect(texts).not.toContain(i18n.t('models.thinkingEffort.high'));
  });

  it('draws no effort row for a target that offers no effort', async () => {
    const texts = await mount('high', [{ ...MODEL, variants: [] }]);

    expect(texts).not.toContain(i18n.t('agentChat.modelSelector.thinkingEffort'));
    expect(texts).not.toContain(i18n.t('modelChat.details.effortDefault'));
  });
});
