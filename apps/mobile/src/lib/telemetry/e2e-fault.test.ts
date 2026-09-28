import { describe, expect, it } from 'vitest';

import { E2eInjectedFaultError, INJECTED_FAULT_ERROR_NAME, isE2eInjectedFault } from './e2e-fault';

describe('isE2eInjectedFault', () => {
  it('recognizes the harness fault class', () => {
    expect(isE2eInjectedFault(new E2eInjectedFaultError('read rejected'))).toBe(true);
  });

  it('recognizes a fault whose class identity was lost but keeps the name marker', () => {
    const serialized = Object.assign(new Error('read rejected'), {
      name: INJECTED_FAULT_ERROR_NAME,
    });
    expect(serialized).not.toBeInstanceOf(E2eInjectedFaultError);
    expect(isE2eInjectedFault(serialized)).toBe(true);
  });

  it('does not match an ordinary error, a lookalike, or a non-error', () => {
    expect(isE2eInjectedFault(new Error('keychain unavailable'))).toBe(false);
    expect(isE2eInjectedFault({ name: 'Error', message: 'read rejected' })).toBe(false);
    expect(isE2eInjectedFault('E2E secure-store fault window is open')).toBe(false);
    expect(isE2eInjectedFault(null)).toBe(false);
    expect(isE2eInjectedFault(undefined)).toBe(false);
  });

  it('carries the marker name on the thrown instance', () => {
    const error = new E2eInjectedFaultError('read rejected');
    expect(error.name).toBe(INJECTED_FAULT_ERROR_NAME);
    expect(error.message).toBe('read rejected');
  });
});
