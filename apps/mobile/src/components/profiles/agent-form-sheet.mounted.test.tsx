/* eslint-disable max-lines -- keeps the mounted agent form behavior and refused-save scroll checks together */
import { createElement, type ReactNode, type Ref } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
  scrollTo: vi.fn(),
}));

vi.mock('@/lib/hooks/use-available-models', () => ({
  useAvailableModels: (...args: unknown[]) => h.useAvailableModels(...args),
  thinkingEffortLabel: (variant: string) => variant,
}));
// A mock factory is hoisted above this file's imports, so React comes in through a
// dynamic import there (the pattern this suite's harness already relies on). The
// stub exposes `scrollTo`, which a refused Save drives, so tests can observe it.
// The shared switch takes its track and thumb from the app palette.
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    mutedForeground: '#6f6a61',
    primary: '#4f5a10',
    primaryForeground: '#ffffff',
  }),
}));
vi.mock('react-native', async () => {
  const {
    createElement: createMockElement,
    forwardRef,
    useImperativeHandle,
  } = await import('react');
  return {
    Platform: { OS: 'ios' },
    View: 'View',
    Pressable: 'Pressable',
    Switch: 'Switch',
    ScrollView: forwardRef(function ScrollViewStub(
      props: { children?: ReactNode },
      ref: Ref<{ scrollTo: typeof h.scrollTo }>
    ) {
      useImperativeHandle(ref, () => ({ scrollTo: h.scrollTo }));
      return createMockElement('ScrollView', props, props.children);
    }),
  };
});
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

/** A host stub's layout prop, read from the renderer's untyped props. */
type ContainerLayout = (event: { nativeEvent: { layout: { y: number } } }) => void;

/** Register a field block's offset the way the scroll view reports it after layout. */
function layoutField(root: ReactTestInstance, label: string, y: number): void {
  const handler: unknown = findField(root, label).props.containerOnLayout;
  if (typeof handler !== 'function') {
    throw new TypeError(`field ${label} has no layout handler`);
  }
  // Checked to be a function above; the stub props carry no call signature.
  const onLayout = handler as ContainerLayout;
  act(() => {
    onLayout({ nativeEvent: { layout: { y } } });
  });
}

function pressCancel(root: ReactTestInstance): void {
  const onCancel = voidHandler(findOne(root, 'SheetHeader').props.onCancel);
  act(() => {
    onCancel();
  });
}

/** A host stub keeps the component's own props untyped; these suites call one handler each. */
function voidHandler(value: unknown): () => void {
  if (typeof value !== 'function') {
    throw new TypeError('expected a handler prop');
  }
  return value as () => void;
}

/** The sheet's dismissal request answers whether it may close. */
function booleanHandler(value: unknown): () => boolean {
  if (typeof value !== 'function') {
    throw new TypeError('expected a handler prop');
  }
  return value as () => boolean;
}

type ConfirmRequest = {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel?: string;
  onConfirm: () => void;
};

function confirmRequest(index: number): ConfirmRequest | undefined {
  return h.confirm.mock.calls[index]?.[0];
}

function modelOption(id: string, variants: string[]) {
  return { id, name: id, variants, isPreferred: false };
}

// eslint-disable-next-line typescript-eslint/promise-function-async -- returning the harness promise unchanged
function mountSheet(agent: AgentSource | null, existingSlugs: readonly string[] = []) {
  return renderWithProviders(
    createElement(AgentFormSheet, {
      agent,
      existingSlugs,
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
    expect(findField(renderer.root, 'Top P')).toBeTruthy();

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
    changeText(renderer.root, 'Top P', '0.95');
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

  it('refuses an over-long description inline and keeps the sheet open', async () => {
    const { renderer, unmount } = await mountSheet(agentSource());

    changeText(renderer.root, 'Agent description', 'd'.repeat(2001));
    layoutField(renderer.root, 'Agent name', 120);
    layoutField(renderer.root, 'Agent description', 280);
    pressDone(renderer.root);

    expect(h.onSave).not.toHaveBeenCalled();
    expect(findField(renderer.root, 'Agent description').props.error).toBe(
      'Use at most 2000 characters'
    );
    expect(h.scrollTo).toHaveBeenCalledWith({ y: 268, animated: true });

    unmount();
  });

  it('closes without asking when nothing changed', async () => {
    const { renderer, unmount } = await mountSheet(agentSource());

    pressCancel(renderer.root);

    expect(h.onClose).toHaveBeenCalledTimes(1);
    expect(h.confirm).not.toHaveBeenCalled();

    unmount();
  });

  it('refuses a non-ASCII slug with the character rule instead of calling it empty', async () => {
    const { renderer, unmount } = await mountSheet(agentSource());

    changeText(renderer.root, 'Agent slug', 'नमूना एजेंट स्लग');
    pressDone(renderer.root);

    expect(h.onSave).not.toHaveBeenCalled();
    expect(findField(renderer.root, 'Agent slug').props.error).toBe(
      'Slug must start with a lowercase ASCII letter and use only ASCII lowercase letters, digits, and dashes, up to 50 characters'
    );

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
    confirmRequest(0)?.onConfirm();
    expect(h.onClose).toHaveBeenCalledTimes(1);

    unmount();
  });

  it('keeps Android Back while dirty for the confirm, and lets it close a clean form', async () => {
    const { renderer, unmount } = await mountSheet(agentSource());
    const requestDismiss = booleanHandler(
      findOne(renderer.root, 'SessionPageSheet').props.onRequestDismiss
    );

    expect(requestDismiss()).toBe(true);
    expect(h.confirm).not.toHaveBeenCalled();

    changeText(renderer.root, 'Max steps', '50');
    expect(requestDismiss()).toBe(false);
    expect(h.confirm).toHaveBeenCalledTimes(1);
    expect(h.onClose).not.toHaveBeenCalled();

    unmount();
  });
});

describe('AgentFormSheet refused save', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.useAvailableModels.mockReturnValue({ models: [] });
  });

  it('scrolls to the slug field when it is missing', async () => {
    const { renderer, unmount } = await mountSheet(null);
    layoutField(renderer.root, 'Agent slug', 240);

    pressDone(renderer.root);

    expect(h.scrollTo).toHaveBeenCalledWith({ y: 228, animated: true });
    expect(h.onSave).not.toHaveBeenCalled();

    unmount();
  });

  it('scrolls to the name field when the slug is valid but the name is not', async () => {
    const { renderer, unmount } = await mountSheet(null);
    changeText(renderer.root, 'Agent slug', 'quality-review');
    layoutField(renderer.root, 'Agent name', 520);

    pressDone(renderer.root);

    expect(h.scrollTo).toHaveBeenCalledWith({ y: 508, animated: true });
    expect(h.onSave).not.toHaveBeenCalled();

    unmount();
  });
});
