import { describe, expect, it } from 'vitest';

import { createVoiceInputController } from './voice-input-controller';
import {
  build,
  flushAsync,
  makeResult,
  recordEvents,
  sessionCalls,
  START_OPTIONS,
} from './voice-input-engine-dispatch-test-helpers';
import { BOTH_ENGINES_FAILED_CODE } from './voice-input-engine-mode';

describe('createDispatchingVoiceInputNative - device primary (gateway as fallback)', () => {
  it('starts the device recogniser first and never runs the gateway on success', () => {
    const { dispatch, gateway, os } = build(true, false);
    const events = recordEvents(dispatch);

    dispatch.start(START_OPTIONS);
    dispatch.stop();
    os.emit('result', makeResult('hello from the device'));
    os.emit('end', null);

    expect(os.calls).toContain('start:en-US');
    expect(os.calls).toContain('stop');
    // The gateway was subscribed for the session but never ran.
    expect(sessionCalls(gateway)).toEqual([]);
    expect(events.results).toEqual([makeResult('hello from the device')]);
    expect(events.errors).toEqual([]);
  });

  it('a failing device recogniser falls back to the gateway and returns its transcript', async () => {
    const { dispatch, gateway, os } = build(true, false);
    const events = recordEvents(dispatch);

    dispatch.start(START_OPTIONS);
    os.emit('error', { error: 'network', message: 'offline' });
    os.emit('end', null);
    await flushAsync();

    expect(events.errors).toEqual([]);
    expect(gateway.calls).toContain('start:en-US');

    dispatch.stop();
    gateway.emit('result', makeResult('hello from the gateway'));
    gateway.emit('end', null);

    expect(events.results).toEqual([makeResult('hello from the gateway')]);
    expect(events.errors).toEqual([]);
    expect(events.ends).toBe(1);
  });

  it('a lead failure after the fallback gateway died produces exactly ONE voice-engines-failed error', () => {
    const { dispatch, gateway, os } = build(true, false);
    const events = recordEvents(dispatch);

    dispatch.start(START_OPTIONS);
    os.emit('error', { error: 'network', message: 'offline' });
    os.emit('end', null);
    gateway.emit('error', { error: 'gateway-unreachable', message: 'boom' });
    gateway.emit('end', null);
    // The fallback died before it ran: the session re-armed on the device
    // recogniser, with no error and no end. The repeated take fails there
    // too — both engines have now failed, and one combined message says so.
    expect(events.errors).toEqual([]);
    expect(events.ends).toBe(0);
    os.emit('error', { error: 'network', message: 'offline again' });
    os.emit('end', null);

    expect(events.errors).toHaveLength(1);
    expect(events.errors[0]?.error).toBe(BOTH_ENGINES_FAILED_CODE);
    expect(events.ends).toBe(1);
  });

  it('a fallback gateway blocked by its own configuration reports that actionable error, not the combined retryable one', () => {
    // No model chosen: retrying cannot help, so the message must name the
    // fix (open the transcription settings), not a generic "try again".
    const noModel = build(true, false);
    const noModelEvents = recordEvents(noModel.dispatch);
    noModel.dispatch.start(START_OPTIONS);
    noModel.os.emit('error', { error: 'network', message: 'offline' });
    noModel.os.emit('end', null);
    noModel.gateway.emit('error', { error: 'gateway-no-model', message: 'no model chosen' });
    noModel.gateway.emit('end', null);
    expect(noModelEvents.errors).toEqual([
      { error: 'gateway-no-model', message: 'no model chosen' },
    ]);
    expect(noModelEvents.ends).toBe(1);

    // Signed out: the sign-in message is the honest, actionable one.
    const signedOut = build(true, false);
    const signedOutEvents = recordEvents(signedOut.dispatch);
    signedOut.dispatch.start(START_OPTIONS);
    signedOut.os.emit('error', { error: 'network', message: 'offline' });
    signedOut.os.emit('end', null);
    signedOut.gateway.emit('error', { error: 'gateway-auth', message: '401' });
    signedOut.gateway.emit('end', null);
    expect(signedOutEvents.errors).toEqual([{ error: 'gateway-auth', message: '401' }]);
    expect(signedOutEvents.ends).toBe(1);
  });

  it('a nomatch from the device recogniser is no-speech content, not an engine failure', () => {
    const { dispatch, gateway, os } = build(true, false);
    const events = recordEvents(dispatch);

    dispatch.start(START_OPTIONS);
    os.emit('nomatch', null);
    os.emit('end', null);

    expect(events.errors).toEqual([]);
    expect(sessionCalls(gateway)).toEqual([]);
    expect(events.ends).toBe(1);
  });

  it('an unavailable device recogniser makes the gateway the sole engine with direct errors', () => {
    const { dispatch, gateway, os } = build(true, false, false);
    const events = recordEvents(dispatch);

    expect(dispatch.isRecognitionAvailable()).toBe(true);
    dispatch.start(START_OPTIONS);
    dispatch.stop();
    gateway.emit('error', { error: 'gateway-unreachable', message: 'boom' });
    gateway.emit('end', null);

    expect(gateway.calls).toContain('start:en-US');
    expect(events.errors).toEqual([{ error: 'gateway-unreachable', message: 'boom' }]);
    expect(events.ends).toBe(1);
    expect(sessionCalls(os)).toEqual([]);
  });

  it('a live session handed to the gateway announces exactly one directed fell-back event', async () => {
    const { dispatch, gateway, os } = build(true, false);
    const events = recordEvents(dispatch);

    dispatch.start(START_OPTIONS);
    os.emit('start', null);
    os.emit('error', { error: 'network', message: 'offline' });
    os.emit('end', null);
    await flushAsync();
    // The announcement waits for the gateway to actually go live: a hand-off
    // is only named once the other engine is listening.
    gateway.emit('start', null);

    expect(events.fellBacks).toEqual([{ from: 'os', to: 'gateway' }]);
    // Consent invariant holds on this direction too: the gateway fallback
    // runs with the options the session started with, unmodified.
    expect(gateway.lastStartOptions).toEqual(START_OPTIONS);

    dispatch.stop();
    gateway.emit('result', makeResult('again'));
    gateway.emit('end', null);
    expect(events.ends).toBe(1);
  });

  it('a device-recogniser failure before the session went live falls back without the announcement', async () => {
    const { dispatch, gateway, os } = build(true, false);
    const events = recordEvents(dispatch);

    dispatch.start(START_OPTIONS);
    os.emit('error', { error: 'network', message: 'offline' });
    os.emit('end', null);
    await flushAsync();

    expect(events.fellBacks).toEqual([]);
    expect(gateway.calls).toContain('start:en-US');
  });

  it('routes permissions and capabilities to the device recogniser as the lead', async () => {
    const { dispatch, gateway, os } = build(true, false);

    await dispatch.getPermissions();
    expect(dispatch.supportsOnDevice()).toBe(true);
    expect(dispatch.supportsContinuousRecognition()).toBe(true);

    expect(os.calls).toContain('getPermissions');
    expect(gateway.calls).not.toContain('getPermissions');
  });
});

describe('controller + dispatcher: the fallback returns a transcript through the real session', () => {
  it('gateway-primary: a failed gateway upload yields the device transcript with no error', async () => {
    const { dispatch, gateway, os } = build(true, true);
    const controller = createVoiceInputController(dispatch);
    const drafts: string[] = [];
    const feedback: unknown[] = [];

    const started = await controller.start({
      baseDraft: 'note: ',
      languageTag: 'en-US',
      onDraftChange: (d): void => {
        drafts.push(d);
      },
      onFeedback: f => {
        feedback.push(f);
      },
      owner: 'tester',
      requiresOnDeviceRecognition: false,
    });
    expect(started).toBe(true);

    // The gateway fails while the user is still speaking: the fallback
    // carries the session and its transcript lands with no error.
    gateway.emit('error', { error: 'gateway-unreachable', message: 'boom' });
    gateway.emit('end', null);
    await flushAsync();
    os.emit('start', null);
    os.emit('result', makeResult('hello'));
    os.emit('end', null);
    const stopped = controller.stop('tester');

    await expect(stopped).resolves.toBe(true);
    expect(drafts).toEqual(['note: hello']);
    expect(feedback).toEqual([]);
    expect(controller.getSnapshot().status).toBe('idle');
  });

  it('gateway-primary: a live session losing its take to a failed upload shows ONE direction-aware toast', async () => {
    const { dispatch, gateway, os } = build(true, true);
    const controller = createVoiceInputController(dispatch);
    const feedback: { message: string; retryable: boolean }[] = [];

    await controller.start({
      baseDraft: '',
      languageTag: 'en-US',
      onDraftChange: (): void => undefined,
      onFeedback: f => {
        feedback.push({ message: f.message, retryable: f.retryable });
      },
      owner: 'tester',
      requiresOnDeviceRecognition: false,
    });
    gateway.emit('start', null);
    // The gateway fails while the user is still speaking — the take is lost,
    // so the hand-off announces itself once, direction-aware.
    gateway.emit('error', { error: 'gateway-unreachable', message: 'boom' });
    gateway.emit('end', null);
    await flushAsync();
    os.emit('start', null);
    os.emit('result', makeResult('again'));
    os.emit('end', null);
    const stopped = controller.stop('tester');

    await expect(stopped).resolves.toBe(true);
    expect(feedback).toHaveLength(1);
    expect(feedback[0]?.retryable).toBe(true);
    expect(feedback[0]?.message).toContain('Gateway transcription unavailable');
    expect(feedback[0]?.message).toContain("device's recogniser");
    expect(feedback[0]?.message).toContain('say it again');
  });

  it('device-primary: a live session losing its take to a failed recogniser shows ONE direction-aware toast', async () => {
    const { dispatch, gateway, os } = build(true, false);
    const controller = createVoiceInputController(dispatch);
    const feedback: { message: string; retryable: boolean }[] = [];

    await controller.start({
      baseDraft: '',
      languageTag: 'en-US',
      onDraftChange: (): void => undefined,
      onFeedback: f => {
        feedback.push({ message: f.message, retryable: f.retryable });
      },
      owner: 'tester',
      requiresOnDeviceRecognition: false,
    });
    os.emit('start', null);
    os.emit('error', { error: 'network', message: 'offline' });
    os.emit('end', null);
    gateway.emit('start', null);
    gateway.emit('result', makeResult('again'));
    const stopped = controller.stop('tester');
    gateway.emit('end', null);

    await expect(stopped).resolves.toBe(true);
    expect(feedback).toHaveLength(1);
    expect(feedback[0]?.retryable).toBe(true);
    expect(feedback[0]?.message).toContain('Device recognition failed');
    expect(feedback[0]?.message).toContain('Kilo gateway');
    expect(feedback[0]?.message).toContain('say it again');
  });

  it('gateway-primary: an upload failure after the stop hands the session to the device recogniser', async () => {
    const { dispatch, gateway, os } = build(true, true);
    const controller = createVoiceInputController(dispatch);
    const feedback: { message: string; retryable: boolean }[] = [];
    let draft = '';

    await controller.start({
      baseDraft: '',
      languageTag: 'en-US',
      onDraftChange: (next: string): void => {
        draft = next;
      },
      onFeedback: f => {
        feedback.push({ message: f.message, retryable: f.retryable });
      },
      owner: 'tester',
      requiresOnDeviceRecognition: false,
    });
    gateway.emit('start', null);
    const stopped = controller.stop('tester');
    // The real gateway engine emits `transcribing` synchronously on stop:
    // the recording is sealed and the upload begins — and fails.
    gateway.emit('transcribing', null);
    gateway.emit('error', { error: 'gateway-unreachable', message: 'boom' });
    gateway.emit('end', null);
    await flushAsync();

    // The sealed take died with the failed upload: the hand-off is announced
    // right at the failure — the pill returns to Listening and the ask to
    // repeat the take is on screen whether the recogniser takes over or the
    // device refuses it — and the session continues on the device recogniser.
    expect(feedback).toHaveLength(1);
    expect(feedback[0]?.retryable).toBe(true);
    expect(feedback[0]?.message).toContain('say it again');
    expect(os.calls.filter(call => call.startsWith('start'))).toEqual(['start:en-US']);

    os.emit('start', null);
    expect(controller.getSnapshot().status).toBe('listening');
    expect(feedback).toHaveLength(1);
    expect(feedback[0]?.retryable).toBe(true);
    expect(feedback[0]?.message).toContain('say it again');

    os.emit('result', makeResult('repeated words'));
    os.emit('end', null);
    await expect(stopped).resolves.toBe(true);
    expect(draft).toContain('repeated words');
  });

  it('gateway-primary: both engines failing reports ONE actionable message', async () => {
    const { dispatch, gateway, os } = build(true, true);
    const controller = createVoiceInputController(dispatch);
    const feedback: { message: string; retryable: boolean }[] = [];

    await controller.start({
      baseDraft: '',
      languageTag: 'en-US',
      onDraftChange: (): void => undefined,
      onFeedback: f => {
        feedback.push({ message: f.message, retryable: f.retryable });
      },
      owner: 'tester',
      requiresOnDeviceRecognition: false,
    });

    // The gateway fails while the user is still speaking; the fallback
    // attempt dies too, so the session is re-armed on the gateway. The
    // user's repeated take fails on the lead as well — both engines have
    // now failed in this session, so one combined message names both. The
    // combined message terminalizes the session, so the later stop is a
    // no-op that reports success.
    gateway.emit('error', { error: 'gateway-unreachable', message: 'boom' });
    gateway.emit('end', null);
    await flushAsync();
    os.emit('error', { error: 'client', message: 'device boom' });
    os.emit('end', null);
    gateway.emit('error', { error: 'gateway-unreachable', message: 'boom again' });
    gateway.emit('end', null);
    const stopped = controller.stop('tester');

    await expect(stopped).resolves.toBe(true);
    expect(feedback).toHaveLength(1);
    expect(feedback[0]?.retryable).toBe(true);
    expect(feedback[0]?.message).toContain('Kilo gateway');
    expect(feedback[0]?.message).toContain('this device');
  });
});
