import { describe, expect, test } from '@jest/globals';
import { normalizeProviderIconUrl } from '@/components/organizations/providers-and-models/providerIconUrl';

describe('normalizeProviderIconUrl', () => {
  test('resolves catalog-relative icon paths against the OpenRouter origin', () => {
    expect(normalizeProviderIconUrl('/images/icons/Anthropic.svg')).toBe(
      'https://openrouter.ai/images/icons/Anthropic.svg'
    );
    expect(normalizeProviderIconUrl('images/icons/Anthropic.svg')).toBe(
      'https://openrouter.ai/images/icons/Anthropic.svg'
    );
  });

  test('keeps absolute icons on the catalog icon hosts', () => {
    expect(
      normalizeProviderIconUrl(
        'https://t0.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=https://ai.meta.com/&size=256'
      )
    ).toBe(
      'https://t0.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=https://ai.meta.com/&size=256'
    );
    expect(normalizeProviderIconUrl('https://placehold.co/100?text=RU&font=roboto')).toBe(
      'https://placehold.co/100?text=RU&font=roboto'
    );
    expect(normalizeProviderIconUrl('https://openrouter.ai/images/icons/OpenAI.svg')).toBe(
      'https://openrouter.ai/images/icons/OpenAI.svg'
    );
  });

  test('drops icons on hosts outside the catalog', () => {
    expect(normalizeProviderIconUrl('https://attacker.invalid/pixel.png')).toBeNull();
    expect(
      normalizeProviderIconUrl('https://openrouter.ai.attacker.invalid/images/x.svg')
    ).toBeNull();
    expect(normalizeProviderIconUrl('https://gstatic.com/faviconV2?url=x')).toBeNull();
    expect(
      normalizeProviderIconUrl('https://t0.gstatic.com.attacker.invalid/faviconV2')
    ).toBeNull();
  });

  test('requires HTTPS', () => {
    expect(normalizeProviderIconUrl('http://openrouter.ai/images/icons/OpenAI.svg')).toBeNull();
    expect(normalizeProviderIconUrl('http://t0.gstatic.com/faviconV2?url=x')).toBeNull();
    expect(normalizeProviderIconUrl('//openrouter.ai/images/icons/OpenAI.svg')).toBeNull();
    expect(normalizeProviderIconUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeProviderIconUrl('data:image/svg+xml,<svg/>')).toBeNull();
  });

  test('drops icons that carry credentials', () => {
    expect(
      normalizeProviderIconUrl('https://user:pass@openrouter.ai/images/icons/x.svg')
    ).toBeNull();
    expect(normalizeProviderIconUrl('https://user@t0.gstatic.com/faviconV2')).toBeNull();
  });

  test('drops empty and malformed values', () => {
    expect(normalizeProviderIconUrl(null)).toBeNull();
    expect(normalizeProviderIconUrl(undefined)).toBeNull();
    expect(normalizeProviderIconUrl('')).toBeNull();
    expect(normalizeProviderIconUrl('   ')).toBeNull();
  });
});
