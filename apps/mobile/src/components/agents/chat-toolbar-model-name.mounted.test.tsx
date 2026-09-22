import { createElement } from 'react';
import { TestRenderer } from '@/test/renderer';
import { describe, expect, it, vi } from 'vitest';

import '@/i18n';
import {
  buildSessionModelOptions,
  type SessionModelOption,
} from '@/lib/hooks/use-session-model-options';

import { ChatToolbar } from './chat-toolbar';

vi.mock('react-native', () => ({
  Keyboard: { dismiss: vi.fn() },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  View: 'View',
}));
vi.mock('expo-haptics', () => ({ selectionAsync: vi.fn() }));
vi.mock('expo-router', () => ({
  useLocalSearchParams: () => ({}),
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock('@/components/ui/icons', () => ({
  BookOpenCheck: 'BookOpenCheck',
  Bot: 'Bot',
  Brain: 'Brain',
  Bug: 'Bug',
  Check: 'Check',
  ChevronDown: 'ChevronDown',
  ClipboardPaste: 'ClipboardPaste',
  Code: 'Code',
  HelpCircle: 'HelpCircle',
  NotebookPen: 'NotebookPen',
  Star: 'Star',
  Workflow: 'Workflow',
}));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/hooks/use-available-models', () => ({
  thinkingEffortLabel: (variant: string) => variant,
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    foreground: '#111827',
    mutedForeground: '#6F6A61',
    primary: '#4F5A10',
    warn: '#9F6612',
  }),
}));
vi.mock('@/lib/picker-bridge', () => ({}));
vi.mock('@/lib/route-registry', () => ({
  modelPickerSlot: { set: vi.fn() },
}));
vi.mock('@/lib/utils', () => ({
  cn: (...parts: unknown[]) => parts.filter(Boolean).join(' '),
}));

// The model name from the explorer capture: 19 characters, wider than the
// space one nowrap row leaves after the shrink-0 mode chip and the effort badge.
const LONG_MODEL_NAME = 'DeepSeek V4.1 Flash';

const MODEL_OPTIONS: SessionModelOption[] = [
  {
    id: 'deepseek/deepseek-v4.1-flash',
    name: LONG_MODEL_NAME,
    displayId: 'deepseek/deepseek-v4.1-flash',
    variants: ['low', 'medium'],
    isPreferred: false,
    showGatewayMetadata: true,
  },
];

function renderToolbar(
  options: SessionModelOption[] = MODEL_OPTIONS,
  model = MODEL_OPTIONS[0]?.id ?? ''
): TestRenderer.ReactTestRenderer {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  TestRenderer.act(() => {
    ref.current = TestRenderer.create(
      createElement(ChatToolbar, {
        mode: 'code',
        onModeChange: vi.fn<(mode: string) => void>(),
        model,
        variant: 'low',
        modelOptions: options,
        onModelSelect: vi.fn<(modelId: string, variant: string) => void>(),
        onPaste: vi.fn<() => void>(),
      })
    );
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

describe('ChatToolbar long model name', () => {
  it('lets the control row reflow instead of squeezing the model name to a few characters', () => {
    const renderer = renderToolbar();
    // A nowrap row gives the model chip only what the shrink-0 mode chip leaves,
    // and the chip then sheds that from the label. Wrapping moves the model chip
    // to its own line, where it keeps the full name.
    const rows = renderer.root.findAll(
      node =>
        typeof node.type === 'string' &&
        (node.type as string) === 'View' &&
        typeof node.props.className === 'string' &&
        node.props.className.includes('flex-wrap')
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.props.className).toContain('flex-row');
  });

  it('hands the full model name to the chip label, never a pre-shortened string', () => {
    const renderer = renderToolbar();
    const label = renderer.root.findAll(
      node =>
        typeof node.type === 'string' &&
        (node.type as string) === 'Text' &&
        node.props.children === LONG_MODEL_NAME
    );
    expect(label).toHaveLength(1);
    expect(label[0]?.props.numberOfLines).toBe(1);
  });

  it('packs the paste button into the model chip row so it cannot wrap alone', () => {
    const renderer = renderToolbar();
    const modelChip = renderer.root.findAll(
      node =>
        typeof node.type === 'string' &&
        (node.type as string) === 'Pressable' &&
        typeof node.props.accessibilityLabel === 'string' &&
        node.props.accessibilityLabel.startsWith(LONG_MODEL_NAME)
    )[0];
    const pasteButton = renderer.root.findAll(
      node =>
        typeof node.type === 'string' &&
        (node.type as string) === 'Pressable' &&
        node.props.accessibilityLabel === 'Paste from clipboard'
    )[0];
    expect(modelChip).toBeDefined();
    expect(pasteButton).toBeDefined();

    // The nearest shared ancestor is the row the chip and the button wrap in.
    // It must be a plain row: a wrapping row would let the button leave the
    // chip's line on its own.
    const chipChain: TestRenderer.ReactTestInstance[] = [];
    for (
      let node: TestRenderer.ReactTestInstance | null | undefined = modelChip;
      node;
      node = node.parent
    ) {
      chipChain.push(node);
    }
    const pasteChain: TestRenderer.ReactTestInstance[] = [];
    for (
      let node: TestRenderer.ReactTestInstance | null | undefined = pasteButton;
      node;
      node = node.parent
    ) {
      pasteChain.push(node);
    }
    const shared = chipChain.find(candidate => pasteChain.includes(candidate));
    expect(shared).toBeDefined();
    expect(shared?.props.className).toContain('flex-row');
    expect(shared?.props.className).not.toContain('flex-wrap');

    // The button still ends the chip's line at its trailing edge.
    expect(pasteButton?.props.className).toContain('ml-auto');
  });
});

// The remote v1 CLI catalog the explorer's session used: the provider name is
// repeated inside the model's own display name.
const REMOTE_CLI_CATALOG_NAME = 'DeepSeek: DeepSeek V4 Flash 0731';
const STRIPPED_MODEL_NAME = 'DeepSeek V4 Flash 0731';

function buildRemoteCliModelOptions(): SessionModelOption[] {
  return buildSessionModelOptions({
    activeSessionType: 'remote',
    remoteModelState: {
      ownerConnectionId: 'cli-owner',
      protocol: 'v1',
      refresh: 'idle',
      catalog: {
        protocolVersion: 1,
        truncated: false,
        providers: [
          {
            id: 'kilo',
            name: 'Kilo',
            models: [
              {
                id: 'deepseek/deepseek-v4-flash-0731',
                name: REMOTE_CLI_CATALOG_NAME,
                variants: [],
                capabilities: { attachment: false, reasoning: true },
                limits: { context: 200_000, output: 8192 },
              },
            ],
          },
        ],
      },
    },
    observedModel: null,
    remoteModelOverride: null,
    gatewayModels: [],
    gatewayModelsLoading: false,
    organizationId: 'org-persisted',
  }).options;
}

describe('ChatToolbar model chip vendor prefix', () => {
  it('renders the remote CLI catalog name without the repeated vendor prefix', () => {
    const options = buildRemoteCliModelOptions();
    const selected = options[0];
    if (!selected) {
      throw new Error('expected a remote CLI catalog option');
    }
    const renderer = renderToolbar(options, selected.id);

    const chipLabel = renderer.root.findAll(
      node =>
        typeof node.type === 'string' &&
        (node.type as string) === 'Text' &&
        node.props.children === STRIPPED_MODEL_NAME
    );
    expect(chipLabel).toHaveLength(1);

    const prefixed = renderer.root.findAll(
      node =>
        typeof node.type === 'string' &&
        (node.type as string) === 'Text' &&
        typeof node.props.children === 'string' &&
        node.props.children.includes('DeepSeek: DeepSeek')
    );
    expect(prefixed).toHaveLength(0);
  });
});
