import { describe, expect, it } from 'vitest';

import { formFieldA11y } from './form-field-a11y';

describe('formFieldA11y', () => {
  it('returns the plain label when neither required nor error is set', () => {
    expect(formFieldA11y({ label: 'Email' })).toBe('Email');
  });

  it('appends "required" when the field is required', () => {
    expect(formFieldA11y({ label: 'Email', required: true })).toBe('Email, required');
  });

  it('appends the error phrase when an error is set', () => {
    expect(formFieldA11y({ label: 'Email', error: 'Enter a valid email' })).toBe(
      'Email, error: Enter a valid email'
    );
  });

  it('appends required then the error phrase when both are set', () => {
    expect(formFieldA11y({ label: 'Email', required: true, error: 'Enter a valid email' })).toBe(
      'Email, required, error: Enter a valid email'
    );
  });

  it('treats false required, null error, and empty error as absent', () => {
    expect(formFieldA11y({ label: 'Email', required: false })).toBe('Email');
    expect(formFieldA11y({ label: 'Email', error: null })).toBe('Email');
    expect(formFieldA11y({ label: 'Email', error: '' })).toBe('Email');
    expect(formFieldA11y({ label: 'Email', required: true, error: '' })).toBe('Email, required');
  });
});
