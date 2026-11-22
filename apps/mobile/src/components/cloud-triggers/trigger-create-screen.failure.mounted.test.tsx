/**
 * The failure band the New trigger screen renders for a refused save.
 *
 * The form is the product form with its pickers replaced by host stand-ins, so
 * this suite reads the copy and the Retry control the screen actually shows. A
 * taken name must name itself without a Retry, a validation payload must not
 * print its issue array, and a transport failure must offer the retry.
 */

import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { act, type ReactTestInstance, type ReactTestRenderer } from '@/test/renderer';
import { renderWithProviders } from '@/test/render-with-providers';

import { TriggerCreateScreen } from './trigger-create-screen';

const h = vi.hoisted(() => ({
  /** The name a field edit types into the form's draft. */
  draftName: 'take-one',
  createMutation: { mutateAsync: vi.fn(), isPending: false },
}));

vi.mock('expo-router', () => ({
  usePreventRemove: () => undefined,
}));

vi.mock('@/lib/navigation/stack-safe-replace', () => ({
  useStackSafeReplace: () => ({ replace: vi.fn() }),
}));

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    webhookTriggers: {
      create: { mutationOptions: () => ({}) },
      list: { pathFilter: () => ({ queryKey: ['webhookTriggers', 'list'] }) },
    },
  }),
}));

vi.mock('@tanstack/react-query', async importOriginal => ({
  ...(await importOriginal<object>()),
  useMutation: () => h.createMutation,
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock('@/components/ui/dialog', () => ({
  useConfirmDialog: () => ({ confirm: vi.fn(), dialog: null }),
}));

vi.mock('@/lib/a11y/announcing-toast', () => ({
  announcingToast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('react-native', () => ({
  I18nManager: { isRTL: false, getConstants: () => ({ isRTL: false }) },
  Platform: { OS: 'android' },
  Pressable: 'Pressable',
  View: 'View',
  useWindowDimensions: () => ({ width: 402, height: 874, scale: 2, fontScale: 1 }),
}));

vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
vi.mock('@/components/tab-screen', () => ({ TabScreenScrollView: 'TabScreenScrollView' }));

// The form's pickers and inputs are not under test: the sections are host
// stand-ins, and the draft edit they report goes through the screen's own
// `onDraftChange`, exactly as a typed name would.
vi.mock('./trigger-form-basics', () => ({ TriggerFormBasics: 'TriggerFormBasics' }));
vi.mock('./trigger-form-agent', () => ({ TriggerFormAgent: 'TriggerFormAgent' }));
vi.mock('./trigger-form-behaviour', () => ({ TriggerFormBehaviour: 'TriggerFormBehaviour' }));

/** Every line of text the screen renders, in tree order. */
function screenText(root: ReactTestInstance): string[] {
  return root
    .findAllByType('Text')
    .map(node =>
      node.children.filter((child): child is string => typeof child === 'string').join('')
    )
    .filter(line => line.length > 0);
}

/** The submit control the form renders for its own label, or undefined before it. */
function submitButton(root: ReactTestInstance): ReactTestInstance | undefined {
  const label = i18n.t('cloudAgent.triggers.create');
  return root
    .findAllByType('Button')
    .find(button => button.findAllByType('Text').some(node => node.props.children === label));
}

/** Whether the band renders the Retry control, which only a retryable failure gets. */
function offersRetry(root: ReactTestInstance): boolean {
  const retryLabel = i18n.t('common.retry');
  return root
    .findAllByType('Button')
    .some(button => button.findAllByType('Text').some(node => node.props.children === retryLabel));
}

async function mount(): Promise<ReactTestRenderer['root']> {
  const { renderer } = await renderWithProviders(createElement(TriggerCreateScreen));
  return renderer.root;
}

/** Report the draft name the person typed, through the section that reports it. */
function editName(root: ReactTestInstance): void {
  const basics = root.findByType('TriggerFormBasics');
  const props = basics.props as {
    draft: Record<string, unknown>;
    onDraftChange: (next: Record<string, unknown>) => void;
  };
  act(() => {
    props.onDraftChange({ ...props.draft, name: h.draftName });
  });
}

/** Press the form's submit and let the answer land. */
async function submit(root: ReactTestInstance): Promise<void> {
  const button = submitButton(root);
  if (!button) {
    throw new Error('the form did not render its submit control');
  }
  const press = button.props as { onPress: () => void };
  await act(async () => {
    press.onPress();
    await Promise.resolve();
  });
}

/** The answer the server gives for a duplicate name. */
function nameTakenError(): Error {
  return Object.assign(new Error('Trigger Name "take-one" already exists'), {
    name: 'TRPCClientError',
    data: { code: 'CONFLICT', httpStatus: 409, zodError: null },
  });
}

/** The answer a refused input contract gives: its issue array is the message. */
function validationError(): Error {
  return Object.assign(
    new Error(
      JSON.stringify([{ code: 'too_small', path: ['name'], message: 'Too small: expected string' }])
    ),
    {
      name: 'TRPCClientError',
      data: { code: 'BAD_REQUEST', httpStatus: 400, zodError: { issues: [] } },
    }
  );
}

afterEach(() => {
  vi.clearAllMocks();
  h.draftName = 'take-one';
});

describe('TriggerCreateScreen save failure band', () => {
  it('names the taken trigger and offers only Close', async () => {
    h.createMutation.mutateAsync.mockRejectedValue(nameTakenError());
    const root = await mount();

    editName(root);
    await submit(root);

    expect(h.createMutation.mutateAsync).toHaveBeenCalledTimes(1);
    expect(screenText(root)).toContain(
      i18n.t('cloudAgent.triggers.nameTaken', { name: 'take-one' })
    );
    expect(screenText(root)).toContain(i18n.t('common.close'));
    expect(offersRetry(root)).toBe(false);
  });

  it('states its own line for a validation payload instead of the issue array', async () => {
    h.createMutation.mutateAsync.mockRejectedValue(validationError());
    const root = await mount();

    editName(root);
    await submit(root);

    const text = screenText(root).join(' ');
    expect(text).toContain(i18n.t('cloudAgent.triggers.saveFailedCheck'));
    expect(text).not.toContain('too_small');
    expect(text).not.toContain('"path"');
    expect(offersRetry(root)).toBe(false);
  });

  it('offers the retry for a transport failure', async () => {
    h.createMutation.mutateAsync.mockRejectedValue(new Error('fetch failed'));
    const root = await mount();

    editName(root);
    await submit(root);

    expect(screenText(root)).toContain(i18n.t('cloudAgent.triggers.saveFailedRetry'));
    expect(offersRetry(root)).toBe(true);
  });
});
