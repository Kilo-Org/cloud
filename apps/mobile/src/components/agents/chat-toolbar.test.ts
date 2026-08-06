import { describe, expect, it, vi } from 'vitest';

import { type AgentMode } from '@/components/agents/mode-selector';
import { ChatToolbar } from './chat-toolbar';

vi.mock('react-native', () => ({
  View: 'View',
}));
vi.mock('@/components/agents/mode-selector', () => ({
  ModeSelector: 'ModeSelector',
}));
vi.mock('@/components/agents/model-selector', () => ({
  ModelSelector: 'ModelSelector',
}));
vi.mock('@/components/agents/composer-paste-button', () => ({
  ComposerPasteButton: 'ComposerPasteButton',
}));

// ── helpers ────────────────────────────────────────────────────────
type Node = { props?: Record<string, unknown> } | null | undefined | string | number | boolean;

function findElementByType(node: Node, typeName: string): Record<string, unknown> | null {
  if (node === null || typeof node !== 'object') {
    return null;
  }
  const props = node.props ?? {};
  const children = props.children;
  const type = (node as { type?: unknown }).type;
  if (type === typeName) {
    return node.props ?? {};
  }
  for (const child of Array.isArray(children) ? children : [children]) {
    const found = findElementByType(child as Node, typeName);
    if (found) {
      return found;
    }
  }
  return null;
}

function defaultProps() {
  return {
    mode: 'code' as AgentMode,
    onModeChange: vi.fn(),
    model: 'anthropic/claude-sonnet-4',
    variant: 'medium',
    modelOptions: [] as never[],
    onModelSelect: vi.fn(),
  };
}

describe('ChatToolbar', () => {
  it('renders no paste button without onPaste', () => {
    // eslint-disable-next-line new-cap -- plain function call, matching repo test convention
    const element = ChatToolbar(defaultProps()) as Node;

    expect(findElementByType(element, 'ComposerPasteButton')).toBeNull();
  });

  it('forwards onPaste and the disabled state to the paste button', () => {
    const onPaste = vi.fn(() => undefined);
    // eslint-disable-next-line new-cap -- plain function call, matching repo test convention
    const element = ChatToolbar({
      ...defaultProps(),
      onPaste,
      pasteDisabled: true,
    }) as Node;

    const pasteButtonProps = findElementByType(element, 'ComposerPasteButton');
    expect(pasteButtonProps).not.toBeNull();
    const props = pasteButtonProps ?? {};
    expect(props.size).toBe('sm');
    expect(props.disabled).toBe(true);
    expect(props.onPress).toBe(onPaste);
  });

  it('defaults the paste button disabled state to false when omitted', () => {
    const onPaste = vi.fn(() => undefined);
    // eslint-disable-next-line new-cap -- plain function call, matching repo test convention
    const element = ChatToolbar({ ...defaultProps(), onPaste }) as Node;

    const pasteButtonProps = findElementByType(element, 'ComposerPasteButton');
    expect(pasteButtonProps).not.toBeNull();
    const props = pasteButtonProps ?? {};
    expect(props.disabled).toBe(false);
  });
});
