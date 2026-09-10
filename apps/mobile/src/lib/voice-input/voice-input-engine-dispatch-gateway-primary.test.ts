import { describe, expect, it, vi } from 'vitest';

import {
  build,
  buildWithPermissions,
  DENIED,
  flushAsync,
  GRANTED,
  makeResult,
  recordEvents,
  sessionCalls,
  START_OPTIONS,
} from './voice-input-engine-dispatch-test-helpers';

describe('createDispatchingVoiceInputNative - gateway primary', () => {
  it('starts the gateway first and never starts the os on success', () => {
    const { dispatch, gateway, os } = build(true, true);
    const events = recordEvents(dispatch);

    dispatch.start(START_OPTIONS);
    dispatch.stop();
    gateway.emit('result', makeResult('hello from the gateway'));
    gateway.emit('end', null);

    expect(gateway.calls).toContain('start:en-US');
    expect(gateway.calls).toContain('stop');
    expect(sessionCalls(os)).toEqual([]);
    expect(events.results).toHaveLength(1);
    expect(events.errors).toEqual([]);
    expect(events.ends).toBe(1);
  });

  it('a failing gateway falls back to the device recogniser and returns its transcript', async () => {
    const { dispatch, gateway, os } = build(true, true);
    const events = recordEvents(dispatch);

    dispatch.start(START_OPTIONS);
    // The gateway session fails while the user is still speaking: error + end.
    gateway.emit('error', { error: 'gateway-unreachable', message: 'boom' });
    gateway.emit('end', null);
    await flushAsync();

    // The raw gateway error never reaches the controller; the device runs.
    expect(events.errors).toEqual([]);
    expect(events.ends).toBe(0);
    expect(os.calls).toContain('start:en-US');
    // Consent invariant: the OS recogniser may only go on-device here — the
    // user consented to the Kilo gateway, never to Apple/Google processing.
    expect(os.lastStartOptions?.requiresOnDeviceRecognition).toBe(true);

    os.emit('result', makeResult('hello from the device'));
    os.emit('end', null);
    expect(events.results).toEqual([makeResult('hello from the device')]);
    expect(events.errors).toEqual([]);
    expect(events.ends).toBe(1);
  });

  it('a live session handed to the device recogniser announces exactly one directed fell-back event', async () => {
    const { dispatch, gateway, os } = build(true, true);
    const events = recordEvents(dispatch);

    dispatch.start(START_OPTIONS);
    // The session went live (the controller showed Listening…), and the lead
    // fails while the user is still speaking: the take they recorded is
    // lost, so the hand-off is announced once — when the fallback engine is
    // actually listening, not before the user is ever asked to repeat.
    gateway.emit('start', null);
    gateway.emit('error', { error: 'gateway-unreachable', message: 'boom' });
    gateway.emit('end', null);
    await flushAsync();
    os.emit('start', null);

    expect(events.fellBacks).toEqual([{ from: 'gateway', to: 'os' }]);
    // One hand-off, one announcement — never one per later engine event.
    expect(events.ends).toBe(0);

    os.emit('result', makeResult('again'));
    os.emit('end', null);
    expect(events.results).toEqual([makeResult('again')]);
    expect(events.errors).toEqual([]);
    expect(events.ends).toBe(1);
  });

  it('a gateway failure before the session went live falls back without the announcement', async () => {
    const { dispatch, gateway, os } = build(true, true);
    const events = recordEvents(dispatch);

    dispatch.start(START_OPTIONS);
    // No `start` from the gateway: nothing was ever live, so there is no
    // lost take to apologise for.
    gateway.emit('error', { error: 'gateway-unreachable', message: 'boom' });
    gateway.emit('end', null);
    await flushAsync();
    os.emit('start', null);
    os.emit('end', null);

    expect(events.fellBacks).toEqual([]);
    expect(os.calls).toContain('start:en-US');
    expect(events.ends).toBe(1);
  });

  it('a gateway failure after a delivered transcript surfaces the error without the announcement', () => {
    const { dispatch, gateway, os } = build(true, true);
    const events = recordEvents(dispatch);

    dispatch.start(START_OPTIONS);
    gateway.emit('start', null);
    gateway.emit('result', makeResult('kept'));
    gateway.emit('error', { error: 'gateway-server', message: 'boom' });
    gateway.emit('end', null);

    // The take survived on the controller side (sawResult), so there is no
    // hand-off to announce — the raw error is the honest surface.
    expect(events.fellBacks).toEqual([]);
    expect(events.errors).toEqual([{ error: 'gateway-server', message: 'boom' }]);
    expect(sessionCalls(os)).toEqual([]);
  });

  it('an unavailable device recogniser never announces a fallback', () => {
    const { dispatch, gateway } = build(true, true, false);
    const events = recordEvents(dispatch);

    dispatch.start(START_OPTIONS);
    gateway.emit('start', null);
    gateway.emit('error', { error: 'gateway-unreachable', message: 'boom' });
    gateway.emit('end', null);

    expect(events.fellBacks).toEqual([]);
    expect(events.errors).toEqual([{ error: 'gateway-unreachable', message: 'boom' }]);
  });

  it('after the fallback starts, stop routes to the device recogniser only', async () => {
    const { dispatch, gateway, os } = build(true, true);
    recordEvents(dispatch);

    dispatch.start(START_OPTIONS);
    gateway.emit('error', { error: 'gateway-unreachable', message: 'boom' });
    gateway.emit('end', null);
    await flushAsync();
    dispatch.stop();

    expect(os.calls).toContain('stop');
    expect(gateway.calls).not.toContain('stop');
  });

  it('silence on the fallback reports no-speech, not the combined engine failure', async () => {
    const { dispatch, gateway, os } = build(true, true);
    const events = recordEvents(dispatch);

    dispatch.start(START_OPTIONS);
    gateway.emit('error', { error: 'gateway-unreachable', message: 'boom' });
    gateway.emit('end', null);
    await flushAsync();
    os.emit('error', { error: 'no-speech', message: 'quiet' });
    os.emit('end', null);

    expect(events.errors).toEqual([{ error: 'no-speech', message: 'quiet' }]);
    expect(events.ends).toBe(1);
  });

  it('no-speech from the gateway is content, not an engine failure: no fallback', () => {
    const { dispatch, gateway, os } = build(true, true);
    const events = recordEvents(dispatch);

    dispatch.start(START_OPTIONS);
    dispatch.stop();
    gateway.emit('error', { error: 'no-speech', message: 'quiet' });
    gateway.emit('end', null);

    expect(events.errors).toEqual([{ error: 'no-speech', message: 'quiet' }]);
    expect(events.ends).toBe(1);
    expect(sessionCalls(os)).toEqual([]);
  });

  it('an aborted session never falls back', () => {
    const { dispatch, gateway, os } = build(true, true);
    const events = recordEvents(dispatch);

    dispatch.start(START_OPTIONS);
    dispatch.abort();
    gateway.emit('error', { error: 'aborted', message: 'aborted' });
    gateway.emit('end', null);

    expect(events.errors).toEqual([{ error: 'aborted', message: 'aborted' }]);
    // The idle device recogniser gets a best-effort abort (cleanup), but it
    // is never started as a fallback.
    expect(os.calls.filter(call => call.startsWith('start'))).toEqual([]);
    expect(events.fellBacks).toEqual([]);
  });

  it('an unexpected aborted error never falls back either', () => {
    const { dispatch, gateway, os } = build(true, true);
    const events = recordEvents(dispatch);

    dispatch.start(START_OPTIONS);
    gateway.emit('error', { error: 'aborted', message: 'aborted' });
    gateway.emit('end', null);

    expect(events.errors).toEqual([{ error: 'aborted', message: 'aborted' }]);
    expect(sessionCalls(os)).toEqual([]);
  });

  it('a gateway result followed by an error does not re-record on the device', () => {
    const { dispatch, gateway, os } = build(true, true);
    const events = recordEvents(dispatch);

    dispatch.start(START_OPTIONS);
    gateway.emit('result', makeResult('partial'));
    gateway.emit('error', { error: 'gateway-server', message: 'boom' });
    gateway.emit('end', null);

    expect(events.results).toHaveLength(1);
    expect(events.errors).toEqual([{ error: 'gateway-server', message: 'boom' }]);
    expect(sessionCalls(os)).toEqual([]);
  });

  it('an unavailable device recogniser removes the fallback so gateway errors surface as-is', () => {
    const { dispatch, gateway, os } = build(true, true, false);
    const events = recordEvents(dispatch);

    expect(dispatch.isRecognitionAvailable()).toBe(true);
    dispatch.start(START_OPTIONS);
    dispatch.stop();
    gateway.emit('error', { error: 'gateway-unreachable', message: 'boom' });
    gateway.emit('end', null);

    expect(events.errors).toEqual([{ error: 'gateway-unreachable', message: 'boom' }]);
    expect(sessionCalls(os)).toEqual([]);
  });

  it('a throwing lead start with no fallback available rethrows to the controller', () => {
    const { dispatch, gateway, os } = build(true, true, false);
    gateway.start = vi.fn(() => {
      throw new Error('gateway start boom');
    });

    expect(() => {
      dispatch.start(START_OPTIONS);
    }).toThrow('gateway start boom');
    expect(sessionCalls(os)).toEqual([]);
  });

  it('a throwing active stop still surfaces to the controller', () => {
    const { dispatch, gateway } = build(true, true);
    gateway.stop = vi.fn(() => {
      throw new Error('gateway stop boom');
    });

    dispatch.start(START_OPTIONS);
    expect(() => {
      dispatch.stop();
    }).toThrow('gateway stop boom');
  });

  it('an idle engine throwing on abort cannot mask the active abort', () => {
    const { dispatch, gateway, os } = build(true, true);
    os.abort = vi.fn(() => {
      throw new Error('os idle abort');
    });

    dispatch.start(START_OPTIONS);
    expect(() => {
      dispatch.abort();
    }).not.toThrow();
    expect(gateway.calls).toContain('abort');
  });

  it('routes permissions and capabilities to the gateway as the lead', async () => {
    const { dispatch, gateway, os } = build(true, true);

    await dispatch.getPermissions();
    await dispatch.requestPermissions();
    expect(dispatch.supportsOnDevice()).toBe(false);
    expect(dispatch.supportsContinuousRecognition()).toBe(false);

    expect(gateway.calls).toContain('getPermissions');
    expect(gateway.calls).toContain('requestPermissions');
    expect(os.calls).not.toContain('getPermissions');
    expect(os.calls).not.toContain('requestPermissions');
  });

  it('asks the device recogniser for permissions only when the gateway is denied', async () => {
    // Gateway denied but the device granted: the session can still start.
    const lead = buildWithPermissions({
      enabled: true,
      primary: true,
      osPermission: GRANTED,
      gatewayPermission: DENIED,
    });
    await expect(lead.dispatch.getPermissions()).resolves.toEqual(GRANTED);

    // Both denied: the lead's denial (with its CTA data) is what surfaces.
    const both = buildWithPermissions({
      enabled: true,
      primary: true,
      osPermission: DENIED,
      gatewayPermission: DENIED,
    });
    await expect(both.dispatch.getPermissions()).resolves.toEqual(DENIED);

    // Device-only mode must not consult the gateway even for permissions.
    const off = buildWithPermissions({
      enabled: false,
      primary: true,
      osPermission: DENIED,
      gatewayPermission: GRANTED,
    });
    await expect(off.dispatch.getPermissions()).resolves.toEqual(DENIED);
    expect(off.gateway.calls).toEqual([]);
  });

  it('a requestPermissions probe follows the same lead-then-fallback order', async () => {
    const { dispatch, gateway, os } = buildWithPermissions({
      enabled: true,
      primary: true,
      osPermission: GRANTED,
      gatewayPermission: DENIED,
    });

    await expect(dispatch.requestPermissions()).resolves.toEqual(GRANTED);
    expect(gateway.calls).toContain('requestPermissions');
    expect(os.calls).toContain('requestPermissions');
  });
});
