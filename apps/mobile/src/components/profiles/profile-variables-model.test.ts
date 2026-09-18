import { describe, expect, it } from 'vitest';

import {
  applyVariableEdit,
  SECRET_MASK,
  validateVariableInput,
  variableRows,
} from '@/components/profiles/profile-variables-model';

describe('variableRows', () => {
  it('returns no rows for an empty list', () => {
    expect(variableRows([])).toEqual([]);
  });

  it('masks a secret and shows a plain value as-is', () => {
    const rows = variableRows([
      { key: 'API_KEY', value: '***', isSecret: true },
      { key: 'NODE_ENV', value: 'production', isSecret: false },
    ]);

    expect(rows).toEqual([
      { key: 'API_KEY', value: '***', isSecret: true, maskedValue: SECRET_MASK },
      {
        key: 'NODE_ENV',
        value: 'production',
        isSecret: false,
        maskedValue: 'production',
      },
    ]);
  });
});

describe('validateVariableInput', () => {
  it('accepts a non-empty key within the 1..256 bound', () => {
    expect(validateVariableInput({ key: 'API_KEY', value: '' })).toBeNull();
    expect(validateVariableInput({ key: 'a'.repeat(256), value: 'x' })).toBeNull();
  });

  it('reports an empty key after trimming', () => {
    expect(validateVariableInput({ key: '', value: 'x' })).toBe('empty');
    expect(validateVariableInput({ key: '   ', value: 'x' })).toBe('empty');
  });

  it('reports a key longer than 256 characters', () => {
    expect(validateVariableInput({ key: 'a'.repeat(257), value: 'x' })).toBe('too-long');
  });
});

describe('applyVariableEdit', () => {
  const vars = [
    { key: 'A', value: '1', isSecret: false },
    { key: 'C', value: '3', isSecret: false },
  ];

  it('replaces the value of the row with the same key', () => {
    expect(applyVariableEdit(vars, { key: 'A', value: '2', isSecret: true })).toEqual([
      { key: 'A', value: '2', isSecret: true },
      { key: 'C', value: '3', isSecret: false },
    ]);
  });

  it('appends a new key and keeps the key order', () => {
    expect(applyVariableEdit(vars, { key: 'B', value: '2', isSecret: false })).toEqual([
      { key: 'A', value: '1', isSecret: false },
      { key: 'B', value: '2', isSecret: false },
      { key: 'C', value: '3', isSecret: false },
    ]);
  });

  it('leaves the source list untouched', () => {
    applyVariableEdit(vars, { key: 'B', value: '2', isSecret: false });
    expect(vars).toEqual([
      { key: 'A', value: '1', isSecret: false },
      { key: 'C', value: '3', isSecret: false },
    ]);
  });

  it('sorts without Array.prototype.toSorted, which Hermes lacks', () => {
    // The device runtime is Hermes: Array.prototype.toSorted does not exist
    // there, so the sort must go through the mutating API on a copy. Deleting
    // it in Node reproduces the device crash (`undefined is not a function`).
    const descriptor = Object.getOwnPropertyDescriptor(Array.prototype, 'toSorted');
    // oxlint-disable-next-line typescript-eslint/no-dynamic-delete -- the test deletes the ES2023 built-in to reproduce the Hermes runtime, then restores it below
    delete (Array.prototype as unknown as Record<string, unknown>).toSorted;
    try {
      expect(applyVariableEdit(vars, { key: 'B', value: '2', isSecret: false })).toEqual([
        { key: 'A', value: '1', isSecret: false },
        { key: 'B', value: '2', isSecret: false },
        { key: 'C', value: '3', isSecret: false },
      ]);
    } finally {
      if (descriptor) {
        // oxlint-disable-next-line no-extend-native -- restores exactly the built-in deleted above, so later tests keep the real Array prototype
        Object.defineProperty(Array.prototype, 'toSorted', descriptor);
      }
    }
  });
});
