import { describe, expect, it } from 'vitest';

import { MODE_SLUG_MAX_LENGTH, modeSlugFromName } from './mode-slug';

/** A decomposed name: `Co` + combining acute accent + `digo`. */
const DECOMPOSED_CODIGO = 'Co\u0301digo';

/** A 99-character name whose folded slug is longer than the server bound. */
const LONG_NAME =
  'analytics reporting pipeline throughput timeline budget forecast workload quality metrics review io';

/** What the last word boundary inside the first 50 characters of that fold leaves. */
const LONG_NAME_SLUG = 'analytics-reporting-pipeline-throughput-timeline';

/** A name that folds to 56 characters, so its trim has to drop a whole word. */
const LONG_NAME_WITH_FULL_WORDS = 'alpha bravo charlie delta echo foxtrot golf hotel indigo';

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

  it('drops whole trailing words from a long name so the slug fits the bound', () => {
    expect(LONG_NAME).toHaveLength(99);
    const suggestion = modeSlugFromName(LONG_NAME);
    expect(suggestion).toBe(LONG_NAME_SLUG);
    expect(suggestion).toBe('analytics-reporting-pipeline-throughput-timeline');
    expect(suggestion.length).toBe(48);
    expect(suggestion.length).toBeLessThanOrEqual(MODE_SLUG_MAX_LENGTH);
  });

  it('hard-cuts one long word at the bound', () => {
    const suggestion = modeSlugFromName('a'.repeat(60));
    expect(suggestion).toBe('a'.repeat(50));
    expect(suggestion.length).toBe(MODE_SLUG_MAX_LENGTH);
  });

  it('counts past a taken short slug', () => {
    expect(modeSlugFromName('Security Reviewer', ['architect', 'security-reviewer'])).toBe(
      'security-reviewer-2'
    );
    expect(
      modeSlugFromName('Security Reviewer', ['security-reviewer', 'security-reviewer-2'])
    ).toBe('security-reviewer-3');
  });

  it('leaves a short untaken name unchanged', () => {
    expect(modeSlugFromName('Security Reviewer', ['architect'])).toBe('security-reviewer');
  });

  it('keeps a taken long slug count inside the bound', () => {
    const taken = [LONG_NAME_SLUG];
    const suggestion = modeSlugFromName(LONG_NAME, taken);
    expect(suggestion).toBe('analytics-reporting-pipeline-throughput-timeline-2');
    expect(suggestion.length).toBeLessThanOrEqual(MODE_SLUG_MAX_LENGTH);
    expect(taken).not.toContain(suggestion);
  });

  it('cuts a taken long slug at a word boundary to make room for the count', () => {
    const base = modeSlugFromName(LONG_NAME_WITH_FULL_WORDS);
    expect(base).toBe('alpha-bravo-charlie-delta-echo-foxtrot-golf-hotel');
    const suggestion = modeSlugFromName(LONG_NAME_WITH_FULL_WORDS, [base]);
    expect(suggestion).toBe('alpha-bravo-charlie-delta-echo-foxtrot-golf-2');
    expect(suggestion.length).toBeLessThanOrEqual(MODE_SLUG_MAX_LENGTH);
    expect(suggestion).not.toBe(base);
  });
});
