/* eslint-disable max-lines -- one suite for the SSO approval: the handoff, the poll, its window, cancellation, and every late answer that must not land */
import {
  browser,
  buttonByLabel,
  hasButtonLabel,
  list,
  MACBOOK,
  mount,
  type PasskeysView,
  press,
  store,
  switchAccount,
  texts,
  toastSuccess,
  VERIFY_EMAIL,
  VERIFY_TITLE,
} from './passkeys-screen.test-helpers';
import { act } from '@/test/renderer';
import { waitFor } from '@/test/render-with-providers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const APPROVAL_URL = 'https://app.kilo.ai/passkey-approval?request=request-1';

/** The start answer for a request that is valid for `expiresInMs`. */
function approvalRequest(expiresInMs = 600_000) {
  return {
    status: 'approval-required' as const,
    requestId: 'request-1',
    approvalUrl: APPROVAL_URL,
    expiresAtMs: Date.now() + expiresInMs,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  store.rows = [MACBOOK];
  list.supported.mockReturnValue(true);
  list.queryFn.mockImplementation(() => ({ success: true, passkeys: store.rows }));
  list.register.mockResolvedValue({ status: 'ok' });
  // The account's domain requires SSO, so no code is sent and the browser
  // approval is the proof it accepts.
  list.requestCode.mockResolvedValue({ status: 'error', failure: 'sso-required' });
  list.startSso.mockResolvedValue(approvalRequest());
  list.collectSso.mockResolvedValue({ status: 'pending' });
  browser.open.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

/**
 * Mount with real timers (the list query needs macrotasks), then take the clock
 * so the approval's zero-delay steps and its poll interval are deterministic.
 */
async function mountWithClock() {
  const view = await mount();
  await waitFor(() => texts(view).includes('MacBook'));
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  return view;
}

/**
 * Drain the zero-delay work without letting the poll interval fire. One
 * millisecond per turn moves the clock past a timer that was scheduled from
 * inside the previous turn's continuation.
 */
async function settle(): Promise<void> {
  for (let index = 0; index < 6; index += 1) {
    // eslint-disable-next-line no-await-in-loop -- each turn must finish before the next advances the clock
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
  }
}

/** Let the poll interval elapse, with its requests draining as they answer. */
async function advancePoll(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000);
  });
  await settle();
}

/** Ask for the emailed code, which this account's domain refuses into SSO. */
async function requestProof(view: PasskeysView): Promise<void> {
  await press(buttonByLabel(view, 'Add a passkey'));
  await press(buttonByLabel(view, VERIFY_EMAIL));
  await settle();
}

/**
 * The browser approval for an account whose domain requires SSO: the app asks
 * for one bound request, opens the page, and polls until the browser leg
 * approves. Every answer belongs to the attempt that asked, so a cancellation,
 * a sign-out or a newer request cannot be affected by a late one.
 */
describe('PasskeysScreen SSO approval', () => {
  it('hands an SSO-only account from the refused code to the browser approval', async () => {
    const view = await mountWithClock();
    await requestProof(view);

    // The code was refused because the domain requires SSO, so the app starts
    // the one proof that domain accepts instead of showing a dead field.
    expect(list.requestCode).toHaveBeenCalledWith('person@example.com');
    expect(list.startSso).toHaveBeenCalledWith({ operation: 'enroll' });
    expect(browser.open).toHaveBeenCalledWith(APPROVAL_URL);
    expect(texts(view)).toContain('Waiting for approval...');
    expect(hasButtonLabel(view, 'Open the approval page')).toBe(true);
    view.unmount();
  });

  it('does not route a transient refusal into the browser approval', async () => {
    list.requestCode.mockResolvedValue({ status: 'error', failure: 'retryable' });
    const view = await mountWithClock();
    await requestProof(view);

    // Nothing named the domain, so the browser would fail the same way: the
    // panel keeps the proof choices and names the retry.
    expect(list.startSso).not.toHaveBeenCalled();
    expect(browser.open).not.toHaveBeenCalled();
    expect(texts(view)).toContain('Could not verify. Try again.');
    expect(hasButtonLabel(view, VERIFY_EMAIL)).toBe(true);
    view.unmount();
  });

  it('creates the passkey with the grant the browser leg minted', async () => {
    list.collectSso.mockResolvedValueOnce({ status: 'pending' }).mockResolvedValueOnce({
      status: 'authorized',
      authorization: 'sso-grant-1',
      expiresAtMs: Date.now() + 300_000,
    });
    const view = await mountWithClock();
    await requestProof(view);

    // The first poll found no approval yet; the next one, after the interval,
    // carries the grant into the same registration call the other proofs use.
    expect(list.collectSso).toHaveBeenCalledTimes(1);
    expect(list.register).not.toHaveBeenCalled();
    await advancePoll();

    expect(list.collectSso).toHaveBeenCalledTimes(2);
    expect(list.register).toHaveBeenCalledWith({ managementAuthorization: 'sso-grant-1' });
    await waitFor(() => toastSuccess.mock.calls.length > 0);
    expect(toastSuccess).toHaveBeenCalledWith('Passkey added.');
    view.unmount();
  });

  it('names an expired approval and starts a new request on Retry', async () => {
    list.startSso.mockResolvedValue(approvalRequest(0));
    const view = await mountWithClock();
    await requestProof(view);

    // The request's own window ended before the browser approved. Nothing was
    // collected, and the panel says so with a retry that is a real request.
    expect(list.collectSso).not.toHaveBeenCalled();
    expect(texts(view)).toContain('That approval expired or was cancelled. Try again.');

    await press(buttonByLabel(view, 'Retry'));
    await settle();
    expect(list.startSso).toHaveBeenCalledTimes(2);
    view.unmount();
  });

  it('stops polling when the approval is cancelled', async () => {
    const view = await mountWithClock();
    await requestProof(view);
    expect(list.collectSso).toHaveBeenCalledTimes(1);

    await press(buttonByLabel(view, 'Cancel'));
    await advancePoll();
    await advancePoll();

    // A cancelled attempt owns nothing any more: its page is closed with the
    // API that opened it, and no further poll or write happens.
    expect(browser.dismiss).toHaveBeenCalledWith('auth-session');
    expect(list.collectSso).toHaveBeenCalledTimes(1);
    expect(list.register).not.toHaveBeenCalled();
    expect(texts(view)).not.toContain(VERIFY_TITLE);
    view.unmount();
  });

  it('ignores a grant that arrives after the account changed', async () => {
    const pendingCollect = Promise.withResolvers<unknown>();
    list.collectSso.mockReturnValue(pendingCollect.promise);
    const view = await mountWithClock();
    await requestProof(view);
    expect(list.collectSso).toHaveBeenCalledTimes(1);

    await switchAccount({ userId: 'user-2', email: 'other@example.com' });
    expect(browser.dismiss).toHaveBeenCalledWith('auth-session');
    await act(() => {
      pendingCollect.resolve({
        status: 'authorized',
        authorization: 'sso-grant-1',
        expiresAtMs: Date.now() + 300_000,
      });
    });
    await settle();

    // The grant belongs to the account that started it, so it cannot create a
    // credential for the account now on screen.
    expect(list.register).not.toHaveBeenCalled();
    expect(texts(view)).not.toContain(VERIFY_TITLE);
    view.unmount();
  });

  it('ignores a grant that arrives after the screen is gone', async () => {
    const pendingCollect = Promise.withResolvers<unknown>();
    list.collectSso.mockReturnValue(pendingCollect.promise);
    const view = await mountWithClock();
    await requestProof(view);

    view.unmount();
    expect(browser.dismiss).toHaveBeenCalledWith('auth-session');
    await act(() => {
      pendingCollect.resolve({
        status: 'authorized',
        authorization: 'sso-grant-1',
        expiresAtMs: Date.now() + 300_000,
      });
    });
    await settle();

    expect(list.register).not.toHaveBeenCalled();
  });

  it('starts one request when Retry is pressed twice', async () => {
    list.startSso.mockResolvedValueOnce({ status: 'error', failure: 'expired' });
    const view = await mountWithClock();
    await requestProof(view);
    expect(list.startSso).toHaveBeenCalledTimes(1);

    const retry = buttonByLabel(view, 'Retry');
    await act(() => {
      (retry.props.onPress as () => void)();
      (retry.props.onPress as () => void)();
    });
    await settle();

    // The second tap found the first step already pending, so only one new
    // request was bound.
    expect(list.startSso).toHaveBeenCalledTimes(2);
    view.unmount();
  });

  it('names a browser that refuses to open and keeps the page reachable', async () => {
    browser.open.mockRejectedValue(new Error('no browser'));
    const view = await mountWithClock();
    await requestProof(view);

    // The rejection is answered where the page is offered, so nothing stays
    // unhandled and the same button is the retry.
    expect(texts(view)).toContain('Single sign-on approval is unavailable right now. Try again.');
    expect(hasButtonLabel(view, 'Open the approval page')).toBe(true);
    expect(list.register).not.toHaveBeenCalled();
    view.unmount();
  });

  it('returns to the proof choices when the start rejects', async () => {
    list.startSso.mockRejectedValue(new Error('network down'));
    const view = await mountWithClock();
    await requestProof(view);

    expect(texts(view)).toContain('Could not verify. Try again.');
    expect(hasButtonLabel(view, VERIFY_EMAIL)).toBe(true);
    expect(list.register).not.toHaveBeenCalled();
    view.unmount();
  });

  it('returns to the proof choices when the device proof could not be read', async () => {
    // The admission read behind the start already showed its own message, so
    // the panel offers the choices again instead of a second explanation.
    list.startSso.mockResolvedValue({ status: 'error', failure: 'reported' });
    const view = await mountWithClock();
    await requestProof(view);

    expect(list.startSso).toHaveBeenCalledTimes(1);
    expect(browser.open).not.toHaveBeenCalled();
    expect(hasButtonLabel(view, VERIFY_EMAIL)).toBe(true);
    view.unmount();
  });

  it('names a rejected poll and keeps the approval page reachable', async () => {
    list.collectSso.mockRejectedValue(new Error('offline'));
    const view = await mountWithClock();
    await requestProof(view);

    expect(texts(view)).toContain('Single sign-on approval is unavailable right now. Try again.');
    expect(hasButtonLabel(view, 'Retry')).toBe(true);
    expect(hasButtonLabel(view, 'Open the approval page')).toBe(true);
    view.unmount();
  });

  it('closes the approval page before creating the credential', async () => {
    const pageStillPresented = Promise.withResolvers<unknown>();
    const order: string[] = [];
    // iOS keeps the page presented until the app closes it, even though the
    // browser call resolved; the close must land before the native sheet.
    browser.open.mockReturnValue(pageStillPresented.promise);
    browser.dismiss.mockImplementation(() => {
      order.push('dismiss');
    });
    list.register.mockImplementation(() => {
      order.push('register');
      return { status: 'ok' };
    });
    list.collectSso.mockResolvedValueOnce({
      status: 'authorized',
      authorization: 'sso-grant-1',
      expiresAtMs: Date.now() + 300_000,
    });
    const view = await mountWithClock();
    await requestProof(view);
    await waitFor(() => toastSuccess.mock.calls.length > 0);

    expect(order).toEqual(['dismiss', 'register']);
    expect(browser.dismiss).toHaveBeenCalledWith('auth-session');
    expect(list.register).toHaveBeenCalledWith({ managementAuthorization: 'sso-grant-1' });
    view.unmount();
  });

  it('does not let a cancelled attempt close the page a newer attempt opened', async () => {
    const leftoverCollect = Promise.withResolvers<unknown>();
    list.collectSso.mockReturnValueOnce(leftoverCollect.promise);
    const view = await mountWithClock();
    await requestProof(view);
    expect(browser.open).toHaveBeenCalledTimes(1);

    await press(buttonByLabel(view, 'Cancel'));
    expect(browser.dismiss).toHaveBeenCalledTimes(1);

    // The next attempt owns its own page.
    await requestProof(view);
    expect(browser.open).toHaveBeenCalledTimes(2);

    // The cancelled attempt's grant arrives late. It authorizes nothing, and it
    // cannot close the page someone is using now.
    await act(() => {
      leftoverCollect.resolve({
        status: 'authorized',
        authorization: 'sso-grant-1',
        expiresAtMs: Date.now() + 300_000,
      });
    });
    await settle();

    expect(list.register).not.toHaveBeenCalled();
    expect(browser.dismiss).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it('names a lost approval and offers a reachable retry', async () => {
    list.collectSso.mockResolvedValue({ status: 'error', failure: 'expired' });
    const view = await mountWithClock();
    await requestProof(view);

    expect(texts(view)).toContain('That approval expired or was cancelled. Try again.');
    expect(hasButtonLabel(view, 'Retry')).toBe(true);
    expect(hasButtonLabel(view, 'Open the approval page')).toBe(true);
    view.unmount();
  });
});
