/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as src/components/ui/selectable-text.mounted.test.tsx) */
import { type ComponentProps, createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import {
  type ChildSessionHydrationState,
  type OlderMessagesError,
  type StoredMessage,
  type TextPart,
} from '@kilocode/cloud-agent-sdk';

import { type SessionModelOption } from '@/lib/hooks/use-session-model-options';

import { ChildSessionSheet } from './child-session-sheet';
import { ChildSessionModelLabel } from './child-session-model-label';

vi.mock('react-native', () => ({
  Modal: 'Modal',
  View: 'View',
  Pressable: 'Pressable',
}));
vi.mock('react-native-reanimated', () => ({
  default: { View: 'AnimatedView' },
  LinearTransition: { duration: () => ({}) },
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
// The real `@/components/ui/text` loads `@rn-primitives/slot`, whose node_modules
// `.mjs` contains JSX that this pipeline cannot transform. Provide a real context
// so any `useContext(TextClassContext)` consumer still resolves.
vi.mock('@/components/ui/text', async () => {
  const React = await import('react');
  return {
    Text: 'Text',
    TextClassContext: React.createContext<string | undefined>(undefined),
  };
});
vi.mock('@/components/ui/icons', () => ({
  Bot: 'Bot',
  ChevronRight: 'ChevronRight',
  Loader2: 'Loader2',
}));
vi.mock('@/components/ui/spinning-icon', () => ({
  SpinningIcon: 'SpinningIcon',
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({}),
}));
vi.mock('./session-message-list', () => ({
  SessionMessageList: () => null,
}));
vi.mock('./part-detail-sheet-host', () => ({
  PartDetailSheetHost: ({ children }: { children?: unknown }) => children,
}));
vi.mock('./working-indicator', () => ({
  WorkingIndicator: () => null,
}));
vi.mock('./message-error-boundary', () => ({
  MessageErrorBoundary: ({ children }: { children?: unknown }) => children,
}));
vi.mock('@/components/empty-state', () => ({
  EmptyState: 'EmptyState',
}));
vi.mock('@/components/query-error', () => ({
  QueryError: 'QueryError',
}));
vi.mock('@/components/sheet-header', () => ({
  SheetHeader: 'SheetHeader',
}));

const modelOption: SessionModelOption = {
  id: 'kilo/model',
  name: 'Test Model',
  displayId: 'model',
  variants: [],
  isPreferred: false,
  showGatewayMetadata: false,
  provider: { id: 'kilo', name: 'Kilo' },
  modelRef: { providerID: 'kilo', modelID: 'model' },
};

function makeTextPart(text: string): TextPart {
  return { id: 't1', sessionID: 's1', messageID: 'm1', type: 'text', text };
}

function makeAssistantMessage(): StoredMessage {
  return {
    info: {
      id: 'm1',
      sessionID: 's1',
      role: 'assistant',
      time: { created: 1 },
      parentID: 'm0',
      modelID: 'model',
      providerID: 'kilo',
      mode: 'code',
      agent: 'build',
      path: { cwd: '/', root: '/' },
      cost: 0,
      tokens: { total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [makeTextPart('child text')],
  };
}

const readyState: ChildSessionHydrationState = {
  status: 'ready',
  cursor: null,
  hasOlder: false,
  isLoadingOlder: false,
  olderError: null,
  omittedItemCount: 0,
};

const errorState: ChildSessionHydrationState = { status: 'error', message: 'Failed' };

type SheetPropsFixture = {
  getChildMessages: (sessionId: string) => StoredMessage[];
  hydrationState: ChildSessionHydrationState;
};

function buildProps({
  getChildMessages,
  hydrationState,
}: SheetPropsFixture): ComponentProps<typeof ChildSessionSheet> {
  return {
    visible: true,
    sessionId: 'child-1',
    title: 'Subagent',
    getChildMessages,
    hydrationState,
    sessionError: null,
    isStreaming: false,
    hasOlderMessages: false,
    isLoadingOlderMessages: false,
    olderMessagesError: null as OlderMessagesError | null,
    olderMessagesOmittedItemCount: 0,
    onLoadOlderMessages: vi.fn<() => void>(),
    renderPart: () => null,
    onOpenChildSession: vi.fn<(sessionId: string, title: string) => void>(),
    onRetry: vi.fn<() => void>(),
    onClose: vi.fn<() => void>(),
    modelOptions: [modelOption],
  };
}

async function renderSheet(props: ComponentProps<typeof ChildSessionSheet>) {
  const rendererRef: { current: TestRenderer.ReactTestRenderer | undefined } = {
    current: undefined,
  };
  await act(async () => {
    await Promise.resolve();
    rendererRef.current = TestRenderer.create(createElement(ChildSessionSheet, props));
  });
  const renderer = rendererRef.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

describe('ChildSessionSheet mounted', () => {
  it('renders the model row when child messages carry model data', async () => {
    const messages = [makeAssistantMessage()];
    const renderer = await renderSheet(
      buildProps({
        getChildMessages: () => messages,
        hydrationState: readyState,
      })
    );

    const labels = renderer.root.findAllByType(ChildSessionModelLabel);
    expect(labels).toHaveLength(1);
    expect(labels[0]?.props).toMatchObject({ modelLabel: 'Test Model' });

    const a11yNodes = renderer.root.findAll(
      node => node.props.accessibilityLabel === 'Model: Test Model'
    );
    expect(a11yNodes).toHaveLength(1);
  });

  it('renders no model row for an empty transcript', async () => {
    const renderer = await renderSheet(
      buildProps({
        getChildMessages: () => [],
        hydrationState: readyState,
      })
    );

    expect(renderer.root.findAllByType(ChildSessionModelLabel)).toHaveLength(0);
  });

  it('renders the QueryError and no model row when hydration fails', async () => {
    const renderer = await renderSheet(
      buildProps({
        getChildMessages: () => [],
        hydrationState: errorState,
      })
    );

    expect(renderer.root.findAllByType(ChildSessionModelLabel)).toHaveLength(0);
    const errors = renderer.root.findAll(node => (node.type as string) === 'QueryError');
    expect(errors).toHaveLength(1);
  });
});
