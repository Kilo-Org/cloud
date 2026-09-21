import { createElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { hasArabicScript, withoutLatinLabelTreatment } from './rtl-text';

vi.mock('react-native', () => ({ I18nManager: { isRTL: false } }));

function Nested({ children }: Readonly<{ children?: ReactNode }>) {
  return createElement('Text', null, children);
}

describe('hasArabicScript', () => {
  it('detects an Arabic string', () => {
    expect(hasArabicScript('الجلسات الجارية الآن')).toBe(true);
  });

  it('rejects a Latin string', () => {
    expect(hasArabicScript('LIVE NOW')).toBe(false);
  });

  it('detects mixed content', () => {
    expect(hasArabicScript(['LIVE NOW', 'عرض الكل'])).toBe(true);
  });

  it('checks every item of an array', () => {
    expect(hasArabicScript(['LIVE', 'NOW'])).toBe(false);
  });

  it('recurses into a nested element', () => {
    expect(hasArabicScript(createElement(Nested, null, 'استكشاف'))).toBe(true);
  });

  it('is false for a number, a boolean and null', () => {
    expect(hasArabicScript(42)).toBe(false);
    expect(hasArabicScript(true)).toBe(false);
    expect(hasArabicScript(null)).toBe(false);
  });
});

describe('withoutLatinLabelTreatment', () => {
  it('drops font-mono-medium and tracking-[1.5px] and preserves the remaining order', () => {
    expect(
      withoutLatinLabelTreatment(
        'font-mono-medium text-[10px] uppercase tracking-[1.5px] text-muted-foreground'
      )
    ).toBe('text-[10px] uppercase text-muted-foreground');
  });

  it('drops font-mono-semibold and tracking-tight', () => {
    expect(withoutLatinLabelTreatment('font-mono-semibold tracking-tight text-sm')).toBe('text-sm');
  });

  it('keeps font-sans-medium', () => {
    expect(withoutLatinLabelTreatment('font-sans-medium text-sm')).toBe('font-sans-medium text-sm');
  });

  it('drops a variant-prefixed tracking utility and the bare font-mono family', () => {
    expect(withoutLatinLabelTreatment('rtl:tracking-wide font-mono uppercase')).toBe('uppercase');
  });
});
