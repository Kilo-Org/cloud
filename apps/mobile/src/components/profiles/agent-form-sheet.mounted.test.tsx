import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { AgentFormSheet } from '@/components/profiles/agent-form-sheet';
import { type AgentSource } from '@/components/profiles/profile-agents-model';
import { i18n } from '@/i18n';
import { act, type ReactTestInstance } from '@/test/renderer';
import { renderWithProviders } from '@/test/render-with-providers';

const h = vi.hoisted(() => ({
  useAvailableModels: vi.fn(),
  onSave: vi.fn(),
  onClose: vi.fn(),
  confirm: vi.fn(),
}));

vi.mock('@/lib/hooks/use-available-models', () => ({
  useAvailableModels: (...args: unknown[]) => h.useAvailableModels(...args),
  thinkingEffortLabel: (variant: string) => variant,
}));
vi.mock('react-native', () => ({
  View: 'View',
  ScrollView: 'ScrollView',
  Pressable: 'Pressable',
  Switch: 'Switch',
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('@/components/agents/session-page-sheet', () => ({ SessionPageSheet: 'SessionPageSheet' }));
vi.mock('@/components/sheet-header', () => ({ SheetHeader: 'SheetHeader' }));
vi.mock('@/components/ui/form-field', () => ({ FormField: 'FormField' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/dialog', () => ({
  useConfirmDialog: () => ({
    confirm: (request: unknown) => {
      h.confirm(request);
    },
    dialog: null,
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
  const handler: unknown = findOne(root, 'SheetHeader').props.onCancel;
  if (typeof handler !== 'function') {
    throw new TypeError('SheetHeader has no onCancel');
  }
  act(() => {
    handler();
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

  it('closes without asking when nothing changed', async () => {
    const { renderer, unmount } = await mountSheet(agentSource());

    pressCancel(renderer.root);

    expect(h.onClose).toHaveBeenCalledTimes(1);
    expect(h.confirm).not.toHaveBeenCalled();

    unmount();
  });

  it('asks Keep editing / Discard when Cancel would drop typed fields', async () => {
    const { renderer, unmount } = await mountSheet(agentSource());

    changeText(renderer.root, 'Max steps', '50');
    pressCancel(renderer.root);

    expect(h.onClose).not.toHaveBeenCalled();
    expect(h.confirm).toHaveBeenCalledTimes(1);
    const request = h.confirm.mock.calls[0]?.[0];
    expect(request).toMatchObject({
      title: i18n.t('common.discardChangesTitle'),
      message: i18n.t('common.discardChangesMessage'),
      confirmLabel: i18n.t('common.discard'),
      cancelLabel: i18n.t('common.keepEditing'),
    });

    // Discard closes; Keep editing never reaches this callback.
    request?.onConfirm();
    expect(h.onClose).toHaveBeenCalledTimes(1);

    unmount();
  });

  it('keeps Android Back while dirty for the confirm, and lets it close a clean form', async () => {
    const { renderer, unmount } = await mountSheet(agentSource());
    const sheet = findOne(renderer.root, 'SessionPageSheet');
    const requestDismiss: unknown = sheet.props.onRequestDismiss;
    if (typeof requestDismiss !== 'function') {
      throw new TypeError('the sheet has no dismissal request');
    }

    expect(requestDismiss()).toBe(true);
    expect(h.confirm).not.toHaveBeenCalled();

    changeText(renderer.root, 'Max steps', '50');
    expect(requestDismiss()).toBe(false);
    expect(h.confirm).toHaveBeenCalledTimes(1);
    expect(h.onClose).not.toHaveBeenCalled();

    unmount();
  });
});
