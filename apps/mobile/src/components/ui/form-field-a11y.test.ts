import { describe, expect, it, vi } from 'vitest';

import { type FocusableFieldRef, focusFirstInvalid, formFieldA11y } from './form-field-a11y';

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

describe('focusFirstInvalid', () => {
  function mountedRef(): FocusableFieldRef {
    return { current: { focus: vi.fn<() => void>() } };
  }

  it('focuses the first invalid field and returns true', () => {
    const first = mountedRef();
    const second = mountedRef();

    expect(focusFirstInvalid([first, second])).toBe(true);
    expect(first.current?.focus).toHaveBeenCalledTimes(1);
    expect(second.current?.focus).not.toHaveBeenCalled();
  });

  it('skips unmounted fields and focuses the first mounted one', () => {
    const unmounted: FocusableFieldRef = { current: null };
    const mounted = mountedRef();

    expect(focusFirstInvalid([unmounted, mounted])).toBe(true);
    expect(mounted.current?.focus).toHaveBeenCalledTimes(1);
  });

  it('returns false and focuses nothing when every field is unmounted', () => {
    const unmounted: FocusableFieldRef = { current: null };

    expect(focusFirstInvalid([unmounted, unmounted])).toBe(false);
  });

  it('returns false for an empty list', () => {
    expect(focusFirstInvalid([])).toBe(false);
  });
});
