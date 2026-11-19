// The sheet's leave guard: the token field is the only draft, so Back asks
// Keep editing / Discard while text is typed and a connect has not taken it.
// The dismissal a landed connect owns must never ask.

import { beforeEach, describe, expect, it } from 'vitest';

import { i18n } from '@/i18n';
import { act } from '@/test/renderer';

import {
  confirmMock,
  formProps,
  leave,
  mountForm,
  preventRemoveMock,
  reportDirty,
  resetSheetMocks,
  routerMock,
} from './bitbucket-connect-sheet.test-helpers';

beforeEach(resetSheetMocks);

describe('BitbucketConnectSheet leave guard', () => {
  it('asks before a typed token is dropped, and only discards on the confirm', async () => {
    const root = await mountForm();
    await reportDirty(root, true);

    expect(preventRemoveMock.prevent).toBe(true);
    const { repeat } = await leave();

    // The Back is held while the sheet asks, so nothing leaves yet.
    expect(repeat).not.toHaveBeenCalled();
    const [request] = confirmMock.requests;
    expect(request?.title).toBe(i18n.t('common.discardChangesTitle'));
    expect(request?.message).toBe(i18n.t('common.discardChangesMessage'));
    expect(request?.confirmLabel).toBe(i18n.t('common.discard'));
    expect(request?.cancelLabel).toBe(i18n.t('common.keepEditing'));

    // Discard replays the intercepted Back rather than replacing the route.
    await act(async () => {
      request?.onConfirm();
      await Promise.resolve();
    });

    expect(repeat).toHaveBeenCalledTimes(1);
    expect(routerMock.back).not.toHaveBeenCalled();
  });

  it('leaves a clean sheet without asking', async () => {
    await mountForm();

    expect(preventRemoveMock.prevent).toBe(false);
    const { repeat } = await leave();

    expect(repeat).toHaveBeenCalledTimes(1);
    expect(confirmMock.requests).toHaveLength(0);
  });

  it('leaves without asking once a connect accepted the token', async () => {
    const root = await mountForm();
    await reportDirty(root, true);

    await act(async () => {
      formProps(root).onConnected();
      await Promise.resolve();
    });
    // The dismissal waits one task for the guard to disarm before popping.
    await act(async () => {
      const tick = Promise.withResolvers<undefined>();
      setTimeout(tick.resolve, 0);
      await tick.promise;
    });

    expect(routerMock.back).toHaveBeenCalledTimes(1);
    expect(preventRemoveMock.prevent).toBe(false);

    // The guard is disarmed for the leave the connect owns, so a Back the
    // navigator runs next is not held for a confirmation.
    const { repeat } = await leave();

    expect(repeat).toHaveBeenCalledTimes(1);
    expect(confirmMock.requests).toHaveLength(0);
  });
});
