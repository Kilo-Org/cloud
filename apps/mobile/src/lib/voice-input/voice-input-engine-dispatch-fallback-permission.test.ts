import { describe, expect, it } from 'vitest';

import { createVoiceInputController } from './voice-input-controller';
import { createDispatchingVoiceInputNative } from './voice-input-engine-dispatch';
import {
  build,
  buildWithPermissions,
  createFakeNative,
  DENIED,
  flushAsync,
  GRANTED,
  makeResult,
  recordEvents,
  sessionCalls,
  START_OPTIONS,
} from './voice-input-engine-dispatch-test-helpers';
import { resolveVoiceInputEngineMode } from './voice-input-engine-mode';

/**
 * The fallback engine holds a permission the lead engine's grant never
 * covered: a gateway-primary user granted expo-audio's microphone permission
 * (the gateway engine's probe), not the OS recogniser's separate speech
 * permission. The dispatcher owns both engines, so when a session falls
 * back it must ask before starting — and a denial must not end the session
 * on a false microphone error either: the lead engine just recorded with its
 * own microphone, so the session returns to the lead and keeps listening,
 * exactly like any other recogniser this device will not let run.
 */
describe('createDispatchingVoiceInputNative - fallback permissions', () => {
  it('requests the fallback recogniser permission before starting it', async () => {
    const { dispatch, gateway, os } = build(true, true);
    const events = recordEvents(dispatch);

    dispatch.start(START_OPTIONS);
    gateway.emit('error', { error: 'gateway-unreachable', message: 'boom' });
    gateway.emit('end', null);
    await flushAsync();

    expect(os.calls).toContain('requestPermissions');
    expect(os.calls).toContain('start:en-US');
    os.emit('result', makeResult('hello from the device'));
    os.emit('end', null);

    expect(events.results).toEqual([makeResult('hello from the device')]);
    expect(events.errors).toEqual([]);
    expect(events.ends).toBe(1);
  });

  it('requests the fallback gateway permission before starting it', async () => {
    // Both directions: the dispatcher owns the gateway engine too, so the
    // gateway fallback gets its permission asked for (granted in practice —
    // the device recogniser just used the same microphone).
    const { dispatch, gateway, os } = build(true, false);
    const events = recordEvents(dispatch);

    dispatch.start(START_OPTIONS);
    os.emit('error', { error: 'network', message: 'offline' });
    os.emit('end', null);
    await flushAsync();

    expect(gateway.calls).toContain('requestPermissions');
    expect(gateway.calls).toContain('start:en-US');
    expect(events.errors).toEqual([]);
  });

  it('a fallback permission denial returns the session to the lead engine, not a false microphone error', async () => {
    // The lead engine just recorded with its own microphone: ending the
    // session on "Microphone access is off" blames hardware that is on, and
    // the open-settings CTA cannot fix a recogniser the device restricts.
    // The session keeps listening on the lead instead — the re-arm contract
    // for a recogniser that cannot run on this device.
    const { dispatch, gateway, os } = buildWithPermissions({
      enabled: true,
      primary: true,
      osPermission: DENIED,
      gatewayPermission: GRANTED,
    });
    const events = recordEvents(dispatch);

    dispatch.start(START_OPTIONS);
    gateway.emit('error', { error: 'gateway-unreachable', message: 'boom' });
    gateway.emit('end', null);
    await flushAsync();

    expect(events.errors).toEqual([]);
    expect(events.ends).toBe(0);
    expect(sessionCalls(os)).toEqual([]);
    expect(sessionCalls(gateway)).toEqual(['start:en-US', 'start:en-US']);
  });

  it('a fallback not-allowed error surfaces as-is instead of the combined retryable one', async () => {
    // The recogniser refused even with its permission granted: the settings
    // CTA is the fix that works, so the raw code beats the dead retry loop.
    const { dispatch, gateway, os } = build(true, true);
    const events = recordEvents(dispatch);

    dispatch.start(START_OPTIONS);
    gateway.emit('error', { error: 'gateway-unreachable', message: 'boom' });
    gateway.emit('end', null);
    await flushAsync();
    os.emit('error', { error: 'not-allowed', message: 'speech permission' });
    os.emit('end', null);

    expect(events.errors).toEqual([{ error: 'not-allowed', message: 'speech permission' }]);
    expect(events.ends).toBe(1);
  });

  it('an abort while the fallback permission is pending ends the session without starting the fallback', async () => {
    const { dispatch, gateway, os } = build(true, true);
    const events = recordEvents(dispatch);

    dispatch.start(START_OPTIONS);
    gateway.emit('error', { error: 'gateway-unreachable', message: 'boom' });
    gateway.emit('end', null);
    dispatch.abort();
    await flushAsync();

    expect(os.calls.filter(call => call.startsWith('start'))).toEqual([]);
    expect(events.errors).toEqual([]);
    expect(events.ends).toBe(1);
  });

  it('a stop while the fallback permission is pending ends the session without starting the fallback', async () => {
    const { dispatch, gateway, os } = build(true, true);
    const events = recordEvents(dispatch);

    dispatch.start(START_OPTIONS);
    gateway.emit('error', { error: 'gateway-unreachable', message: 'boom' });
    gateway.emit('end', null);
    dispatch.stop();
    await flushAsync();

    expect(os.calls.filter(call => call.startsWith('start'))).toEqual([]);
    expect(events.errors).toEqual([]);
    expect(events.ends).toBe(1);
  });

  it('gateway-primary: a fallback permission denial keeps the session live and the second lead failure is the one combined message', async () => {
    // Controller-level, mirroring the on-device sequence: the session went
    // live, the gateway failed, the device recogniser's permission is
    // denied. The lost take is announced (the direction toast), the denial
    // does not end the session on a false mic-off message, and the pill
    // stays on Listening — the user's retry has somewhere to land. Their
    // repeated take fails on the lead too, and exactly one retryable message
    // names both engines and points at Preferences — never two bare errors.
    const os = createFakeNative('os', true, DENIED);
    const gateway = createFakeNative('gateway', true, GRANTED);
    const dispatch = createDispatchingVoiceInputNative(os, gateway, () =>
      resolveVoiceInputEngineMode(true, true)
    );
    const controller = createVoiceInputController(dispatch);
    const feedback: { action: string; message: string; retryable: boolean }[] = [];

    await controller.start({
      baseDraft: '',
      languageTag: 'en-US',
      onDraftChange: (): void => undefined,
      onFeedback: f => {
        feedback.push({ action: f.action, message: f.message, retryable: f.retryable });
      },
      owner: 'tester',
      requiresOnDeviceRecognition: false,
    });
    gateway.emit('start', null);

    gateway.emit('error', { error: 'gateway-unreachable', message: 'boom' });
    gateway.emit('end', null);
    await flushAsync();

    // The lost take is announced the moment the lead fails; the denial
    // returned the session to the gateway (the recogniser never ran), so the
    // composer still says Listening… and the repeat has somewhere to land.
    expect(feedback).toHaveLength(1);
    expect(feedback[0]?.retryable).toBe(true);
    expect(feedback[0]?.message).toBe(
      "Gateway transcription unavailable — using your device's recogniser. Please say it again."
    );
    expect(sessionCalls(os)).toEqual([]);

    // The user repeats the take; the gateway is still down: both engines
    // have failed in this session, so one combined message says so.
    gateway.emit('error', { error: 'gateway-unreachable', message: 'boom again' });
    gateway.emit('end', null);
    await flushAsync();

    expect(feedback).toHaveLength(2);
    expect(feedback[1]?.action).toBe('none');
    expect(feedback[1]?.retryable).toBe(true);
    expect(feedback[1]?.message).toBe(
      'Voice transcription failed on the Kilo gateway and on this device. ' +
        'Check your connection, or change your transcription settings in Preferences, then try again.'
    );
  });
});
