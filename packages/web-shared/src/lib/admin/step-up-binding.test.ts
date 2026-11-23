import { describe, expect, it } from '@jest/globals';
import {
  normalizeStepUpMethod,
  stepUpBindingFromOperation,
  stepUpBindingValue,
  stepUpBindingsEqual,
  stepUpOperationFromBinding,
  type StepUpOperation,
} from '@kilocode/web-shared/lib/admin/step-up-binding';

function operation(overrides: Partial<StepUpOperation> = {}): StepUpOperation {
  return {
    surface: 'trpc',
    route: 'admin.supportAccess.request',
    method: 'mutation',
    target: { kind: 'organization', id: 'org-1' },
    ...overrides,
  };
}

describe('stepUpBindingValue', () => {
  it('binds a proof to one value whatever case the method arrived in', () => {
    // The value is hashed and stored on the challenge and the proof, so a
    // method that arrives upper-cased has to reach the same hash as the
    // canonical one; otherwise the proof minted from a refusal could never be
    // claimed by the retried request.
    const canonical = stepUpBindingValue('support_write', operation());
    for (const method of ['mutation', 'MUTATION', 'Mutation', 'mUtAtIoN']) {
      expect(stepUpBindingValue('support_write', operation({ method }))).toBe(canonical);
    }
  });

  it('keeps the route and the target in the bound value', () => {
    const base = stepUpBindingValue('support_write', operation());
    expect(stepUpBindingValue('support_write', operation({ route: 'admin.other' }))).not.toBe(base);
    expect(
      stepUpBindingValue('support_write', operation({ target: { kind: 'organization', id: null } }))
    ).not.toBe(base);
  });
});

describe('binding round trip', () => {
  it('echoes a client binding back as the operation that was bound', () => {
    // `resolveActionBindingHash` hashes exactly this projection of the binding
    // the admin UI echoed, so it must reproduce the operation the guard named.
    const original = operation();
    const roundTripped = stepUpOperationFromBinding(
      stepUpBindingFromOperation('support_write', original)
    );

    expect(roundTripped).toEqual({ actionClass: 'support_write', operation: original });
    expect(stepUpBindingValue('support_write', roundTripped.operation)).toBe(
      stepUpBindingValue('support_write', original)
    );
  });

  it('canonicalises an accepted non-lower-case method on the way in', () => {
    const binding = stepUpBindingFromOperation('support_write', operation({ method: 'MUTATION' }));

    expect(binding.method).toBe('mutation');
    expect(stepUpOperationFromBinding(binding).operation.method).toBe('mutation');
  });
});

describe('stepUpBindingsEqual', () => {
  it('compares methods in their canonical form', () => {
    const lower = stepUpBindingFromOperation('support_write', operation());
    const upper = { ...lower, method: 'MUTATION' };

    expect(stepUpBindingsEqual(lower, upper)).toBe(true);
    expect(stepUpBindingsEqual(lower, { ...lower, route: 'admin.other' })).toBe(false);
    expect(stepUpBindingsEqual(lower, { ...lower, targetId: null })).toBe(false);
    expect(stepUpBindingsEqual(lower, null)).toBe(false);
    expect(stepUpBindingsEqual(undefined, upper)).toBe(false);
  });
});

describe('normalizeStepUpMethod', () => {
  it('is the one canonical form the binding functions use', () => {
    expect(normalizeStepUpMethod('GET')).toBe('get');
    expect(normalizeStepUpMethod('mutation')).toBe('mutation');
  });
});
