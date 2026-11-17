import { type ComponentProps, createElement } from 'react';

import { RemoteMcpServerForm } from '@/components/chat/remote-mcp-server-form';
import { type RemoteMcpServerDraft } from '@/lib/chat/remote-mcp-store';
import { act, TestRenderer } from '@/test/renderer';

/**
 * Shared harness for the remote MCP server form's mounted suites: the form's
 * own contract, and the token field it owns. The `vi.mock` calls stay in each
 * test file (they must be hoisted there); everything that does not depend on
 * the hoisted mock state lives here.
 */

export type FieldProps = {
  readonly label: string;
  readonly defaultValue?: string;
  readonly error?: string;
  readonly onChangeText?: (value: string) => void;
  readonly validate?: (value: string) => string | null;
};

export type ButtonProps = {
  readonly disabled?: boolean;
  readonly loading?: boolean;
  readonly onPress?: () => void;
};

type SegmentedProps = {
  readonly onChange: (value: string) => void;
};

/** The drafts Save reported, in order, until `resetForm` clears them. */
export const saved: RemoteMcpServerDraft[] = [];

export const onSave = (draft: RemoteMcpServerDraft): void => void saved.push(draft);

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;

export async function mount(props: ComponentProps<typeof RemoteMcpServerForm>): Promise<void> {
  await act(async () => {
    renderer = TestRenderer.create(createElement(RemoteMcpServerForm, props));
    await Promise.resolve();
  });
}

/** The mounted tree, for the helpers that read it. */
function mounted(): TestRenderer.ReactTestRenderer {
  if (renderer === undefined) {
    throw new Error('not mounted');
  }
  return renderer;
}

export function fields(): FieldProps[] {
  return mounted()
    .root.findAll(node => String(node.type) === 'FormField')
    .map(node => node.props as FieldProps);
}

export function saveButton(): ButtonProps {
  return mounted().root.find(node => String(node.type) === 'Button').props as ButtonProps;
}

/** Types into one field, the way the field's own onChangeText reports it. */
export async function typeInto(index: number, value: string): Promise<void> {
  const field = fields()[index];
  await act(async () => {
    field?.onChangeText?.(value);
    await Promise.resolve();
  });
}

export async function pressSave(): Promise<void> {
  await act(async () => {
    saveButton().onPress?.();
    await Promise.resolve();
  });
}

/** Picks a sign-in method, the way the segmented control reports it. */
export async function choose(method: RemoteMcpServerDraft['auth']['type']): Promise<void> {
  const control = mounted().root.find(node => String(node.type) === 'SegmentedControl')
    .props as SegmentedProps;
  await act(async () => {
    control.onChange(method);
    await Promise.resolve();
  });
}

/** Unmounts the tree and forgets the drafts it reported, so each test starts clean. */
export function resetForm(): void {
  renderer?.unmount();
  renderer = undefined;
  saved.length = 0;
}
