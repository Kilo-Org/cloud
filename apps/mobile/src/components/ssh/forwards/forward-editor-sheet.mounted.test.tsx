import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import {
  act,
  type ReactTestInstance,
  type ReactTestRenderer,
  TestRenderer,
} from '@/test/renderer';

import { ForwardEditorSheet } from './forward-editor-sheet';

// The sheet's fields are uncontrolled: each owns its text in a ref over
// `defaultValue`, and the sheet starts a new draft on every open by remounting
// its body. Without that, a reopened "Add forward" kept the previous draft, so
// saving it stored the same bind address twice (which the store now refuses).
vi.mock('react-native', () => ({ ScrollView: 'ScrollView', View: 'View' }));
vi.mock('@/components/ui/sheet', () => ({
  Sheet: ({ visible, children }: { visible: boolean; children?: React.ReactNode }) =>
    visible ? createElement('Sheet', null, children) : null,
}));
vi.mock('@/components/ui/dialog', () => ({
  useConfirmDialog: () => ({ confirm: vi.fn(), dialog: null }),
}));
vi.mock('@/components/ssh/switch-field', () => ({ SwitchField: 'SwitchField' }));
vi.mock('@/components/ui/segmented-control', () => ({ SegmentedControl: 'SegmentedControl' }));
vi.mock('@/components/ui/form-field-label', () => ({ FormFieldLabel: 'FormFieldLabel' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
// A string tag keeps the stand-in stateless, so what the sheet renders is
// exactly its own draft: `defaultValue` from the ref, `error` from the issue.
vi.mock('@/components/ui/form-field', () => ({ FormField: 'FormField' }));
// The store reaches `expo-crypto` for ids, whose expo import needs `__DEV__`.
vi.mock('expo-crypto', () => ({ randomUUID: () => 'id-fixture' }));

const save = vi.hoisted(() => ({ mutate: vi.fn() }));

vi.mock('@/lib/ssh/use-forwards', () => ({
  useSshForwardMutations: () => ({
    save: { mutate: save.mutate, isPending: false },
    remove: { mutate: vi.fn(), isPending: false },
  }),
}));

const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
const mounted: { current?: ReactTestRenderer } = {};

/**
 * The sheet inside the provider chain the tree was mounted with. `update` swaps
 * the root's children, so every update has to carry the same wrappers: a bare
 * sheet would remount the whole tree and reset the draft for the wrong reason.
 */
function tree(visible: boolean): ReactElement {
  return createElement(
    QueryClientProvider,
    { client: queryClient },
    createElement(ForwardEditorSheet, {
      visible,
      hostId: 'host-1',
      forward: null,
      onClose: () => undefined,
    })
  );
}

/** The bind-port field: the second field the sheet renders. */
function bindPortField(renderer: ReactTestRenderer): ReactTestInstance {
  const field = renderer.root.findAllByType('FormField')[1];
  if (field === undefined) {
    throw new Error('the sheet rendered no bind port field');
  }
  return field;
}

async function show(renderer: ReactTestRenderer | undefined, visible: boolean) {
  if (renderer === undefined) {
    // The renderer arrives inside `act`, so a holder keeps its type honest.
    const held: { current: ReactTestRenderer | undefined } = { current: undefined };
    await act(async () => {
      held.current = TestRenderer.create(tree(visible));
      await Promise.resolve();
    });
    const created = held.current;
    if (created === undefined) {
      throw new Error('the sheet did not mount');
    }
    mounted.current = created;
    return created;
  }
  act(() => {
    renderer.update(tree(visible));
  });
  return renderer;
}

/** Both ports, the two values a save needs to get past validation. */
function typePorts(renderer: ReactTestRenderer): void {
  const fields = renderer.root.findAllByType('FormField');
  act(() => {
    for (const [index, value] of [
      [1, '18080'],
      [3, '8080'],
    ] as const) {
      const field = fields[index];
      if (field === undefined) {
        throw new Error('the sheet rendered too few fields');
      }
      (field.props.onChangeText as (text: string) => void)(value);
    }
  });
}

function pressSave(renderer: ReactTestRenderer): void {
  const button = renderer.root.findAllByType('Button')[0];
  if (button === undefined) {
    throw new Error('the sheet rendered no Save button');
  }
  act(() => {
    (button.props.onPress as () => void)();
  });
}

beforeEach(() => {
  save.mutate = vi.fn();
});

afterEach(() => {
  mounted.current?.unmount();
  mounted.current = undefined;
});

describe('ForwardEditorSheet', () => {
  it('starts a reopened draft empty instead of keeping the last one', async () => {
    let renderer = await show(undefined, true);
    typePorts(renderer);

    renderer = await show(renderer, false);
    renderer = await show(renderer, true);
    pressSave(renderer);

    // An empty draft cannot be saved, so nothing reached the store: the reopened
    // sheet no longer carries the last draft's port.
    expect(save.mutate).not.toHaveBeenCalled();
    expect(bindPortField(renderer).props.error).toBeTruthy();
  });

  it('keeps the draft while the sheet stays open', async () => {
    let renderer = await show(undefined, true);
    typePorts(renderer);

    renderer = await show(renderer, true);
    pressSave(renderer);

    expect(save.mutate).toHaveBeenCalledWith(
      {
        id: null,
        forward: expect.objectContaining({ bindPort: 18080, destinationPort: 8080 }),
      },
      expect.anything()
    );
  });
});