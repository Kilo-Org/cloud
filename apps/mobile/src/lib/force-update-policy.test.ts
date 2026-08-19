import { describe, expect, it } from 'vitest';

import { resolveForceUpdateState } from './force-update-policy';

describe('resolveForceUpdateState', () => {
  const ok = { ok: true, data: { ios: '2.0.0', android: '2.0.0' } };

  it('returns true when the native version is below the platform minimum', () => {
    expect(resolveForceUpdateState(ok, '1.0.4', 'android')).toBe(true);
    expect(resolveForceUpdateState(ok, '1.0.4', 'ios')).toBe(true);
  });

  it('returns false when the native version equals the minimum', () => {
    const body = { ok: true, data: { ios: '1.0.4', android: '1.0.4' } };
    expect(resolveForceUpdateState(body, '1.0.4', 'android')).toBe(false);
    expect(resolveForceUpdateState(body, '1.0.4', 'ios')).toBe(false);
  });

  it('returns false when the native version is above the minimum', () => {
    const body = { ok: true, data: { ios: '1.0.0', android: '1.0.0' } };
    expect(resolveForceUpdateState(body, '1.0.4', 'android')).toBe(false);
  });

  it('fails open (false) on a missing native version', () => {
    expect(resolveForceUpdateState(ok, null, 'android')).toBe(false);
  });

  it('fails open (false) on a non-ok response', () => {
    const body = { ok: false, data: { ios: '2.0.0', android: '2.0.0' } };
    expect(resolveForceUpdateState(body, '1.0.4', 'android')).toBe(false);
  });

  it('fails open (false) on a malformed body', () => {
    expect(resolveForceUpdateState({ ok: true, data: undefined }, '1.0.4', 'android')).toBe(false);
    expect(resolveForceUpdateState({ ok: true, data: null }, '1.0.4', 'android')).toBe(false);
    expect(resolveForceUpdateState({ ok: true, data: 'nope' }, '1.0.4', 'android')).toBe(false);
    expect(resolveForceUpdateState({ ok: true, data: { ios: '2.0.0' } }, '1.0.4', 'android')).toBe(
      false
    );
    expect(
      resolveForceUpdateState({ ok: true, data: { ios: '2.0.0', android: 2 } }, '1.0.4', 'android')
    ).toBe(false);
  });
});
