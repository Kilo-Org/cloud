import { describe, expect, it } from 'vitest';

import {
  build,
  flushAsync,
  makeResult,
  recordEvents,
  sessionCalls,
  START_OPTIONS,
} from './voice-input-engine-dispatch-test-helpers';

describe('createDispatchingVoiceInputNative - gateway primary post-stop hand-off', () => {
  it('a gateway failure after the stop and the sealed take falls back and a repeated utterance lands', async () => {
    const { dispatch, gateway, os } = build(true, true);
    const events = recordEvents(dispatch);

    dispatch.start(START_OPTIONS);
    gateway.emit('start', null);
    // The user taps stop: the recording ends and the upload phase begins
    // (the real gateway engine emits `transcribing` synchronously on stop).
    dispatch.stop();
    gateway.emit('transcribing', null);
    // The upload then fails: error + end, exactly like a broken upload.
    gateway.emit('error', { error: 'gateway-unreachable', message: 'boom' });
    gateway.emit('end', null);
    await flushAsync();

    // The sealed take died with the failed upload: the hand-off is announced
    // right at the failure — the take is lost while the pill returns to
    // Listening…, and the ask to repeat it holds whether the recogniser
    // takes over or the device refuses it. The lead's error is swallowed,
    // and its `end` is dropped because the active engine has moved on.
    expect(events.errors).toEqual([]);
    expect(events.fellBacks).toEqual([{ from: 'gateway', to: 'os' }]);

    os.emit('start', null);
    expect(events.fellBacks).toEqual([{ from: 'gateway', to: 'os' }]);
    expect(sessionCalls(os)).toEqual(['start:en-US']);
    expect(events.ends).toBe(0);

    os.emit('result', makeResult('repeated words'));
    os.emit('end', null);
    expect(events.results.map(result => result.results[0]?.transcript)).toEqual(['repeated words']);
    expect(events.ends).toBe(1);
  });

  it('a gateway failure right after the user stopped hands the session to the device recogniser', async () => {
    const { dispatch, gateway, os } = build(true, true);
    const events = recordEvents(dispatch);

    dispatch.start(START_OPTIONS);
    gateway.emit('start', null);
    dispatch.stop();
    // The stop was consumed by the failed lead attempt: it must not make the
    // fallback continuation end the session quietly.
    gateway.emit('error', { error: 'gateway-unreachable', message: 'boom' });
    gateway.emit('end', null);
    await flushAsync();
    os.emit('start', null);

    expect(events.errors).toEqual([]);
    expect(events.fellBacks).toEqual([{ from: 'gateway', to: 'os' }]);
    expect(sessionCalls(os)).toEqual(['start:en-US']);
  });

  it('a stop that arrives again while the fallback permission is pending still ends the session quietly', async () => {
    const { dispatch, gateway, os } = build(true, true);
    const events = recordEvents(dispatch);

    dispatch.start(START_OPTIONS);
    gateway.emit('start', null);
    dispatch.stop();
    gateway.emit('error', { error: 'gateway-unreachable', message: 'boom' });
    // The fallback is being scheduled; the user taps stop once more before
    // the device recogniser starts: the session ends without starting it.
    dispatch.stop();
    await flushAsync();

    expect(os.calls.filter(call => call.startsWith('start:'))).toEqual([]);
    expect(events.errors).toEqual([]);
    expect(events.ends).toBe(1);
  });

  it('a delivered result keeps a later lead failure terminal', () => {
    const { dispatch, gateway, os } = build(true, true);
    const events = recordEvents(dispatch);

    dispatch.start(START_OPTIONS);
    gateway.emit('start', null);
    // The gateway delivered its transcript (interim or final) before the
    // user stopped: the session already gave the user their words, so a
    // later failure surfaces honestly instead of asking for a repeat.
    gateway.emit('result', makeResult('already delivered'));
    dispatch.stop();
    gateway.emit('error', { error: 'gateway-unreachable', message: 'boom' });
    gateway.emit('end', null);

    expect(events.errors).toEqual([{ error: 'gateway-unreachable', message: 'boom' }]);
    expect(events.fellBacks).toEqual([]);
    expect(sessionCalls(os)).toEqual([]);
    expect(events.ends).toBe(1);
  });

  it('a gateway timeout on the lead engine surfaces the retryable timeout state instead of falling back', async () => {
    const { dispatch, gateway, os } = build(true, true);
    const events = recordEvents(dispatch);

    dispatch.start(START_OPTIONS);
    gateway.emit('start', null);
    // The upload stalls past the client's 30 s deadline. The take passed to
    // the gateway is sealed and unrecoverable, so the honest surface is the
    // retryable timeout — never a fallback that discards the take and asks
    // the user to dictate again.
    gateway.emit('error', { error: 'gateway-timeout', message: 'slow' });
    gateway.emit('end', null);
    await flushAsync();

    expect(events.errors).toEqual([{ error: 'gateway-timeout', message: 'slow' }]);
    expect(events.fellBacks).toEqual([]);
    expect(sessionCalls(os)).toEqual([]);
    expect(events.ends).toBe(1);
  });

  it('silence after the stop stays terminal: no-speech is content, not a broken engine', () => {
    const { dispatch, gateway, os } = build(true, true);
    const events = recordEvents(dispatch);

    dispatch.start(START_OPTIONS);
    gateway.emit('start', null);
    dispatch.stop();
    gateway.emit('error', { error: 'no-speech', message: 'quiet' });
    gateway.emit('end', null);

    expect(events.errors).toEqual([{ error: 'no-speech', message: 'quiet' }]);
    expect(events.fellBacks).toEqual([]);
    expect(sessionCalls(os)).toEqual([]);
    expect(events.ends).toBe(1);
  });
});
