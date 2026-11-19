// The sheet's two entry answers: a workspace the token form can connect, and an
// organization already connected through Bitbucket OAuth. `connect` refuses a
// second integration, so the second case names that connection and says where
// it is managed, without offering a form the server would reject. Both suites
// import the same doubles from `bitbucket-connect-sheet.test-helpers`.

import { beforeEach, describe, expect, it } from 'vitest';

import { i18n } from '@/i18n';
import { act, type ReactTestRenderer } from '@/test/renderer';

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
  reportDirty,
  resetSheetMocks,
  routerMock,
  SKELETON,
  state,
  statusStore,
} from './bitbucket-connect-sheet.test-helpers';

/** The sentence that names where a connection the app cannot change is managed. */
const MANAGED_ON_WEB = i18n.t('codeReviewer.bitbucketConnect.managedOnWeb');

/** Whether the sheet renders this exact copy. */
function rendersText(root: ReactTestRenderer['root'], value: string): boolean {
  return root
    .findAll(node => Object.is(node.type, 'Text'))
    .some(node => node.children.includes(value));
}

beforeEach(resetSheetMocks);

describe('BitbucketConnectSheet', () => {
  it('names an existing Bitbucket OAuth connection and says where it is managed', async () => {
    state.status.data = { method: 'oauth', integrationId: 'bitbucket-4' };
    const root = await mount();

    expect(root.findAll(node => Object.is(node.type, FORM))).toHaveLength(0);
    expect(rendersText(root, MANAGED_ON_WEB)).toBe(true);
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

  it('asks for an owner when the viewer cannot change an existing connection', async () => {
    state.role = 'member';
    state.status.data = { method: 'oauth', integrationId: 'bitbucket-4' };
    const root = await mount();

    expect(root.findAll(node => Object.is(node.type, FORM))).toHaveLength(0);
    const [denied] = root.findAll(node => Object.is(node.type, PERMISSION_DENIED));
    expect(denied?.props.description).toBe(i18n.t('integrations.managedByOwner'));
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
