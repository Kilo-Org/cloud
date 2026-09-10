import { describe, expect, it, vi } from 'vitest';

import { type VoiceInputNativeEvent } from './voice-input-controller';
import { build, recordEvents, START_OPTIONS } from './voice-input-engine-dispatch-test-helpers';
import { resolveVoiceInputEngineMode } from './voice-input-engine-mode';

describe('resolveVoiceInputEngineMode', () => {
  it('maps the two switches to the three modes', () => {
    expect(resolveVoiceInputEngineMode(false, true)).toBe('device-only');
    expect(resolveVoiceInputEngineMode(false, false)).toBe('device-only');
    expect(resolveVoiceInputEngineMode(true, true)).toBe('gateway-primary');
    expect(resolveVoiceInputEngineMode(true, false)).toBe('device-primary');
  });
});

describe('createDispatchingVoiceInputNative - device only (gateway switch off)', () => {
  it('routes start, permissions and capabilities to the os and never calls the gateway at all', async () => {
    const { dispatch, gateway, os } = build(false);

    dispatch.start(START_OPTIONS);
    await dispatch.getPermissions();
    await dispatch.requestPermissions();
    expect(dispatch.isRecognitionAvailable()).toBe(true);
    expect(dispatch.supportsOnDevice()).toBe(true);
    expect(dispatch.supportsContinuousRecognition()).toBe(true);
    dispatch.stop();
    dispatch.abort();

    expect(os.calls).toContain('start:en-US');
    expect(os.calls).toContain('getPermissions');
    // The stray gateway call this slice replaces: not a start, not a stop,
    // not a permission probe, not even a listener registration.
    expect(gateway.calls).toEqual([]);
  });

  it('an os failure surfaces directly with no fallback attempt', () => {
    const { dispatch, gateway, os } = build(false);
    const events = recordEvents(dispatch);

    dispatch.start(START_OPTIONS);
    os.emit('error', { error: 'network', message: 'offline' });
    os.emit('end', null);

    expect(events.errors).toEqual([{ error: 'network', message: 'offline' }]);
    expect(gateway.calls).toEqual([]);
  });

  it('a throwing os abort never reaches across to the gateway', () => {
    const { dispatch, gateway, os } = build(false);
    os.abort = vi.fn(() => {
      throw new Error('os abort boom');
    });

    dispatch.start(START_OPTIONS);
    expect(() => {
      dispatch.abort();
    }).toThrow('os abort boom');
    expect(gateway.calls).toEqual([]);
  });
});

describe('createDispatchingVoiceInputNative - runtime toggling', () => {
  it('follows the live enabled and primary probes, not values captured at build', () => {
    const { dispatch, gateway, os, setEnabled, setPrimary } = build(false, true);

    setEnabled(true);
    dispatch.start(START_OPTIONS);
    expect(gateway.calls).toContain('start:en-US');
    expect(os.calls.filter(call => call.startsWith('start'))).toEqual([]);

    setPrimary(false);
    dispatch.start(START_OPTIONS);
    expect(os.calls.filter(call => call.startsWith('start'))).toHaveLength(1);

    const gatewayCallsBefore = gateway.calls.length;
    setEnabled(false);
    dispatch.start(START_OPTIONS);
    // Device-only: the gateway binding receives nothing — no start, no stop,
    // no probe, no new subscription. Only stale subscriptions from the
    // previous gateway-enabled session are dropped.
    expect(
      gateway.calls.slice(gatewayCallsBefore).filter(call => !call.startsWith('remove:'))
    ).toEqual([]);
    expect(os.calls.filter(call => call.startsWith('start'))).toHaveLength(2);
  });
});

describe('createDispatchingVoiceInputNative - listener plumbing', () => {
  it('delivers the active engine events to registered listeners and remove() detaches', () => {
    const { dispatch, gateway } = build(true, true);
    const listener = vi.fn<(event: VoiceInputNativeEvent['result']) => void>();

    const subscription = dispatch.addListener('result', listener);
    dispatch.start(START_OPTIONS);
    gateway.emit('result', { isFinal: true, results: [] });
    expect(listener).toHaveBeenCalledTimes(1);

    subscription.remove();
    gateway.emit('result', { isFinal: true, results: [] });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('drops engine events once the session has ended', () => {
    const { dispatch, gateway } = build(true, true);
    const events = recordEvents(dispatch);

    dispatch.start(START_OPTIONS);
    gateway.emit('result', { isFinal: true, results: [] });
    gateway.emit('end', null);
    gateway.emit('result', { isFinal: true, results: [] });

    expect(events.results).toHaveLength(1);
    expect(events.ends).toBe(1);
  });
});
