import { describe, expect, it } from 'vitest';

import { MODE_SLUG_MAX_LENGTH, modeSlugFromName } from './mode-slug';

/** A decomposed name: `Co` + combining acute accent + `digo`. */
const DECOMPOSED_CODIGO = 'Co\u0301digo';

describe('modeSlugFromName', () => {
  it('folds a name into lowercase words joined by one hyphen', () => {
    expect(modeSlugFromName('Security Reviewer')).toBe('security-reviewer');
    expect(modeSlugFromName('  Data   Analyst!  ')).toBe('data-analyst');
  });

  it('leaves no leading or trailing hyphen', () => {
    expect(modeSlugFromName('-Docs-')).toBe('docs');
  });

  it('suggests nothing for an empty or whitespace-only name, taken slugs or not', () => {
    expect(modeSlugFromName('')).toBe('');
    expect(modeSlugFromName('   ')).toBe('');
    expect(modeSlugFromName('', ['architect', 'mode'])).toBe('');
    expect(modeSlugFromName('   ', ['mode'])).toBe('');
  });

  it('folds an accented letter to its base letter', () => {
    expect(modeSlugFromName('Revisor de Código')).toBe('revisor-de-codigo');
    expect(modeSlugFromName('Fluxo três')).toBe('fluxo-tres');
  });

  it('folds a name typed in decomposed form', () => {
    expect(modeSlugFromName(DECOMPOSED_CODIGO)).toBe('codigo');
  });

  it('suggests a free mode counter when the name folds away completely', () => {
    expect(modeSlugFromName('###')).toBe('mode');
    expect(modeSlugFromName('وضع الاستدلال')).toBe('mode');
  });

  it('counts the fallback past the taken slugs', () => {
    expect(modeSlugFromName('###', ['architect', 'mode'])).toBe('mode-2');
    expect(modeSlugFromName('وضع', ['mode', 'mode-2', 'mode-3'])).toBe('mode-4');
  });

  it('counts past the taken slugs, ignoring the ones that are not candidates', () => {
    const taken = ['mode', 'mode-2', 'mode-3', 'mode-4'];
    expect(modeSlugFromName('###', [...taken, 'unrelated'])).toBe('mode-5');
  });

  it('keeps the fallback inside the server slug bound', () => {
    const taken = Array.from({ length: 49 }, (_, index) =>
      index === 0 ? 'mode' : `mode-${index + 1}`
    );
    const suggestion = modeSlugFromName('###', taken);
    expect(suggestion).toBe('mode-50');
    expect(suggestion.length).toBeLessThanOrEqual(MODE_SLUG_MAX_LENGTH);
  });

  it('never suggests a taken slug, even past the last fallback inside the bound', () => {
    const taken = Array.from({ length: 50 }, (_, index) =>
      index === 0 ? 'mode' : `mode-${index + 1}`
    );
    expect(modeSlugFromName('###', taken)).toBe('mode-51');
  });
});
