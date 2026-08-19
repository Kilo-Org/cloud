import { describe, expect, it } from 'vitest';

import { resolveForceUpdateState } from './force-update-policy';

describe('resolveForceUpdateState', () => {
  const ok = { ok: true, data: { ios: '2.0.0', android: '2.0.0' } };

  it('returns update-required when the native version is below the platform minimum', () => {
    expect(resolveForceUpdateState(ok, '1.0.4', 'android')).toEqual({ kind: 'update-required' });
    expect(resolveForceUpdateState(ok, '1.0.4', 'ios')).toEqual({ kind: 'update-required' });
  });

  it('returns up-to-date when the native version equals the minimum', () => {
    const body = { ok: true, data: { ios: '1.0.4', android: '1.0.4' } };
    expect(resolveForceUpdateState(body, '1.0.4', 'android')).toEqual({ kind: 'up-to-date' });
    expect(resolveForceUpdateState(body, '1.0.4', 'ios')).toEqual({ kind: 'up-to-date' });
  });

  it('returns up-to-date when the native version is above the minimum', () => {
    const body = { ok: true, data: { ios: '1.0.0', android: '1.0.0' } };
    expect(resolveForceUpdateState(body, '1.0.4', 'android')).toEqual({ kind: 'up-to-date' });
  });

  it('fails open (unknown) on a missing native version', () => {
    expect(resolveForceUpdateState(ok, null, 'android')).toEqual({ kind: 'unknown' });
  });

  it('fails open (unknown) on a non-ok response', () => {
    const body = { ok: false, data: { ios: '2.0.0', android: '2.0.0' } };
    expect(resolveForceUpdateState(body, '1.0.4', 'android')).toEqual({ kind: 'unknown' });
  });

  it('fails open (unknown) on a malformed body', () => {
    expect(resolveForceUpdateState({ ok: true, data: undefined }, '1.0.4', 'android')).toEqual({
      kind: 'unknown',
    });
    expect(resolveForceUpdateState({ ok: true, data: null }, '1.0.4', 'android')).toEqual({
      kind: 'unknown',
    });
    expect(resolveForceUpdateState({ ok: true, data: 'nope' }, '1.0.4', 'android')).toEqual({
      kind: 'unknown',
    });
    expect(
      resolveForceUpdateState({ ok: true, data: { ios: '2.0.0' } }, '1.0.4', 'android')
    ).toEqual({ kind: 'unknown' });
    expect(
      resolveForceUpdateState({ ok: true, data: { ios: '2.0.0', android: 2 } }, '1.0.4', 'android')
    ).toEqual({ kind: 'unknown' });
  });
});
