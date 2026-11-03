import { afterEach, describe, expect, it } from 'vitest';

import { i18n } from '@/i18n';
import { formatList } from '@/lib/format';

import { formFieldA11y } from './form-field-a11y';

afterEach(async () => {
  await i18n.changeLanguage('en');
});

describe('formFieldA11y', () => {
  it('returns the plain label when neither required nor error is set', () => {
    expect(formFieldA11y({ label: 'Email' })).toBe('Email');
  });

  it('separates "required" from the label with punctuation', () => {
    expect(formFieldA11y({ label: 'Email', required: true })).toBe('Email, required');
  });

  it('separates the error phrase from the label with punctuation', () => {
    expect(formFieldA11y({ label: 'Email', error: 'Enter a valid email' })).toBe(
      'Email, error: Enter a valid email'
    );
  });

  it('separates required then the error phrase with punctuation', () => {
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

  // The list conjunction reads the field's state as a second item the reader is
  // offered ("Anmeldecode und erforderlich", "Code de connexion et obligatoire"),
  // which is not what a field name followed by its state means.
  it.each(['de', 'fr', 'ar'] as const)(
    'never joins the field name and its state with the %s list conjunction',
    async language => {
      await i18n.changeLanguage(language);
      const label = i18n.t('login.signInCodeField');
      const required = i18n.t('common.required');
      const detail = 'ABC';
      const error = i18n.t('common.error', { error: detail });

      expect(formFieldA11y({ label, required: true })).toBe(`${label}, ${required}`);
      expect(formFieldA11y({ label, required: true, error: detail })).toBe(
        `${label}, ${required}, ${error}`
      );
      expect(formFieldA11y({ label, required: true })).not.toBe(
        formatList([label, required], language)
      );
    }
  );
});
