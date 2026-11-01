import { describe, expect, it } from 'vitest';

import {
  applyVariableEdit,
  savedVariableKey,
  SECRET_MASK,
  validateVariableInput,
  variableKeyPreview,
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

describe('savedVariableKey', () => {
  it('upper-cases the typed key and replaces everything outside A-Z0-9_', () => {
    expect(savedVariableKey('  api key ')).toBe('API_KEY');
    expect(savedVariableKey('API_की')).toBe('API___');
    expect(savedVariableKey('a.b-c')).toBe('A_B_C');
    expect(savedVariableKey('API_KEY')).toBe('API_KEY');
  });

  it('leads a digit-initial key with an underscore', () => {
    expect(savedVariableKey('1var')).toBe('_1VAR');
    expect(savedVariableKey('2024-report')).toBe('_2024_REPORT');
  });
});

describe('variableKeyPreview', () => {
  it('names the key a save will store when it differs from what was typed', () => {
    // Two Devanagari characters become two underscores, so the reader must see
    // the key the saved row will carry.
    expect(variableKeyPreview('API_की')).toBe('API___');
    expect(variableKeyPreview('api key')).toBe('API_KEY');
    expect(variableKeyPreview('1var')).toBe('_1VAR');
  });

  it('stays silent for a key that saves unchanged or a blank field', () => {
    expect(variableKeyPreview('API_KEY')).toBeNull();
    expect(variableKeyPreview('  API_KEY  ')).toBeNull();
    expect(variableKeyPreview('')).toBeNull();
    expect(variableKeyPreview('   ')).toBeNull();
  });
});

describe('validateVariableInput', () => {
  it('accepts a non-empty key within the 1..128 bound', () => {
    expect(validateVariableInput({ key: 'API_KEY', value: 'x' })).toBeNull();
    expect(validateVariableInput({ key: 'a'.repeat(128), value: 'x' })).toBeNull();
  });

  it('requires a value only when the caller asks for it', () => {
    expect(validateVariableInput({ key: 'API_KEY', value: '' }, [], { requireValue: true })).toBe(
      'value-required'
    );
    expect(
      validateVariableInput({ key: 'API_KEY', value: '   ' }, [], { requireValue: true })
    ).toBe('value-required');
    expect(
      validateVariableInput({ key: 'API_KEY', value: ' x ' }, [], { requireValue: true })
    ).toBeNull();
    // The session draft editor leaves the rule off: prepare-session and web accept
    // an empty value, so a blank one still passes there.
    expect(validateVariableInput({ key: 'API_KEY', value: '' })).toBeNull();
    expect(validateVariableInput({ key: 'API_KEY', value: '' }, [], {})).toBeNull();
  });

  it('keeps the key rules ahead of the value rule', () => {
    expect(validateVariableInput({ key: '', value: '' }, [], { requireValue: true })).toBe('empty');
    expect(
      validateVariableInput({ key: 'a'.repeat(129), value: '' }, [], { requireValue: true })
    ).toBe('too-long');
    expect(
      validateVariableInput({ key: 'foo-bar', value: '' }, ['FOO_BAR'], { requireValue: true })
    ).toBe('duplicate');
  });

  it('reports an empty key after trimming', () => {
    expect(validateVariableInput({ key: '', value: 'x' })).toBe('empty');
    expect(validateVariableInput({ key: '   ', value: 'x' })).toBe('empty');
  });

  it('reports a key longer than 128 characters', () => {
    expect(validateVariableInput({ key: 'a'.repeat(129), value: 'x' })).toBe('too-long');
  });

  it('measures the key the save stores, including the leading underscore', () => {
    // 128 characters exactly, but the stored key gains a leading `_`.
    expect(validateVariableInput({ key: `1${'a'.repeat(127)}`, value: 'x' })).toBe('too-long');
    expect(validateVariableInput({ key: `_${'a'.repeat(127)}`, value: 'x' })).toBeNull();
  });

  it('reports a key the sandbox runtime reserves, and accepts a stored one', () => {
    expect(validateVariableInput({ key: 'HOME', value: 'x' })).toBe('reserved');
    expect(validateVariableInput({ key: 'kilo_token', value: 'x' })).toBe('reserved');
    expect(validateVariableInput({ key: 'xdg_cache', value: 'x' })).toBe('reserved');
    expect(validateVariableInput({ key: 'API_KEY', value: 'x' })).toBeNull();
    // An edit resends the stored key, so the rule applies to a new key only.
    expect(validateVariableInput({ key: 'HOME', value: 'x' }, [], { newKey: false })).toBeNull();
  });

  it('reports a key that cleans onto an existing stored key', () => {
    expect(validateVariableInput({ key: 'foo-bar', value: 'x' }, ['FOO_BAR'])).toBe('duplicate');
    expect(validateVariableInput({ key: 'FOO_BAR', value: 'x' }, ['FOO_BAR'])).toBe('duplicate');
    // A different key, or no stored keys, still passes.
    expect(validateVariableInput({ key: 'foo-bar', value: 'x' }, ['OTHER_KEY'])).toBeNull();
    expect(validateVariableInput({ key: 'foo-bar', value: 'x' })).toBeNull();
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
