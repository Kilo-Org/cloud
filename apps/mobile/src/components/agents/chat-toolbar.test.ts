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

  it('keeps the control row on one line so it never wraps the model chip', () => {
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
    // The row must never wrap: the mode chip is shrink-0, so the model chip
    // takes the remaining width and truncates its own label.
    expect(className).not.toContain('flex-wrap');

    const pasteButtonProps = findElementByType(element, 'ComposerPasteButton') ?? {};
    expect(pasteButtonProps.className).toContain('shrink-0');
  });

  it('pins the chips to one row when the host turns wrap off', () => {
    const onPaste = vi.fn(() => undefined);
    // eslint-disable-next-line new-cap -- plain function call, matching repo test convention
    const element = ChatToolbar({ ...defaultProps(), onPaste, wrap: false }) as Node;

    const className =
      element !== null &&
      typeof element === 'object' &&
      typeof element.props?.className === 'string'
        ? element.props.className
        : '';
    expect(className).toContain('flex-row');
    expect(className).not.toContain('flex-wrap');

    const pasteButtonProps = findElementByType(element, 'ComposerPasteButton') ?? {};
    expect(pasteButtonProps.className).toContain('shrink-0');
  });

  it('keeps the chips on one row even when a caller passes the superseded wrap flag', () => {
    // `wrap` opted into #6349's second row. The toolbar never wraps now, and the
    // new-session and clone callers still pass the flag, so it must stay inert.
    // eslint-disable-next-line new-cap -- plain function call, matching repo test convention
    const element = ChatToolbar({ ...defaultProps(), wrap: true }) as Node;

    const className =
      element !== null &&
      typeof element === 'object' &&
      typeof element.props?.className === 'string'
        ? element.props.className
        : '';
    expect(className).toContain('flex-row');
    expect(className).not.toContain('flex-wrap');
  });

  it('forwards onLayout to the row', () => {
    const onLayout = vi.fn(() => undefined);
    // eslint-disable-next-line new-cap -- plain function call, matching repo test convention
    const element = ChatToolbar({ ...defaultProps(), onLayout }) as Node;

    expect(element).toMatchObject({ props: { onLayout } });
  });

  it('packs the paste button with the model chip so it never leaves the chip line', () => {
    const onPaste = vi.fn(() => undefined);
    // eslint-disable-next-line new-cap -- plain function call, matching repo test convention
    const element = ChatToolbar({ ...defaultProps(), onPaste }) as Node;

    // The paste button and the chip share one inner row, so the button cannot
    // break away from the chip onto a line of its own.
    const packRow = findRowHolding(element, ['ModelSelector', 'ComposerPasteButton']);
    expect(packRow).not.toBeNull();
    const packClassName = typeof packRow?.className === 'string' ? packRow.className : '';
    expect(packClassName).toContain('flex-row');
    expect(packClassName).not.toContain('flex-wrap');
    // Without `shrink` the nowrap row overflows instead of truncating (React
    // Native defaults `flexShrink` to 0), pushing the paste button off the row.
    expect(packClassName).toContain('shrink');
    expect(packClassName).toContain('min-w-0');

    // The button still keeps the trailing edge of the chip's line.
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
