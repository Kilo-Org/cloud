// The sheet's two entry answers: a workspace the token form can connect, and an
// organization already connected through Bitbucket OAuth. `connect` refuses a
// second integration, so the second case names that connection and says where
// it is managed, without offering a form the server would reject. Both suites
// import the same doubles from `bitbucket-connect-sheet.test-helpers`.

import { type ReactElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';

import { i18n } from '@/i18n';
import { act, type ReactTestRenderer } from '@/test/renderer';
import { renderWithProviders } from '@/test/render-with-providers';

import {
  BOUNDARY,
  BUTTON,
  DIALOG,
  FORM,
  HEADER,
  leave,
  mount,
  mountForm,
  mountWithoutScope,
  PERMISSION_DENIED,
  QUERY_ERROR,
  refetchMock,
  reportDirty,
  resetSheetMocks,
  routerMock,
  SKELETON,
  state,
  statusStore,
} from './bitbucket-connect-sheet.test-helpers';

/** The sentence that names where a connection the app cannot change is managed. */
const MANAGED_ON_WEB = i18n.t('codeReviewer.bitbucketConnect.managedOnWeb', {
  organization: 'Acme',
});

/** The organization line the shared ask sentence is stated under. */
const CONTEXT_LINE = i18n.t('prReview.connect.contextLine', { organization: 'Acme' });

/** Whether the sheet renders this exact copy. */
function rendersText(root: ReactTestRenderer['root'], value: string): boolean {
  return root
    .findAll(node => Object.is(node.type, 'Text'))
    .some(node => node.children.includes(value));
}

/**
 * The text blocks a state's description renders, top to bottom, with the type
 * token each one carries. The denial is a host element in this suite, so the
 * description reaches it as a prop; rendering that prop is what shows the sheet
 * built two blocks rather than one paragraph.
 */
async function descriptionBlocks(
  description: ReactNode
): Promise<{ text: string; variant: unknown }[]> {
  const { renderer, unmount } = await renderWithProviders(<>{description}</>);
  const blocks = renderer.root
    .findAll(node => Object.is(node.type, 'Text'))
    .map(node => ({
      text: node.children.map(child => (typeof child === 'string' ? child : '')).join(''),
      variant: node.props.variant,
    }));
  unmount();
  return blocks;
}

beforeEach(resetSheetMocks);

describe('BitbucketConnectSheet', () => {
  it('names an existing Bitbucket OAuth connection and says where it is managed', async () => {
    state.status.data = { method: 'oauth', integrationId: 'bitbucket-4' };
    const root = await mount();

    expect(root.findAll(node => Object.is(node.type, FORM))).toHaveLength(0);
    expect(rendersText(root, MANAGED_ON_WEB)).toBe(true);
    // The note names the organization whose connection the reader has to change
    // elsewhere, because a person in several organizations cannot tell which one
    // the sheet is about.
    expect(MANAGED_ON_WEB).toContain('Acme');
    // The connection page is not a place this sheet sends the reader: the note
    // is text, and the sheet offers nothing to press.
    expect(root.findAll(node => Object.is(node.type, BUTTON))).toHaveLength(0);
  });

  it('keeps the token form for a workspace with no integration', async () => {
    state.status.data = { method: 'workspace_access_token', integrationId: null };
    const root = await mount();

    expect(rendersText(root, MANAGED_ON_WEB)).toBe(false);
    const [form] = root.findAll(node => Object.is(node.type, FORM));
    expect(form?.props.integrationId).toBeNull();
    expect(form?.props.organizationName).toBe('Acme');
  });

  it('replaces the token of the integration the readiness read names', async () => {
    state.readiness.integrationId = 'bitbucket-2';
    // The status read names no token integration, so only the readiness id can
    // reach the form.
    state.status.data = { method: 'workspace_access_token', integrationId: null };
    const root = await mount();

    expect(rendersText(root, MANAGED_ON_WEB)).toBe(false);
    expect(root.findAll(node => Object.is(node.type, FORM))[0]?.props.integrationId).toBe(
      'bitbucket-2'
    );
  });

  it('waits for the status read before offering the token form', async () => {
    state.status.isPending = true;
    const root = await mount();

    expect(root.findAll(node => Object.is(node.type, FORM))).toHaveLength(0);
    expect(root.findAll(node => Object.is(node.type, SKELETON)).length).toBeGreaterThan(0);
  });

  it('retries instead of offering the token form when the status read fails', async () => {
    state.status.isError = true;
    state.status.error = new Error('request failed');
    const root = await mount();

    expect(root.findAll(node => Object.is(node.type, FORM))).toHaveLength(0);
    expect(root.findAll(node => Object.is(node.type, QUERY_ERROR))).toHaveLength(1);
  });

  it('states the step left to a refused member when the status read denies access', async () => {
    // A member whose organization read is refused by the role rule lands on this
    // denial rather than on the retry above, and the sheet opens from a deep
    // link as well, so the next step has to be stated here too.
    state.status.isError = true;
    state.status.error = { data: { code: 'FORBIDDEN', message: 'Forbidden' } };
    const root = await mount();

    expect(root.findAll(node => Object.is(node.type, FORM))).toHaveLength(0);
    const [denied] = root.findAll(node => Object.is(node.type, PERMISSION_DENIED));
    // The shared ask sentence does not name the organization, and the header
    // names only the platform, so the organization line is stated above it.
    expect(await descriptionBlocks(denied?.props.description as ReactNode)).toEqual([
      { text: CONTEXT_LINE, variant: 'muted' },
      { text: i18n.t('prReview.connect.bitbucketAdminOnlyDescription'), variant: 'muted' },
    ]);
  });

  it('states the step left to a refused member when the readiness read denies access', async () => {
    // The readiness read is the other answer that can refuse the role, and the
    // sheet must not fall back to a retry here: the refusal repeats.
    state.readinessError = { data: { code: 'UNAUTHORIZED', message: 'Forbidden' } };
    const root = await mount();

    expect(root.findAll(node => Object.is(node.type, FORM))).toHaveLength(0);
    expect(root.findAll(node => Object.is(node.type, QUERY_ERROR))).toHaveLength(0);
    const [denied] = root.findAll(node => Object.is(node.type, PERMISSION_DENIED));
    expect(await descriptionBlocks(denied?.props.description as ReactNode)).toEqual([
      { text: CONTEXT_LINE, variant: 'muted' },
      { text: i18n.t('prReview.connect.bitbucketAdminOnlyDescription'), variant: 'muted' },
    ]);
  });

  it('asks for an owner when the viewer cannot change an existing connection', async () => {
    state.role = 'member';
    state.status.data = { method: 'oauth', integrationId: 'bitbucket-4' };
    const root = await mount();

    expect(root.findAll(node => Object.is(node.type, FORM))).toHaveLength(0);
    const [denied] = root.findAll(node => Object.is(node.type, PERMISSION_DENIED));
    // The owner sentence names the organization whose connection the reader
    // has to have changed for them.
    expect(denied?.props.description).toBe(
      i18n.t('codeReviewer.bitbucketConnect.deniedManagedByOwner', { organization: 'Acme' })
    );
  });

  it('asks an owner to reconnect when a member cannot replace an existing token', async () => {
    state.role = 'member';
    state.readiness.integrationId = 'bitbucket-2';
    state.status.data = { method: 'workspace_access_token', integrationId: 'bitbucket-2' };
    const root = await mount();

    // Replacing a token is a different trio's action from connecting one, and
    // the sentence names the organization either way.
    expect(root.findAll(node => Object.is(node.type, FORM))).toHaveLength(0);
    const [denied] = root.findAll(node => Object.is(node.type, PERMISSION_DENIED));
    expect(denied?.props.description).toBe(
      i18n.t('codeReviewer.bitbucketConnect.deniedReconnectRole', { organization: 'Acme' })
    );
    expect(denied?.props.action).toBeUndefined();
  });

  it('names the lapsed plan under the role in its own line when a member cannot connect', async () => {
    state.role = 'member';
    state.isTrialExpiredForEnforcement = true;
    state.status.data = { method: 'workspace_access_token', integrationId: null };
    const root = await mount();

    const [denied] = root.findAll(node => Object.is(node.type, PERMISSION_DENIED));
    // The role is not the only blocker: the same organization's lapsed plan
    // refuses the connection too. The reasons are unrelated, so the state keeps
    // them apart — the organization line, the role sentence and the plan line
    // are three paragraphs with a paragraph gap between them, all in the same
    // body size — instead of one dense paragraph. The organization line exists
    // because the shared ask sentence leaves the organization implicit. The
    // plan line is this sheet's own key: the shared ended-plan sentence keeps
    // the "then try again" clause for the surfaces with no control.
    expect(await descriptionBlocks(denied?.props.description as ReactNode)).toEqual([
      { text: CONTEXT_LINE, variant: 'muted' },
      {
        text: i18n.t('prReview.connect.bitbucketAdminOnlyDescription'),
        variant: 'muted',
      },
      { text: i18n.t('codeReviewer.bitbucket.notConnectedReadOnlyPlan'), variant: 'muted' },
    ]);
    // The plan is the blocker the reader cannot clear by role, so the denial
    // carries the retry that re-reads the state once the owner updates billing.
    const action = denied?.props.action as
      | ReactElement<{ label: string; onPress: () => void }>
      | undefined;
    expect(action).toBeDefined();
    expect(action?.props.label).toBe(i18n.t('common.retry'));
    // Pressing it must ask all three answers again: the plan, the readiness and
    // the existing connection each decide whether the sheet still refuses.
    await act(async () => {
      action?.props.onPress();
      await Promise.resolve();
    });
    expect(refetchMock.org).toHaveBeenCalledTimes(1);
    expect(refetchMock.readiness).toHaveBeenCalledTimes(1);
    expect(refetchMock.status).toHaveBeenCalledTimes(1);
  });

  it('keeps the role sentence alone, with no action, when the plan does not block', async () => {
    state.role = 'member';
    state.isTrialExpiredForEnforcement = false;
    state.status.data = { method: 'workspace_access_token', integrationId: null };
    const root = await mount();

    // The role alone refuses the connection, so the plan adds no block — a
    // third paragraph would name a blocker this state does not have — and a
    // retry changes nothing, so the denial offers no control. The shared ask
    // sentence leaves the organization implicit, so the organization line above
    // it says which organization's rule refused, and the sentence itself asks
    // for an owner, admin or billing manager, so the reader learns the step left
    // to them rather than only who holds the permission.
    const [denied] = root.findAll(node => Object.is(node.type, PERMISSION_DENIED));
    expect(await descriptionBlocks(denied?.props.description as ReactNode)).toEqual([
      { text: CONTEXT_LINE, variant: 'muted' },
      { text: i18n.t('prReview.connect.bitbucketAdminOnlyDescription'), variant: 'muted' },
    ]);
    expect(denied?.props.action).toBeUndefined();
  });

  it('leaves the managed denial unchanged for a lapsed plan', async () => {
    state.role = 'member';
    state.isTrialExpiredForEnforcement = true;
    state.status.data = { method: 'oauth', integrationId: 'bitbucket-4' };
    const root = await mount();

    const [denied] = root.findAll(node => Object.is(node.type, PERMISSION_DENIED));
    // A connection only the web page can change is a different refusal from a
    // lapsed plan this reader could wait out, so the plan adds no second line.
    expect(denied?.props.description).toBe(
      i18n.t('codeReviewer.bitbucketConnect.deniedManagedByOwner', { organization: 'Acme' })
    );
    expect(denied?.props.action).toBeUndefined();
  });

  it('still asks when a background read replaces the form while a token is typed', async () => {
    const root = await mountForm();
    await reportDirty(root, true);

    // The status read answers late with an existing OAuth connection, so the
    // token form is gone and the sheet shows the note instead.
    await act(async () => {
      state.status.data = { method: 'oauth', integrationId: 'bitbucket-4' };
      statusStore.notify();
      await Promise.resolve();
    });
    expect(root.findAll(node => Object.is(node.type, FORM))).toHaveLength(0);
    expect(rendersText(root, MANAGED_ON_WEB)).toBe(true);

    // The confirmation is beside the note, so the held Back has a prompt.
    expect(root.findAll(node => Object.is(node.type, DIALOG))).toHaveLength(1);
    const { repeat } = await leave();

    expect(repeat).not.toHaveBeenCalled();
  });

  it('draws the header with the sheet close control above the form', async () => {
    const root = await mountForm();

    const header = root.find(node => Object.is(node.type, HEADER));
    expect(header.props.title).toBe(i18n.t('common.connectBitbucket'));
    // Nothing on this sheet commits: the single control is an X that closes it.
    expect(header.props.variant).toBe('close');
    // The Android route is a full-window modal, so the surface reaches the
    // window top and the header clears the status bar itself.
    expect(header.props.topInset).toBe('android-window-top');

    // The control asks the navigator to remove the route, which is the same
    // removal the guard holds for Back.
    await act(async () => {
      (header.props.onDone as () => void)();
      await Promise.resolve();
    });
    expect(routerMock.back).toHaveBeenCalledTimes(1);
  });

  it('keeps the close control in the loading and failing states too', async () => {
    // Loading: the skeleton body, and the header is already there, naming the
    // platform rather than claiming a connection the reads have not answered.
    state.status.isPending = true;
    const loading = await mount();
    const loadingHeader = loading.find(node => Object.is(node.type, HEADER));
    expect(loadingHeader.props.title).toBe(i18n.t('agentChat.repoPicker.platformBitbucket'));
    expect(loadingHeader.props.variant).toBe('close');

    // A failed status read: the retry body, and the same control, outside it.
    state.status.isPending = false;
    state.status.isError = true;
    state.status.error = new Error('request failed');
    const failed = await mount();
    const failedHeader = failed.find(node => Object.is(node.type, HEADER));
    expect(failedHeader.props.variant).toBe('close');
    expect(failed.findAll(node => Object.is(node.type, QUERY_ERROR))).toHaveLength(1);

    // One header for the surface, not one inside each body: a scroll in the form
    // can never move it, and the loading state already had it.
    expect(failed.findAll(node => Object.is(node.type, HEADER))).toHaveLength(1);
  });

  it('carries the same close control when no scope was supplied', async () => {
    const root = await mountWithoutScope();

    // This branch renders the boundary rather than any scope-dependent state,
    // and it is still the modal's only way out.
    const header = root.find(node => Object.is(node.type, HEADER));
    expect(header.props.variant).toBe('close');
    expect(root.findAll(node => Object.is(node.type, BOUNDARY))).toHaveLength(1);

    await act(async () => {
      (header.props.onDone as () => void)();
      await Promise.resolve();
    });
    expect(routerMock.back).toHaveBeenCalledTimes(1);
  });
});
