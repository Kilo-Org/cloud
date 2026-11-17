// The Bitbucket token form's two outcomes: a connect that lands closes the
// sheet it sits in, and a refusal the server will repeat forever (a lost role)
// leaves the field disabled with the sentence that explains it. Everything else
// the form renders is static copy.

import { createElement, type ElementType } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { act, type ReactTestRenderer } from '@/test/renderer';
import { renderWithProviders } from '@/test/render-with-providers';

import { BitbucketConnectForm } from './bitbucket-connect-form';

const mutations = vi.hoisted(() => ({
  connect: vi.fn<(vars: { accessToken: string }) => Promise<unknown>>(),
  replace: vi.fn<(vars: { integrationId: string; accessToken: string }) => Promise<unknown>>(),
}));

vi.mock('react-native', () => ({ View: 'View' }));
vi.mock('@/lib/hooks/use-bitbucket', () => ({
  useConnectBitbucket: () => ({ mutateAsync: mutations.connect }),
  useReplaceBitbucketToken: () => ({ mutateAsync: mutations.replace }),
}));
vi.mock('@/lib/external-link', () => ({ openExternalUrl: vi.fn() }));
vi.mock('@/components/ui/accessible-status', () => ({ AccessibleStatus: 'AccessibleStatus' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/form-field', () => ({ FormField: 'FormField' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));

const FIELD = 'FormField' as ElementType;
const BUTTON = 'Button' as ElementType;
const STATUS = 'AccessibleStatus' as ElementType;
/** The sentence that names where a connection the app cannot change is managed. */
const MANAGED_ON_WEB = i18n.t('codeReviewer.bitbucketConnect.managedOnWeb');

function submitButton(root: ReactTestRenderer['root']) {
  const found = root.findAll(node => Object.is(node.type, BUTTON));
  const button = found.at(-1);
  if (!button) {
    throw new Error('missing submit button');
  }
  return button;
}

/** Whether the form renders this exact copy. */
function rendersText(root: ReactTestRenderer['root'], value: string): boolean {
  return root
    .findAll(node => Object.is(node.type, 'Text'))
    .some(node => node.children.includes(value));
}

function statusMessage(root: ReactTestRenderer['root']): string | null {
  const [status] = root.findAll(node => Object.is(node.type, STATUS));
  return status ? (status.props.message as string | null) : null;
}

async function mount(integrationId: string | null, onConnected: () => void = vi.fn()) {
  const view = await renderWithProviders(
    createElement(BitbucketConnectForm, { scope: 'org-1', integrationId, onConnected })
  );
  return { root: view.renderer.root, onConnected };
}

async function edit(root: ReactTestRenderer['root'], token: string): Promise<void> {
  const [tokenField] = root.findAll(node => Object.is(node.type, FIELD));
  if (!tokenField) {
    throw new Error('missing token field');
  }
  await act(async () => {
    (tokenField.props.onChangeText as (value: string) => void)(token);
    await Promise.resolve();
  });
}

async function submit(root: ReactTestRenderer['root'], token: string): Promise<void> {
  await edit(root, token);
  await act(async () => {
    (submitButton(root).props.onPress as () => void)();
    await Promise.resolve();
  });
}

beforeEach(() => {
  mutations.connect.mockReset();
  mutations.replace.mockReset();
});

describe('BitbucketConnectForm', () => {
  it('connects the pasted token and hands the sheet its dismissal', async () => {
    mutations.connect.mockResolvedValue({ integrationId: 'bitbucket-1' });
    const { root, onConnected } = await mount(null);

    await submit(root, '  workspace-token  ');

    expect(mutations.connect).toHaveBeenCalledExactlyOnceWith({ accessToken: 'workspace-token' });
    expect(onConnected).toHaveBeenCalledTimes(1);
    expect(statusMessage(root)).toBeNull();
  });

  it('replaces the token of an existing connection instead of connecting twice', async () => {
    mutations.replace.mockResolvedValue({ integrationId: 'bitbucket-1' });
    const { root, onConnected } = await mount('bitbucket-1');

    await submit(root, 'replacement-token');

    expect(mutations.replace).toHaveBeenCalledExactlyOnceWith({
      integrationId: 'bitbucket-1',
      accessToken: 'replacement-token',
    });
    expect(mutations.connect).not.toHaveBeenCalled();
    expect(onConnected).toHaveBeenCalledTimes(1);
  });

  it('disables submit and explains a refusal no new token can fix', async () => {
    mutations.connect.mockRejectedValue({
      data: {
        code: 'UNAUTHORIZED',
        message: 'You do not have the required organizational role to access this feature',
      },
    });
    const { root, onConnected } = await mount(null);

    await submit(root, 'workspace-token');

    expect(onConnected).not.toHaveBeenCalled();
    expect(statusMessage(root)).toBe(i18n.t('prReview.connect.adminOnlyConnectDescription'));
    expect(submitButton(root).props.disabled).toBe(true);

    // A lost role is not a token problem, so a new token neither clears the
    // sentence nor re-enables the submit that would be refused again.
    await edit(root, 'another-token');

    expect(statusMessage(root)).toBe(i18n.t('prReview.connect.adminOnlyConnectDescription'));
    expect(submitButton(root).props.disabled).toBe(true);
  });

  it('keeps a connection that changed underneath on screen and names where it is managed', async () => {
    mutations.connect.mockRejectedValue({
      data: { code: 'CONFLICT', message: 'The Bitbucket credential changed during this operation' },
    });
    const { root } = await mount(null);
    expect(rendersText(root, MANAGED_ON_WEB)).toBe(false);
    // The sheet's own controls: the token-minting link above the field and the
    // submit. The note below must not add a third one.
    const controls = root.findAll(node => Object.is(node.type, BUTTON)).length;

    await submit(root, 'workspace-token');

    expect(statusMessage(root)).toBe(i18n.t('prReview.connect.checkFailedTitleBitbucket'));
    expect(submitButton(root).props.disabled).toBe(true);
    expect(rendersText(root, MANAGED_ON_WEB)).toBe(true);

    await edit(root, 'another-token');

    expect(statusMessage(root)).toBe(i18n.t('prReview.connect.checkFailedTitleBitbucket'));
    expect(submitButton(root).props.disabled).toBe(true);
    expect(rendersText(root, MANAGED_ON_WEB)).toBe(true);
    expect(root.findAll(node => Object.is(node.type, BUTTON))).toHaveLength(controls);
  });

  it('keeps submit available for a refused token, which a different one can fix', async () => {
    mutations.connect.mockRejectedValue({
      data: { code: 'UNAUTHORIZED', message: 'Bitbucket rejected the Workspace Access Token' },
    });
    const { root } = await mount(null);

    await submit(root, 'workspace-token');

    // A first connect pasted the token that never worked, so the sentence
    // names the token rather than an expired connection.
    expect(statusMessage(root)).toBe(i18n.t('codeReviewer.bitbucketConnect.tokenRefused'));
    expect(submitButton(root).props.disabled).toBe(false);

    // The next token is the repair, so typing retires the sentence.
    await edit(root, 'another-token');

    expect(statusMessage(root)).toBeNull();
    expect(rendersText(root, MANAGED_ON_WEB)).toBe(false);
  });

  it('announces an expired connection when replacing a stored token', async () => {
    mutations.replace.mockRejectedValue({
      data: { code: 'UNAUTHORIZED', message: 'Bitbucket rejected the Workspace Access Token' },
    });
    const { root } = await mount('bitbucket-1');

    await submit(root, 'replacement-token');

    // The replacement path submits against a connection that had already
    // accepted a token, so the refusal reads as that connection expiring —
    // the copy the recovery carried before the first connect got its own.
    expect(mutations.replace).toHaveBeenCalledExactlyOnceWith({
      integrationId: 'bitbucket-1',
      accessToken: 'replacement-token',
    });
    expect(mutations.connect).not.toHaveBeenCalled();
    expect(statusMessage(root)).toBe(i18n.t('prReview.reconnectNotice.bitbucketTitle'));
    expect(submitButton(root).props.disabled).toBe(false);
  });

  it('holds the token field still while the submitted token is in flight', async () => {
    const landing = Promise.withResolvers<unknown>();
    mutations.connect.mockImplementation(() => landing.promise);
    const { root } = await mount(null);
    const [field] = root.findAll(node => Object.is(node.type, FIELD));
    if (!field) {
      throw new Error('missing token field');
    }
    await act(async () => {
      (field.props.onChangeText as (value: string) => void)('workspace-token');
      await Promise.resolve();
    });
    await act(async () => {
      (submitButton(root).props.onPress as () => void)();
      await Promise.resolve();
    });

    const [pending] = root.findAll(node => Object.is(node.type, FIELD));
    expect(pending?.props.disabled).toBe(true);

    await act(async () => {
      landing.resolve({ integrationId: 'bitbucket-1' });
      await Promise.resolve();
    });
  });
});
