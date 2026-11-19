/* eslint-disable max-lines -- one suite for the verification panel: proof choices, every refusal it can show, the rejected boundaries, and the add flow it gates */
import {
  buttonByLabel,
  emptyDescription,
  first,
  hasButtonLabel,
  list,
  MACBOOK,
  mount,
  nodes,
  press,
  store,
  texts,
  toastError,
  toastSuccess,
  UNNAMED,
  VERIFY_EMAIL,
  VERIFY_PASSKEY,
  VERIFY_TITLE,
  verifyWithCode,
} from './passkeys-screen.test-helpers';
import { act } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@/test/render-with-providers';

beforeEach(() => {
  vi.clearAllMocks();
  store.rows = [MACBOOK, UNNAMED];
  list.supported.mockReturnValue(true);
  list.queryFn.mockImplementation(() => ({ success: true, passkeys: store.rows }));
  list.deleteFn.mockResolvedValue(undefined);
  list.renameFn.mockResolvedValue(undefined);
  list.register.mockResolvedValue({ status: 'ok' });
  list.requestCode.mockResolvedValue({
    status: 'sent',
    challengeId: '3f1c1a9e-1c1a-4b6e-9f0e-1d2c3b4a5e6f',
  });
  list.authorizeCode.mockResolvedValue({
    status: 'authorized',
    authorization: 'auth-1',
    expiresAtMs: Date.now() + 300_000,
  });
  list.authorizeTicket.mockResolvedValue({
    status: 'authorized',
    authorization: 'auth-1',
    expiresAtMs: Date.now() + 300_000,
  });
  list.mintTicket.mockResolvedValue({ status: 'ok', ticket: 'ticket-1' });
});

/**
 * The screen's fresh-primary-verification panel: every management operation is
 * preceded by proof given in the app, and every refusal it can produce lands
 * somewhere the person can act on.
 */
describe('PasskeysScreen verification', () => {
  it('offers both proofs when the account has a passkey', async () => {
    const view = await mount();
    await waitFor(() => texts(view).includes('MacBook'));

    await press(buttonByLabel(view, 'Add a passkey'));
    await waitFor(() => texts(view).includes(VERIFY_TITLE));

    expect(hasButtonLabel(view, VERIFY_PASSKEY)).toBe(true);
    expect(hasButtonLabel(view, VERIFY_EMAIL)).toBe(true);
    // Nothing was requested or written before the person chose a proof.
    expect(list.requestCode).not.toHaveBeenCalled();
    expect(list.register).not.toHaveBeenCalled();
    view.unmount();
  });

  it('offers only the emailed code to an account that has no passkey yet', async () => {
    store.rows = [];
    const view = await mount();
    await waitFor(() => nodes(view, 'EmptyState').length === 1);

    await press(buttonByLabel(view, 'Add a passkey'));
    await waitFor(() => texts(view).includes(VERIFY_TITLE));

    // There is no passkey to assert, so the code is the one working proof.
    expect(hasButtonLabel(view, VERIFY_PASSKEY)).toBe(false);
    expect(hasButtonLabel(view, VERIFY_EMAIL)).toBe(true);
    // The panel sits above the same empty state, from the top of the body: the
    // screen does not swap the state out while the proof is chosen.
    expect(nodes(view, 'EmptyState')).toHaveLength(1);
    expect(first(view, 'EmptyState').props.placement).toBe('top');
    await press(buttonByLabel(view, 'Cancel'));
    await waitFor(() => first(view, 'EmptyState').props.placement === 'center');
    expect(nodes(view, 'EmptyState')).toHaveLength(1);
    view.unmount();
  });

  it('authorizes with a passkey assertion and creates the credential with it', async () => {
    // The account has a credential to assert, so the passkey proof is offered.
    store.rows = [MACBOOK];
    const view = await mount();
    await waitFor(() => texts(view).includes('MacBook'));

    await press(buttonByLabel(view, 'Add a passkey'));
    await press(buttonByLabel(view, VERIFY_PASSKEY));
    await waitFor(() => toastSuccess.mock.calls.length > 0);

    // The ceremony runs to a ticket; the session is not replaced by it.
    expect(list.mintTicket).toHaveBeenCalledOnce();
    expect(list.authorizeTicket).toHaveBeenCalledWith({
      operation: 'enroll',
      ticket: 'ticket-1',
    });
    expect(list.register).toHaveBeenCalledWith({ managementAuthorization: 'auth-1' });
    expect(list.authorizeCode).not.toHaveBeenCalled();
    view.unmount();
  });

  it('keeps the code field when the code is refused, then accepts a corrected one', async () => {
    store.rows = [];
    list.authorizeCode.mockResolvedValueOnce({ status: 'error', failure: 'invalid-code' });
    const view = await mount();
    await waitFor(() => nodes(view, 'EmptyState').length === 1);

    await press(buttonByLabel(view, 'Add a passkey'));
    await verifyWithCode(view, '000000');
    // The field carries the refusal: the panel never renders a second copy.
    await waitFor(
      () => first(view, 'FormField').props.error === 'That code did not match. Try again.'
    );

    // The challenge survived the refusal: the same field is still there, and a
    // second submit reuses it rather than asking for another email.
    expect(nodes(view, 'FormField')).toHaveLength(1);
    expect(list.requestCode).toHaveBeenCalledOnce();
    const field = first(view, 'FormField');
    await act(() => {
      (field.props.onChangeText as (value: string) => void)('123456');
    });
    await press(buttonByLabel(view, 'Verify code'));
    await waitFor(() => toastSuccess.mock.calls.length > 0);

    expect(list.register).toHaveBeenCalledWith({ managementAuthorization: 'auth-1' });
    view.unmount();
  });

  it('accepts a corrected code after a queued submit sees a cleared field', async () => {
    store.rows = [];
    const view = await mount();
    await waitFor(() => nodes(view, 'EmptyState').length === 1);
    await press(buttonByLabel(view, 'Add a passkey'));
    await press(buttonByLabel(view, VERIFY_EMAIL));
    await waitFor(() => nodes(view, 'FormField').length === 1);
    const field = first(view, 'FormField');
    const changeCode = field.props.onChangeText as (value: string) => void;
    await act(() => {
      changeCode('123456');
    });
    const queuedSubmit = buttonByLabel(view, 'Verify code').props.onPress as () => void;
    await act(() => {
      changeCode(' ');
    });
    await act(() => {
      queuedSubmit();
    });
    expect(list.authorizeCode).not.toHaveBeenCalled();
    await act(() => {
      changeCode('123456');
    });
    await press(buttonByLabel(view, 'Verify code'));
    await waitFor(() => toastSuccess.mock.calls.length > 0);
    expect(list.authorizeCode).toHaveBeenCalledOnce();
    view.unmount();
  });

  it('names a spent attempt budget and offers a new code', async () => {
    store.rows = [];
    list.authorizeCode.mockResolvedValue({ status: 'error', failure: 'too-many-attempts' });
    const view = await mount();
    await waitFor(() => nodes(view, 'EmptyState').length === 1);

    await press(buttonByLabel(view, 'Add a passkey'));
    await verifyWithCode(view);
    await waitFor(
      () => first(view, 'FormField').props.error === 'Too many attempts. Send a new code.'
    );

    // Sending a new code is the next step, and it is a real request, not a
    // repeating submit against the spent one.
    await press(buttonByLabel(view, 'Resend code'));
    await waitFor(() => list.requestCode.mock.calls.length === 2);
    view.unmount();
  });

  it('writes nothing when the panel is cancelled', async () => {
    const view = await mount();
    await waitFor(() => texts(view).includes('MacBook'));

    await press(buttonByLabel(view, 'Add a passkey'));
    await press(buttonByLabel(view, 'Cancel'));

    expect(hasButtonLabel(view, VERIFY_EMAIL)).toBe(false);
    expect(list.register).not.toHaveBeenCalled();
    expect(list.requestCode).not.toHaveBeenCalled();
    expect(texts(view)).toContain('MacBook');
    view.unmount();
  });

  it('blocks with a localized next step when this sign-in cannot manage passkeys', async () => {
    store.rows = [];
    list.authorizeCode.mockResolvedValue({ status: 'error', failure: 'device-unsupported' });
    const view = await mount();
    await waitFor(() => nodes(view, 'EmptyState').length === 1);

    await press(buttonByLabel(view, 'Add a passkey'));
    await verifyWithCode(view);
    await waitFor(() =>
      texts(view).includes(
        "Passkeys can't be managed with this sign-in. Sign in again in the Kilo app."
      )
    );

    // Terminal for this credential: no proof is offered again, and the raw
    // server code never reaches the screen.
    expect(hasButtonLabel(view, 'Verify code')).toBe(false);
    expect(texts(view).join(' ')).not.toContain('PASSKEY_MANAGEMENT');
    expect(hasButtonLabel(view, 'Close')).toBe(true);
    view.unmount();
  });

  it('withdraws the passkey offer when this device has none for the account', async () => {
    store.rows = [MACBOOK];
    list.mintTicket.mockResolvedValue({ status: 'error', failure: 'no-passkey' });
    const view = await mount();
    await waitFor(() => texts(view).includes('MacBook'));

    await press(buttonByLabel(view, 'Add a passkey'));
    await press(buttonByLabel(view, VERIFY_PASSKEY));
    await waitFor(() =>
      texts(view).includes(
        'This device has no passkey for this account. Use an emailed code instead.'
      )
    );

    expect(hasButtonLabel(view, VERIFY_PASSKEY)).toBe(false);
    expect(hasButtonLabel(view, VERIFY_EMAIL)).toBe(true);
    view.unmount();
  });

  it('sends one code when the choice is pressed twice', async () => {
    store.rows = [];
    const view = await mount();
    await waitFor(() => nodes(view, 'EmptyState').length === 1);

    await press(buttonByLabel(view, 'Add a passkey'));
    const emailButton = buttonByLabel(view, VERIFY_EMAIL);
    await act(() => {
      (emailButton.props.onPress as () => void)();
      (emailButton.props.onPress as () => void)();
    });

    expect(list.requestCode).toHaveBeenCalledOnce();
    view.unmount();
  });

  it('asks for proof again when the server says the authorization is gone', async () => {
    store.rows = [];
    list.register.mockResolvedValueOnce({ status: 'error', failure: 'management-required' });
    const view = await mount();
    await waitFor(() => nodes(view, 'EmptyState').length === 1);

    await press(buttonByLabel(view, 'Add a passkey'));
    await verifyWithCode(view);
    await waitFor(() => texts(view).includes(VERIFY_EMAIL));

    // The refusal is answered by the panel, in the app, not by a raw code or a
    // browser instruction.
    expect(texts(view).join(' ')).not.toContain('PASSKEY_MANAGEMENT');
    await verifyWithCode(view);
    await waitFor(() => toastSuccess.mock.calls.length > 0);
    expect(list.register).toHaveBeenCalledTimes(2);
    view.unmount();
  });

  it('names an expired verification and asks for proof again', async () => {
    store.rows = [];
    list.register.mockResolvedValueOnce({ status: 'error', failure: 'authorization-invalid' });
    const view = await mount();
    await waitFor(() => nodes(view, 'EmptyState').length === 1);

    await press(buttonByLabel(view, 'Add a passkey'));
    await verifyWithCode(view);
    await waitFor(() => texts(view).includes('That verification expired. Verify again.'));
    view.unmount();
  });

  it('verifies in the app before adding, then refreshes the list', async () => {
    store.rows = [];
    const view = await mount();
    await waitFor(() => nodes(view, 'EmptyState').length === 1);

    // The Add control asks for fresh proof first: nothing is created on the tap.
    await press(buttonByLabel(view, 'Add a passkey'));
    await waitFor(() => texts(view).includes(VERIFY_TITLE));
    expect(list.register).not.toHaveBeenCalled();

    await verifyWithCode(view);
    await waitFor(() => toastSuccess.mock.calls.length > 0);

    expect(list.requestCode).toHaveBeenCalledWith('person@example.com');
    expect(list.authorizeCode).toHaveBeenCalledWith({
      operation: 'enroll',
      email: 'person@example.com',
      code: '123456',
      challengeId: '3f1c1a9e-1c1a-4b6e-9f0e-1d2c3b4a5e6f',
    });
    // The bearer alone is not proof: the credential is created with the
    // authorization the proof minted, which the server consumes.
    expect(list.register).toHaveBeenCalledWith({ managementAuthorization: 'auth-1' });
    expect(toastSuccess).toHaveBeenCalledWith('Passkey added.');
    expect(list.queryFn.mock.calls.length).toBeGreaterThan(1);
    view.unmount();
  });

  it('hides the Add control and names the reason on a device that cannot create passkeys', async () => {
    list.supported.mockReturnValue(false);
    const view = await mount();
    await waitFor(() => texts(view).includes('MacBook'));

    // The device can never create one, so the notice stands alone and the
    // existing passkeys still list.
    expect(texts(view)).toContain('This device cannot create passkeys.');
    expect(hasButtonLabel(view, 'Add a passkey')).toBe(false);
    expect(hasButtonLabel(view, 'Retry')).toBe(false);
    expect(texts(view)).toContain('Passkey');
    expect(nodes(view, 'KeyRound')).toHaveLength(2);
    view.unmount();
  });

  it('shows the unsupported notice instead of creation when there are no passkeys and the device cannot create them', async () => {
    store.rows = [];
    list.supported.mockReturnValue(false);
    const view = await mount();
    await waitFor(() => nodes(view, 'EmptyState').length === 1);

    const empty = first(view, 'EmptyState');
    // The creation hint would name the Add control this device cannot offer, so
    // the notice is the description and the state has no action at all.
    expect(emptyDescription(view)).toBe('This device cannot create passkeys.');
    expect(empty.props.action).toBeUndefined();
    expect(hasButtonLabel(view, 'Add a passkey')).toBe(false);
    view.unmount();
  });

  it('drops the Add control when the ceremony refuses as unsupported', async () => {
    store.rows = [];
    list.register.mockResolvedValue({ status: 'error', failure: 'unsupported' });
    const view = await mount();
    await waitFor(() => nodes(view, 'EmptyState').length === 1);

    await press(buttonByLabel(view, 'Add a passkey'));
    await verifyWithCode(view);
    await waitFor(() => !hasButtonLabel(view, 'Add a passkey'));

    // Non-retryable: no retry control, and no Add control that could only fail
    // the same way again. The notice replaces the hint the control annotated.
    expect(hasButtonLabel(view, 'Retry')).toBe(false);
    expect(emptyDescription(view)).toBe('This device cannot create passkeys.');
    view.unmount();
  });

  it('keeps the Add CTA and names the reason when creation fails retryably', async () => {
    store.rows = [];
    list.register.mockResolvedValue({ status: 'error', failure: 'failed' });
    const view = await mount();
    await waitFor(() => nodes(view, 'EmptyState').length === 1);

    await press(buttonByLabel(view, 'Add a passkey'));
    await verifyWithCode(view);
    await waitFor(() => texts(view).includes('Could not add a passkey. Try again.'));

    // Retryable: the same control starts a fresh attempt.
    expect(hasButtonLabel(view, 'Add a passkey')).toBe(true);
    view.unmount();
  });

  it('leaves the list unchanged and toasts when the creation sheet is cancelled', async () => {
    list.register.mockResolvedValue({ status: 'error', failure: 'cancelled' });
    const view = await mount();
    await waitFor(() => texts(view).includes('MacBook'));

    await press(buttonByLabel(view, 'Add a passkey'));
    await verifyWithCode(view);
    await waitFor(() => toastError.mock.calls.length > 0);

    expect(toastError).toHaveBeenCalledWith('Passkey creation was cancelled.');
    expect(texts(view)).toContain('MacBook');
    expect(texts(view)).toContain('Passkey');
    expect(nodes(view, 'KeyRound')).toHaveLength(2);
    view.unmount();
  });

  it('returns to the proof choices when the passkey boundary rejects', async () => {
    store.rows = [MACBOOK];
    // The request-token read behind the mint can reject; that must be a
    // retryable panel state, not an unhandled rejection.
    list.mintTicket.mockRejectedValue(new Error('keychain read failed'));
    const view = await mount();
    await waitFor(() => texts(view).includes('MacBook'));

    await press(buttonByLabel(view, 'Add a passkey'));
    await press(buttonByLabel(view, VERIFY_PASSKEY));
    await waitFor(() => texts(view).includes('Could not verify. Try again.'));

    expect(hasButtonLabel(view, VERIFY_EMAIL)).toBe(true);
    expect(list.register).not.toHaveBeenCalled();
    view.unmount();
  });

  it('returns to the proof choices when the code request rejects', async () => {
    store.rows = [];
    list.requestCode.mockRejectedValue(new Error('offline'));
    const view = await mount();
    await waitFor(() => nodes(view, 'EmptyState').length === 1);

    await press(buttonByLabel(view, 'Add a passkey'));
    await press(buttonByLabel(view, VERIFY_EMAIL));
    await waitFor(() => texts(view).includes('Could not verify. Try again.'));

    // The same choice is a working retry.
    expect(hasButtonLabel(view, VERIFY_EMAIL)).toBe(true);
    expect(list.register).not.toHaveBeenCalled();
    view.unmount();
  });

  it('keeps the code field usable when the mint rejects', async () => {
    store.rows = [];
    list.authorizeCode.mockRejectedValueOnce(new Error('admission read failed'));
    const view = await mount();
    await waitFor(() => nodes(view, 'EmptyState').length === 1);

    await press(buttonByLabel(view, 'Add a passkey'));
    await verifyWithCode(view);
    await waitFor(() => first(view, 'FormField').props.error === 'Could not verify. Try again.');

    // The challenge and the field survive a rejected boundary: the same code
    // can be submitted again, and this time the mint answers.
    expect(nodes(view, 'FormField')).toHaveLength(1);
    expect(list.requestCode).toHaveBeenCalledOnce();
    const field = first(view, 'FormField');
    await act(() => {
      (field.props.onChangeText as (value: string) => void)('123456');
    });
    await press(buttonByLabel(view, 'Verify code'));
    await waitFor(() => toastSuccess.mock.calls.length > 0);
    expect(list.register).toHaveBeenCalledWith({ managementAuthorization: 'auth-1' });
    view.unmount();
  });
});
