import { describe, expect, it } from 'vitest';

import { legalDocumentForLink, planLegalInContentLink } from './legal-document-link';

describe('legalDocumentForLink', () => {
  it('keeps a kilo.ai legal cross reference in the app', () => {
    expect(legalDocumentForLink('https://kilo.ai/privacy')).toBe('privacy');
    expect(legalDocumentForLink('https://www.kilo.ai/terms')).toBe('terms');
    expect(legalDocumentForLink('https://kilo.ai/privacy/apps')).toBe('privacy');
  });

  it('leaves every other destination to the renderer', () => {
    expect(legalDocumentForLink('https://kilo.ai/pricing')).toBeNull();
    expect(legalDocumentForLink('mailto:hi@kilo.ai')).toBeNull();
    expect(
      legalDocumentForLink('https://www.anaconda.com/legal/terms/terms-of-service')
    ).toBeNull();
    expect(legalDocumentForLink('/privacy')).toBeNull();
  });
});

describe('planLegalInContentLink', () => {
  it('consumes an in-page anchor instead of reporting it as a broken link', () => {
    expect(planLegalInContentLink('#section', 'terms')).toEqual({ kind: 'handled' });
  });

  it('consumes the document it is already showing, fragment or not', () => {
    expect(planLegalInContentLink('https://kilo.ai/terms', 'terms')).toEqual({ kind: 'handled' });
    expect(planLegalInContentLink('https://kilo.ai/terms#section', 'terms')).toEqual({
      kind: 'handled',
    });
  });

  it('opens the other legal document in the app', () => {
    expect(planLegalInContentLink('https://kilo.ai/privacy', 'terms')).toEqual({
      kind: 'open',
      document: 'privacy',
    });
  });

  it('leaves every other destination to the renderer', () => {
    expect(planLegalInContentLink('https://example.com/terms', 'terms')).toEqual({
      kind: 'external',
    });
    expect(planLegalInContentLink('mailto:hi@kilo.ai', 'terms')).toEqual({ kind: 'external' });
    expect(planLegalInContentLink('https://kilo.ai/pricing', 'terms')).toEqual({
      kind: 'external',
    });
  });
});
