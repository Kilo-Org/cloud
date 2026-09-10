import { describe, expect, it, vi } from 'vitest';

import {
  build,
  flushAsync,
  recordEvents,
  sessionCalls,
  START_OPTIONS,
} from './voice-input-engine-dispatch-test-helpers';
import { BOTH_ENGINES_FAILED_CODE } from './voice-input-engine-mode';

/**
 * The contract when the fallback engine itself cannot carry the session: the
 * dispatcher re-arms the lead engine and keeps listening, and the combined
 * both-engines-failed message arrives only when the user's next take fails on
 * the lead too. The iOS simulator exercises exactly this sequence — the
 * recogniser goes live on `start` and dies on `audio-capture` because the
 * simulator has no audio input — and the owner's acoustic exception keeps the
 * device gate on this observable behaviour: no scenario waits on the
 * recogniser producing a transcript.
 */
describe('createDispatchingVoiceInputNative - fallback engine death re-arms the lead engine', () => {
  it('a fallback that dies before it ever started re-arms the lead engine: the lost take is announced, no error, session alive', async () => {
    const { dispatch, gateway, os } = build(true, true);
    const events = recordEvents(dispatch);

    dispatch.start(START_OPTIONS);
    gateway.emit('start', null);
    dispatch.stop();
    gateway.emit('transcribing', null);
    // The e5 fault: the upload fails after the user's stop, so the hand-off
    // is owed — announced at the failure, because the session had gone live
    // and the take is gone either way.
    gateway.emit('error', { error: 'gateway-server', message: 'boom' });
    gateway.emit('end', null);
    await flushAsync();
    expect(events.fellBacks).toEqual([{ from: 'gateway', to: 'os' }]);
    os.emit('error', { error: 'audio-capture', message: 'Failed to initialize recognizer' });
    os.emit('end', null);

    // The session survives on the lead engine: no error, no end. The user's
    // next take runs on the gateway again.
    expect(events.errors).toEqual([]);
    expect(events.ends).toBe(0);
    expect(sessionCalls(gateway)).toEqual(['start:en-US', 'stop', 'start:en-US']);
  });

  it('the iOS simulator sequence: the recogniser goes live, announces the hand-off, dies on audio-capture, and the session keeps listening on the gateway', async () => {
    const { dispatch, gateway, os } = build(true, true);
    const events = recordEvents(dispatch);

    dispatch.start(START_OPTIONS);
    gateway.emit('start', null);
    dispatch.stop();
    gateway.emit('transcribing', null);
    // fake-llm stopped: the sealed take's upload fails after the user's
    // stop. The session had gone live, so the hand-off is owed.
    gateway.emit('error', { error: 'gateway-server', message: 'boom' });
    gateway.emit('end', null);
    await flushAsync();
    // The simulator's recogniser starts (the hand-off toast is true at that
    // moment) and then dies on `audio-capture` because the simulator has no
    // audio input. The session must survive on the gateway, listening, with
    // the hand-off as its last message.
    os.emit('start', null);
    expect(events.fellBacks).toEqual([{ from: 'gateway', to: 'os' }]);
    os.emit('error', { error: 'audio-capture', message: 'no audio input on the simulator' });
    os.emit('end', null);

    expect(events.errors).toEqual([]);
    expect(events.ends).toBe(0);
    // Exactly one announcement: the re-armed lead's `start` is the gateway's
    // own, never a second hand-off, and the recogniser is never started
    // again after it died.
    gateway.emit('start', null);
    expect(events.fellBacks).toEqual([{ from: 'gateway', to: 'os' }]);
    expect(events.errors).toEqual([]);
    expect(events.ends).toBe(0);
    expect(sessionCalls(os)).toEqual(['start:en-US']);
  });

  it('a lead failure after the fallback died produces exactly ONE voice-engines-failed error', async () => {
    const { dispatch, gateway, os } = build(true, true);
    const events = recordEvents(dispatch);

    dispatch.start(START_OPTIONS);
    gateway.emit('error', { error: 'gateway-unreachable', message: 'boom' });
    gateway.emit('end', null);
    await flushAsync();
    os.emit('error', { error: 'client', message: 'device boom' });
    os.emit('end', null);
    // The fallback died: the session re-armed on the lead engine. The user's
    // repeated take fails there too — both engines have now failed in this
    // session, and exactly one combined message says so.
    expect(events.errors).toEqual([]);
    gateway.emit('error', { error: 'gateway-unreachable', message: 'boom again' });
    gateway.emit('end', null);

    expect(events.errors).toHaveLength(1);
    expect(events.errors[0]?.error).toBe(BOTH_ENGINES_FAILED_CODE);
    expect(events.ends).toBe(1);
  });

  it('a fallback engine that cannot even start re-arms the lead engine, and the second lead failure is the single combined error', async () => {
    const { dispatch, gateway, os } = build(true, true);
    const events = recordEvents(dispatch);
    os.start = vi.fn(() => {
      throw new Error('os start boom');
    });

    dispatch.start(START_OPTIONS);
    gateway.emit('error', { error: 'gateway-unreachable', message: 'boom' });
    gateway.emit('end', null);
    await flushAsync();

    // The recogniser cannot even be asked to listen: the session returns to
    // the gateway instead of ending on a promise it cannot keep.
    expect(events.errors).toEqual([]);
    expect(events.ends).toBe(0);
    expect(sessionCalls(gateway)).toEqual(['start:en-US', 'start:en-US']);

    gateway.emit('error', { error: 'gateway-unreachable', message: 'boom again' });
    gateway.emit('end', null);
    expect(events.errors).toEqual([
      { error: BOTH_ENGINES_FAILED_CODE, message: expect.any(String) },
    ]);
    expect(events.ends).toBe(1);
  });

  it('a timeout on the fallback engine surfaces the retryable timeout instead of re-arming the lead', async () => {
    const { dispatch, gateway, os } = build(true, false);
    const events = recordEvents(dispatch);

    dispatch.start(START_OPTIONS);
    // The recogniser leads and dies without audio input; the gateway takes over.
    os.emit('error', { error: 'audio-capture', message: 'no audio input' });
    await flushAsync();
    gateway.emit('start', null);
    // The gateway upload then stalls past its deadline: the take is sealed,
    // so the retryable timeout is the surface — not another hand-off.
    gateway.emit('error', { error: 'gateway-timeout', message: 'slow' });
    gateway.emit('end', null);

    expect(events.errors).toEqual([{ error: 'gateway-timeout', message: 'slow' }]);
    expect(events.ends).toBe(1);
    expect(sessionCalls(gateway)).toEqual(['start:en-US']);
  });
});
