import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { AgentFormSheet } from '@/components/profiles/agent-form-sheet';
import { type AgentSource } from '@/components/profiles/profile-agents-model';
import { act, type ReactTestInstance } from '@/test/renderer';
import { renderWithProviders } from '@/test/render-with-providers';

const h = vi.hoisted(() => ({
  useAvailableModels: vi.fn(),
  onSave: vi.fn(),
  onClose: vi.fn(),
  confirmRequest: null as null | {
    title: string;
    message: string;
    confirmLabel: string;
    cancelLabel?: string;
    onConfirm: () => void;
    onCancel: () => void;
  },
}));

/** The confirm's two answers, as the shared dialog renders them. */
function DialogStub({
  request,
}: {
  request: { onConfirm: () => void; onCancel?: () => void } | null;
}) {
  if (request === null) {
    return null;
  }
  const cancel = () => {
    h.confirmRequest = null;
  };
  return createElement(
    'View',
    null,
    createElement('Pressable', {
      accessibilityLabel: 'Discard',
      onPress: () => {
        h.confirmRequest = null;
        request.onConfirm();
      },
    }),
    createElement('Pressable', {
      accessibilityLabel: 'Keep editing',
      onPress: () => {
        cancel();
        request.onCancel?.();
      },
    })
  );
}

vi.mock('@/lib/hooks/use-available-models', () => ({
  useAvailableModels: (...args: unknown[]) => h.useAvailableModels(...args),
  thinkingEffortLabel: (variant: string) => variant,
}));
vi.mock('react-native', () => ({
  View: 'View',
  ScrollView: 'ScrollView',
  Pressable: 'Pressable',
  Switch: 'Switch',
  BackHandler: { addEventListener: () => ({ remove: () => undefined }) },
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('@/components/agents/session-page-sheet', () => ({ SessionPageSheet: 'SessionPageSheet' }));
vi.mock('@/components/sheet-header', () => ({ SheetHeader: 'SheetHeader' }));
vi.mock('@/components/ui/form-field', () => ({ FormField: 'FormField' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
// The confirm is a native sheet (`@/components/ui/dialog` -> DestructiveConfirmDialog);
// its portal/native chrome cannot load in the node test renderer, so the suite
// stubs it: the guard's request lands in `h.confirmRequest` and the dialog node
// mirrors the real hook's behavior — onConfirm runs the request's action and
// clears the request; cancel only clears it.
vi.mock('@/components/ui/dialog', () => ({
  useConfirmDialog: () => ({
    confirm: (request: NonNullable<typeof h.confirmRequest>) => {
      h.confirmRequest = request;
    },
    dialog: createElement(DialogStub, { request: h.confirmRequest }),
  }),
}));

function agentSource(overrides: Partial<AgentSource> = {}): AgentSource {
  return {
    id: 'agent-1',
    slug: 'reviewer',
    name: 'Reviewer',
    config: {
      description: 'Reviews code',
      mode: 'primary',
      model: 'anthropic/claude',
      prompt: 'You review',
    },
    ...overrides,
  };
}

function findAll(root: ReactTestInstance, type: string): ReactTestInstance[] {
  return root.findAll(node => typeof node.type === 'string' && node.type === type);
}

function findField(root: ReactTestInstance, label: string): ReactTestInstance {
  const field = findAll(root, 'FormField').find(node => node.props.label === label);
  if (!field) {
    throw new Error(`field ${label} was not rendered`);
  }
  return field;
}

function findOne(root: ReactTestInstance, type: string): ReactTestInstance {
  const node = findAll(root, type)[0];
  if (!node) {
    throw new Error(`${type} was not rendered`);
  }
  return node;
}

function changeText(root: ReactTestInstance, label: string, value: string): void {
  act(() => {
    (findField(root, label).props as { onChangeText: (v: string) => void }).onChangeText(value);
  });
}

function pressVariant(root: ReactTestInstance, variant: string): void {
  const pressable = findAll(root, 'Pressable').find(node =>
    String(node.props.accessibilityLabel).startsWith(`${variant} thinking effort`)
  );
  if (!pressable) {
    throw new Error(`variant ${variant} was not rendered`);
  }
  act(() => {
    (pressable.props as { onPress: () => void }).onPress();
  });
}

function pressDone(root: ReactTestInstance): void {
  act(() => {
    (findOne(root, 'SheetHeader').props as { onDone: () => void }).onDone();
  });
}

function pressCancel(root: ReactTestInstance): void {
  act(() => {
    (findOne(root, 'SheetHeader').props as { onCancel: () => void }).onCancel();
  });
}

function pressVisibility(root: ReactTestInstance, label: string): void {
  const pressable = findAll(root, 'Pressable').find(
    node => node.props.accessibilityLabel === label
  );
  if (!pressable) {
    throw new Error(`visibility option ${label} was not rendered`);
  }
  act(() => {
    (pressable.props as { onPress: () => void }).onPress();
  });
}

function pressDialogButton(root: ReactTestInstance, label: string): void {
  const pressable = findAll(root, 'Pressable').find(
    node => node.props.accessibilityLabel === label
  );
  if (!pressable) {
    throw new Error(`dialog button ${label} was not rendered`);
  }
  act(() => {
    (pressable.props as { onPress: () => void }).onPress();
  });
}

function modelOption(id: string, variants: string[]) {
  return { id, name: id, variants, isPreferred: false };
}

// eslint-disable-next-line typescript-eslint/promise-function-async -- returning the harness promise unchanged
function mountSheet(agent: AgentSource | null) {
  return renderWithProviders(
    createElement(AgentFormSheet, {
      agent,
      organizationId: undefined,
      isSaving: false,
      onClose: () => {
        h.onClose();
      },
      onSave: payload => {
        h.onSave(payload);
      },
    })
  );
}

describe('AgentFormSheet parity fields', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.useAvailableModels.mockReturnValue({ models: [] });
  });

  it('renders the sampling labels alongside the model field', async () => {
    const { renderer, unmount } = await mountSheet(null);

    expect(findField(renderer.root, 'Max steps')).toBeTruthy();
    expect(findField(renderer.root, 'Temperature')).toBeTruthy();
    expect(findField(renderer.root, 'top_p')).toBeTruthy();

    unmount();
  });

  it('happy: lists the model variants and saves the picked effort', async () => {
    h.useAvailableModels.mockReturnValue({
      models: [modelOption('anthropic/claude', ['low', 'high'])],
    });

    const { renderer, unmount } = await mountSheet(agentSource());

    pressVariant(renderer.root, 'high');
    pressDone(renderer.root);

    expect(h.onSave).toHaveBeenCalledTimes(1);
    expect(h.onSave.mock.calls[0]?.[0]).toMatchObject({
      slug: 'reviewer',
      name: 'Reviewer',
      config: { model: 'anthropic/claude', variant: 'high' },
    });

    unmount();
  });

  it('hides the effort control when the model list errors and still saves the typed values', async () => {
    h.useAvailableModels.mockReturnValue({ models: [], isError: true });

    const { renderer, unmount } = await mountSheet(agentSource());

    expect(
      findAll(renderer.root, 'Pressable').some(node =>
        String(node.props.accessibilityLabel).includes('thinking effort')
      )
    ).toBe(false);

    changeText(renderer.root, 'Max steps', '50');
    changeText(renderer.root, 'Temperature', '0.2');
    changeText(renderer.root, 'top_p', '0.95');
    pressDone(renderer.root);

    expect(h.onSave).toHaveBeenCalledTimes(1);
    expect(h.onSave.mock.calls[0]?.[0]).toMatchObject({
      slug: 'reviewer',
      config: { steps: 50, temperature: 0.2, top_p: 0.95 },
    });

    unmount();
  });

  it('hides the effort control while the model list loads and still saves the typed values', async () => {
    h.useAvailableModels.mockReturnValue({ models: [], isLoading: true });

    const { renderer, unmount } = await mountSheet(agentSource());

    expect(
      findAll(renderer.root, 'Pressable').some(node =>
        String(node.props.accessibilityLabel).includes('thinking effort')
      )
    ).toBe(false);

    changeText(renderer.root, 'Max steps', '40');
    pressDone(renderer.root);

    expect(h.onSave).toHaveBeenCalledTimes(1);
    expect(h.onSave.mock.calls[0]?.[0]).toMatchObject({
      slug: 'reviewer',
      config: { steps: 40 },
    });

    unmount();
  });

  it('hides the effort control when the typed model has no variants', async () => {
    h.useAvailableModels.mockReturnValue({
      models: [modelOption('anthropic/claude', [])],
    });

    const { renderer, unmount } = await mountSheet(agentSource());

    expect(
      findAll(renderer.root, 'Pressable').some(node =>
        String(node.props.accessibilityLabel).includes('thinking effort')
      )
    ).toBe(false);

    unmount();
  });

  it('closes a clean form through Cancel without asking', async () => {
    const { renderer, unmount } = await mountSheet(agentSource());

    pressCancel(renderer.root);

    expect(h.onClose).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('asks before discarding typed edits and closes only on Discard', async () => {
    const { renderer, unmount } = await mountSheet(agentSource());

    changeText(renderer.root, 'Agent name', 'Renamed');
    pressCancel(renderer.root);

    // Not closed yet: the confirm stands between the edit and the loss, and it
    // carries the shared Keep editing / Discard copy.
    expect(h.onClose).not.toHaveBeenCalled();
    expect(h.confirmRequest).toMatchObject({
      confirmLabel: 'Discard',
      cancelLabel: 'Keep editing',
    });

    act(() => {
      h.confirmRequest?.onConfirm();
    });
    expect(h.onClose).toHaveBeenCalledTimes(1);

    unmount();
  });

  it('keeps the sheet open when the confirm is cancelled, then re-evaluates the gate', async () => {
    const { renderer, unmount } = await mountSheet(agentSource());

    changeText(renderer.root, 'Agent name', 'Renamed');
    pressCancel(renderer.root);
    expect(h.onClose).not.toHaveBeenCalled();

    // Keep editing: the dialog's cancel only dismisses the confirm; the sheet
    // and the typed value stay. The gate re-evaluates on the next close, so
    // reverting the field makes the next Cancel close without asking again.
    pressDialogButton(renderer.root, 'Keep editing');
    changeText(renderer.root, 'Agent name', 'Reviewer');
    pressCancel(renderer.root);
    expect(h.onClose).toHaveBeenCalledTimes(1);

    unmount();
  });

  it('treats a visibility change as unsaved work', async () => {
    const { renderer, unmount } = await mountSheet(agentSource());

    pressVisibility(renderer.root, 'All — both');
    pressCancel(renderer.root);

    expect(h.onClose).not.toHaveBeenCalled();
    expect(h.confirmRequest).not.toBeNull();

    unmount();
  });
});
