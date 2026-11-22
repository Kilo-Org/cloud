/**
 * The failure band the New trigger screen renders for a refused save.
 *
 * The form is a stand-in, but the band it renders is the product band, so this
 * suite reads the copy and the Retry control the screen actually shows. A taken
 * name must name itself without a Retry, a validation payload must not print its
 * issue array, and a transport failure must offer the retry.
 */

import { type ComponentType, createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { type TriggerDraft } from '@/lib/cloud-triggers/trigger-draft';
import { type TriggerFormFailure } from '@/lib/cloud-triggers/trigger-save-failure';
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
// The form's own sections are not under test; the band beside them is. Mocking
// them keeps the real module to the band alone.
vi.mock('./trigger-form-agent', () => ({ TriggerFormAgent: 'TriggerFormAgent' }));
vi.mock('./trigger-form-basics', () => ({ TriggerFormBasics: 'TriggerFormBasics' }));
vi.mock('./trigger-form-behaviour', () => ({ TriggerFormBehaviour: 'TriggerFormBehaviour' }));

type BandProps = Readonly<{
  failure: TriggerFormFailure;
  onRetry: () => void;
  onDismiss: () => void;
}>;

/** The form surface this suite drives: a draft edit, the submit, and the band. */
type FormStandInProps = Readonly<{
  draft: TriggerDraft;
  onDraftChange: (next: TriggerDraft) => void;
  onSubmit: () => void;
  failure: TriggerFormFailure | null;
  onRetry: () => void;
  onDismissFailure: () => void;
}>;

vi.mock('./trigger-form', async () => {
  // A `vi.mock` factory runs before this file's imports are initialized, and it
  // must render the product band, so both React and the real module load here.
  const React = await import('react');
  const actual = await vi.importActual<{ FailureBand: ComponentType<BandProps> }>('./trigger-form');
  return {
    TriggerForm: (props: FormStandInProps) =>
      React.createElement(
        'View',
        null,
        React.createElement('Pressable', {
          action: 'draft',
          onPress: () => {
            props.onDraftChange({ ...props.draft, name: h.draftName });
          },
        }),
        React.createElement('Pressable', { action: 'submit', onPress: props.onSubmit }),
        props.failure === null
          ? null
          : React.createElement(actual.FailureBand, {
              failure: props.failure,
              onRetry: props.onRetry,
              onDismiss: props.onDismissFailure,
            })
      ),
  };
});

/** Every line of text the band renders, in tree order. */
function bandText(root: ReactTestInstance): string[] {
  return root
    .findAllByType('Text')
    .map(node =>
      node.children.filter((child): child is string => typeof child === 'string').join('')
    )
    .filter(line => line.length > 0);
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

/** Type the draft name the form reports, the way a field edit does. */
function editName(root: ReactTestInstance): void {
  const draftProps = root.findByProps({ action: 'draft' }).props as { onPress: () => void };
  act(() => {
    draftProps.onPress();
  });
}

/** Submit the form and let the answer land. */
async function submit(root: ReactTestInstance): Promise<void> {
  const submitProps = root.findByProps({ action: 'submit' }).props as { onPress: () => void };
  await act(async () => {
    submitProps.onPress();
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
    expect(bandText(root)).toContain(i18n.t('cloudAgent.triggers.nameTaken', { name: 'take-one' }));
    expect(bandText(root)).toContain(i18n.t('common.close'));
    expect(offersRetry(root)).toBe(false);
  });

  it('states its own line for a validation payload instead of the issue array', async () => {
    h.createMutation.mutateAsync.mockRejectedValue(validationError());
    const root = await mount();

    editName(root);
    await submit(root);

    const text = bandText(root).join(' ');
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

    expect(bandText(root)).toContain(i18n.t('cloudAgent.triggers.saveFailedRetry'));
    expect(offersRetry(root)).toBe(true);
  });
});
