// The Bitbucket token form's two outcomes: a connect that lands closes the
// sheet it sits in, and a failed connect leaves a sentence beside a submit whose
// state says whether another press can help. A refused token is judged, so only
// a different one unblocks submit; a transport fault is not, so the same token
// may go again. The reveal suite shares this harness and the same mounted tree.
/* eslint-disable max-lines -- one mounted suite for the form's contract: the outcome copy, the submit's block, the draft the sheet guards and the primary-action reveal share one harness */

import { createElement, type ElementType, type RefObject } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { type ScrollViewInstance } from 'react-native';

import { i18n } from '@/i18n';
import { textActionTargetClass, textActionTargetDp } from '@/lib/a11y/tap-target';
import { act, type ReactTestRenderer } from '@/test/renderer';
import { compiledDimensions } from '@/test/native-dimensions';
import { renderWithProviders } from '@/test/render-with-providers';

import { BitbucketConnectForm } from './bitbucket-connect-form';

const mutations = vi.hoisted(() => ({
  connect: vi.fn<(vars: { accessToken: string }) => Promise<unknown>>(),
  replace: vi.fn<(vars: { integrationId: string; accessToken: string }) => Promise<unknown>>(),
}));

// The form asks the shared tap-target helpers for the platform's target, so the
// mock carries the platform the helpers read.
vi.mock('react-native', () => ({
  I18nManager: { isRTL: false },
  Platform: { OS: 'ios' },
  View: 'View',
}));
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
const MANAGED_ON_WEB = i18n.t('codeReviewer.bitbucketConnect.managedOnWeb', {
  organization: 'Acme',
});

function submitButton(root: ReactTestRenderer['root']) {
  const found = root.findAll(node => Object.is(node.type, BUTTON));
  const button = found.at(-1);
  if (!button) {
    throw new Error('missing submit button');
  }
  return button;
}

/** The token-minting link above the field: the form's other button. */
function openInBrowserButton(root: ReactTestRenderer['root']) {
  const button = root.findAll(node => Object.is(node.type, BUTTON)).at(0);
  if (!button) {
    throw new Error('missing open-in-browser button');
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

/** The scroll frame's height the form is told about, in points. */
const FRAME_HEIGHT = 420;

/**
 * The frames the form asked for and that no test has run yet. A reveal is
 * scheduled inside a frame, so a test that reads `scrollToEnd` immediately after
 * the render it follows sees the call only once it runs these.
 */
const pendingFrames = new Map<number, FrameRequestCallback>();
let nextFrameId = 1;

function installFrames(): void {
  vi.stubGlobal('requestAnimationFrame', (onFrame: FrameRequestCallback) => {
    const id = nextFrameId;
    nextFrameId += 1;
    pendingFrames.set(id, onFrame);
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    pendingFrames.delete(id);
  });
}

/** Runs every frame the tree scheduled, including the ones those schedule. */
async function runFrames(): Promise<void> {
  await act(async () => {
    // Bounded, so a component that schedules a frame from a frame fails its
    // assertion instead of hanging the suite.
    for (let pass = 0; pass < 8 && pendingFrames.size > 0; pass += 1) {
      const scheduled = [...pendingFrames.values()];
      pendingFrames.clear();
      for (const onFrame of scheduled) {
        onFrame(0);
      }
    }
    await Promise.resolve();
  });
}

type ScrollToEnd = Mock<(options?: { animated?: boolean }) => void>;

type MountedForm = {
  root: ReactTestRenderer['root'];
  onConnected: () => void;
  /** What the form drives to reveal its primary action. */
  scrollToEnd: ScrollToEnd;
  /** Re-renders the form as the sheet would after its frame settled. */
  rerender: (scrollFrameHeight: number) => Promise<void>;
};

async function mount(
  integrationId: string | null,
  onConnected: () => void = vi.fn(),
  onDirtyChange?: (dirty: boolean) => void
): Promise<MountedForm> {
  // The scroll view's own instance never exists in a test-renderer tree; the
  // form reaches it only through `scrollToEnd`.
  const scrollToEnd: ScrollToEnd = vi.fn<(options?: { animated?: boolean }) => void>();
  const scrollRef: RefObject<ScrollViewInstance | null> = {
    current: { scrollToEnd } as unknown as ScrollViewInstance,
  };
  const element = (scrollFrameHeight: number) =>
    createElement(BitbucketConnectForm, {
      scope: 'org-1',
      integrationId,
      organizationName: 'Acme',
      onConnected,
      onDirtyChange,
      scrollRef,
      scrollFrameHeight,
    });
  const view = await renderWithProviders(element(FRAME_HEIGHT));
  return {
    root: view.renderer.root,
    onConnected,
    scrollToEnd,
    rerender: async scrollFrameHeight => {
      await act(async () => {
        view.renderer.update(
          createElement(
            QueryClientProvider,
            { client: view.queryClient },
            element(scrollFrameHeight)
          )
        );
        await Promise.resolve();
      });
    },
  };
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
  // A reveal runs inside a frame, so every test controls when that frame runs.
  pendingFrames.clear();
  nextFrameId = 1;
  installFrames();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('BitbucketConnectForm', () => {
  it('names the organization the connection belongs to', async () => {
    const { root } = await mount(null);
    const description = i18n.t('codeReviewer.bitbucketConnect.description', {
      organization: 'Acme',
    });

    expect(description).toContain('Acme');
    expect(rendersText(root, description)).toBe(true);
  });

  it('describes a token replacement as reconnecting, not as a new connection', async () => {
    const { root } = await mount('bitbucket-2');
    const descriptionReconnect = i18n.t('codeReviewer.bitbucketConnect.descriptionReconnect', {
      organization: 'Acme',
    });
    const firstConnectDescription = i18n.t('codeReviewer.bitbucketConnect.description', {
      organization: 'Acme',
    });

    expect(descriptionReconnect).not.toBe(firstConnectDescription);
    expect(rendersText(root, descriptionReconnect)).toBe(true);
    expect(rendersText(root, firstConnectDescription)).toBe(false);
  });

  it('gives the token-minting link the platform touch target', async () => {
    // The compact outline button renders its `sm` 36pt frame, which the audit
    // reads on the control's own node; the link carries the platform target
    // instead, so a tap on the sentence beside it does not miss the control.
    const { root } = await mount(null);
    const link = openInBrowserButton(root);

    expect(link.props.className).toBe(textActionTargetClass());
    // It sits in the form's `gap-5` column, not in a row whose content band its
    // height would blow out, so it takes no overhang cancel.
    expect(link.props.style).toBeUndefined();

    const declarations = (await compiledDimensions(link.props.className as string)) as {
      minHeight?: number;
    }[];
    const box = Object.assign({}, ...declarations) as { minHeight: number };
    expect(box.minHeight).toBe(textActionTargetDp());
  });

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
    // The role sentence names the organization whose rule refused, so a person
    // in several of them reads which one this is.
    const roleDenial = i18n.t('codeReviewer.bitbucketConnect.deniedConnectRole', {
      organization: 'Acme',
    });

    await submit(root, 'workspace-token');

    expect(onConnected).not.toHaveBeenCalled();
    expect(statusMessage(root)).toBe(roleDenial);
    expect(submitButton(root).props.disabled).toBe(true);

    // A lost role is not a token problem, so a new token neither clears the
    // sentence nor re-enables the submit that would be refused again.
    await edit(root, 'another-token');

    expect(statusMessage(root)).toBe(roleDenial);
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

  it('disables submit for a refused token until the field holds a different one', async () => {
    mutations.connect.mockRejectedValue({
      data: { code: 'UNAUTHORIZED', message: 'Bitbucket rejected the Workspace Access Token' },
    });
    const { root } = await mount(null);

    await submit(root, 'workspace-token');

    // A first connect pasted the token that never worked, so the sentence
    // names the token rather than an expired connection. Bitbucket judged this
    // token, so the same one cannot go again.
    expect(statusMessage(root)).toBe(i18n.t('codeReviewer.bitbucketConnect.tokenRefused'));
    expect(submitButton(root).props.disabled).toBe(true);

    // The next token is the repair, so typing retires the sentence and the
    // block with it.
    await edit(root, 'another-token');

    expect(statusMessage(root)).toBeNull();
    expect(submitButton(root).props.disabled).toBe(false);
    expect(rendersText(root, MANAGED_ON_WEB)).toBe(false);
  });

  it('keeps submit enabled for a failure that never judged the token', async () => {
    mutations.connect.mockRejectedValue({ data: { code: 'INTERNAL_SERVER_ERROR' } });
    const { root } = await mount(null);

    await submit(root, 'workspace-token');

    // A server fault judged no token, so the same one may go again without an
    // edit: the sentence points at the connection, not at the token.
    expect(statusMessage(root)).toBe(i18n.t('prReview.connect.providerCheckFailedMessage'));
    expect(submitButton(root).props.disabled).toBe(false);

    await edit(root, 'another-token');

    expect(statusMessage(root)).toBeNull();
    expect(submitButton(root).props.disabled).toBe(false);
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
    // The refused token is the connection's, so a replacement is what unblocks
    // submit: the same one cannot go again.
    expect(submitButton(root).props.disabled).toBe(true);

    await edit(root, 'another-token');

    expect(statusMessage(root)).toBeNull();
    expect(submitButton(root).props.disabled).toBe(false);
  });

  it('reports a draft until a submit takes it, and gives it back when the connect fails', async () => {
    const landing = Promise.withResolvers<unknown>();
    mutations.connect.mockImplementation(() => landing.promise);
    const onDirtyChange = vi.fn<(dirty: boolean) => void>();
    const { root } = await mount(null, vi.fn<() => void>(), onDirtyChange);

    await edit(root, 'workspace-token');
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);

    // The submit already sent this token, so a Back while the connect runs
    // drops nothing the person typed.
    await act(async () => {
      (submitButton(root).props.onPress as () => void)();
      await Promise.resolve();
    });
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);

    // A refused token is still in the field, so the sheet guards it again.
    await act(async () => {
      landing.reject({
        data: { code: 'UNAUTHORIZED', message: 'Bitbucket rejected the Workspace Access Token' },
      });
      await Promise.resolve();
    });
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);

    // Whitespace is what a submit would not send, so it is not an edit either.
    await edit(root, '   ');
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
  });

  it('never reports a draft again once a connect accepted the token', async () => {
    mutations.connect.mockResolvedValue({ integrationId: 'bitbucket-1' });
    const onDirtyChange = vi.fn<(dirty: boolean) => void>();
    const { root, onConnected } = await mount(null, vi.fn<() => void>(), onDirtyChange);

    await edit(root, 'workspace-token');
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);

    await act(async () => {
      (submitButton(root).props.onPress as () => void)();
      await Promise.resolve();
    });

    // The accepted token is not a draft any more. A later `true` here would
    // re-arm the sheet's leave guard over the dismissal it just started.
    expect(onConnected).toHaveBeenCalledTimes(1);
    expect(onDirtyChange).not.toHaveBeenLastCalledWith(true);
    expect(onDirtyChange.mock.calls.filter(([dirty]) => dirty)).toHaveLength(1);
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

// A refusal puts a sentence above the primary action, which grows the sheet's
// scroll content while the sheet keeps its detent, so the action can fall below
// the viewport. The form reveals it, and does nothing at all otherwise.
describe('BitbucketConnectForm primary-action reveal', () => {
  it('reveals the action once a refused token puts its sentence on screen', async () => {
    mutations.connect.mockRejectedValue({
      data: {
        code: 'BAD_REQUEST',
        message: 'The Bitbucket Workspace Access Token format is invalid',
      },
    });
    const form = await mount(null);

    // A form with nothing on screen leaves the sheet where the person put it.
    await runFrames();
    expect(form.scrollToEnd).not.toHaveBeenCalled();

    await submit(form.root, 'workspace-token');

    // The reveal waits for the frame the sentence is laid out in.
    expect(statusMessage(form.root)).toBe(i18n.t('codeReviewer.bitbucketConnect.tokenRefused'));
    expect(form.scrollToEnd).not.toHaveBeenCalled();

    await runFrames();

    expect(form.scrollToEnd).toHaveBeenCalledExactlyOnceWith({ animated: true });
  });

  it('reveals again when the scroll frame settles while the failure shows', async () => {
    mutations.connect.mockRejectedValue({
      data: {
        code: 'BAD_REQUEST',
        message: 'The Bitbucket Workspace Access Token format is invalid',
      },
    });
    const form = await mount(null);
    await submit(form.root, 'workspace-token');
    await runFrames();
    form.scrollToEnd.mockClear();

    // A re-render that reports the same frame is not a new band, so it is not a
    // new reveal.
    await form.rerender(FRAME_HEIGHT);
    await runFrames();
    expect(form.scrollToEnd).not.toHaveBeenCalled();

    // The keyboard's band lands after the sentence: the shorter frame is what
    // pushes the action below the viewport again.
    await form.rerender(FRAME_HEIGHT - 120);
    await runFrames();
    expect(form.scrollToEnd).toHaveBeenCalledExactlyOnceWith({ animated: true });
  });

  it('keeps the sheet still while the refused token is still being checked', async () => {
    const landing = Promise.withResolvers<unknown>();
    mutations.connect.mockImplementation(() => landing.promise);
    const form = await mount(null);

    await submit(form.root, 'workspace-token');
    await runFrames();
    expect(form.scrollToEnd).not.toHaveBeenCalled();

    await act(async () => {
      landing.reject({
        data: {
          code: 'BAD_REQUEST',
          message: 'The Bitbucket Workspace Access Token format is invalid',
        },
      });
      await Promise.resolve();
    });
    await runFrames();

    expect(form.scrollToEnd).toHaveBeenCalledExactlyOnceWith({ animated: true });
  });

  it('never moves the sheet after a connect lands', async () => {
    mutations.connect.mockResolvedValue({ integrationId: 'bitbucket-1' });
    const form = await mount(null);

    await submit(form.root, 'workspace-token');
    await runFrames();

    expect(form.onConnected).toHaveBeenCalledTimes(1);
    expect(form.scrollToEnd).not.toHaveBeenCalled();
  });
});
