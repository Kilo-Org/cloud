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

function childTypesOf(node: Node): unknown[] {
  const props = (node as { props?: Record<string, unknown> } | null | undefined)?.props ?? {};
  const children = props.children;
  return (Array.isArray(children) ? children : [children]).map(child =>
    child !== null && typeof child === 'object' ? (child as { type?: unknown }).type : undefined
  );
}

/** The row that directly holds every one of `typeNames`, if there is one. */
function findRowHolding(node: Node, typeNames: string[]): Record<string, unknown> | null {
  if (node === null || typeof node !== 'object') {
    return null;
  }
  const childTypes = childTypesOf(node);
  if (typeNames.every(typeName => childTypes.includes(typeName))) {
    return node.props ?? {};
  }
  const props = node.props ?? {};
  const children = props.children;
  for (const child of Array.isArray(children) ? children : [children]) {
    const found = findRowHolding(child as Node, typeNames);
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

  it('lets the control row reflow so a long model chip keeps its own width', () => {
    const onPaste = vi.fn(() => undefined);
    // eslint-disable-next-line new-cap -- plain function call, matching repo test convention
    const element = ChatToolbar({ ...defaultProps(), onPaste }) as Node;

    const className =
      element !== null &&
      typeof element === 'object' &&
      typeof element.props?.className === 'string'
        ? element.props.className
        : '';
    expect(className).toContain('flex-row');
    // The mode chip is shrink-0, so a nowrap row would squeeze the model name
    // down to a few characters. Wrapping gives the model chip its own line.
    expect(className).toContain('flex-wrap');

    const pasteButtonProps = findElementByType(element, 'ComposerPasteButton') ?? {};
    expect(pasteButtonProps.className).toContain('shrink-0');
  });

  it('packs the paste button with the model chip so it never wraps to a line of its own', () => {
    const onPaste = vi.fn(() => undefined);
    // eslint-disable-next-line new-cap -- plain function call, matching repo test convention
    const element = ChatToolbar({ ...defaultProps(), onPaste }) as Node;

    // A paste button that is a sibling of the chips overflows the first line on
    // its own and wraps to an empty row below the model chip. One inner row
    // holding both makes the outer wrap move them together.
    const packRow = findRowHolding(element, ['ModelSelector', 'ComposerPasteButton']);
    expect(packRow).not.toBeNull();
    const packClassName = typeof packRow?.className === 'string' ? packRow.className : '';
    expect(packClassName).toContain('flex-row');
    expect(packClassName).not.toContain('flex-wrap');

    // On the chip's line the button still keeps the trailing edge, as it did
    // when every item fit on the first line.
    const pasteButtonProps = findElementByType(element, 'ComposerPasteButton') ?? {};
    expect(pasteButtonProps.className).toContain('ml-auto');
  });

  it('locks only the model picker when modelLocked is true', () => {
    // eslint-disable-next-line new-cap -- plain function call, matching repo test convention
    const element = ChatToolbar({
      ...defaultProps(),
      modelLocked: true,
      modelLockLabel: 'Locked Bot',
    }) as Node;

    const modelSelectorProps = findElementByType(element, 'ModelSelector');
    expect(modelSelectorProps).not.toBeNull();
    const modelProps = modelSelectorProps ?? {};
    expect(modelProps.disabled).toBe(true);
    expect(modelProps.lockLabel).toBe('Locked Bot');

    const modeSelectorProps = findElementByType(element, 'ModeSelector');
    expect(modeSelectorProps).not.toBeNull();
    const modeProps = modeSelectorProps ?? {};
    expect(modeProps.disabled).toBe(false);
  });
});
