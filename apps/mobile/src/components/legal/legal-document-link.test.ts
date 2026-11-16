import { describe, expect, it } from 'vitest';

import { legalDocumentForLink } from './legal-document-link';

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
