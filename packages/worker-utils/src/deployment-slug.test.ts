import { describe, expect, it, vi } from 'vitest';
import {
  generateBranchSlug,
  generateDeploymentSlug,
  generateEphemeralDeploymentSlug,
  slugSchema,
  validateSlug,
} from './deployment-slug';

describe('deployment slug policy', () => {
  it('accepts valid public slugs', () => {
    expect(slugSchema.safeParse('my-project-1234').success).toBe(true);
    expect(validateSlug('my-project-1234')).toBeUndefined();
  });

  it('rejects reserved, internal, and malformed slugs', () => {
    expect(validateSlug('admin')).toBe('This subdomain is reserved');
    expect(validateSlug('dpl-private')).toBe('Subdomain cannot start with "dpl-"');
    expect(validateSlug('qdpl-private')).toBe('Subdomain cannot start with "qdpl-"');
    expect(validateSlug('my--project')).toBe('Subdomain cannot contain consecutive hyphens');
  });
});

describe('generateBranchSlug', () => {
  it('generates readable slugs with exactly three random alphanumeric characters', () => {
    const generatedSuffixes = new Set<string>();

    for (let i = 0; i < 100; i++) {
      const slug = generateBranchSlug();
      generatedSuffixes.add(slug.slice(-3));
      expect(slug).toMatch(/^[a-z]+-[a-z]+-[a-z0-9]{3}$/);
      expect(slugSchema.safeParse(slug).success).toBe(true);
    }

    expect(generatedSuffixes.size).toBeGreaterThan(1);
  });

  it.each([
    { value: 0, suffix: '000' },
    { value: 9, suffix: '009' },
    { value: 10, suffix: '00a' },
    { value: 35, suffix: '00z' },
    { value: 36, suffix: '010' },
    { value: 1295, suffix: '0zz' },
    { value: 1296, suffix: '100' },
    { value: 46655, suffix: 'zzz' },
  ])('encodes random value $value as the three-character suffix $suffix', ({ value, suffix }) => {
    const getRandomValues = vi
      .spyOn(crypto, 'getRandomValues')
      .mockImplementation(values => {
        if (values instanceof Uint32Array) values.fill(0);
        return values;
      })
      .mockImplementationOnce(values => {
        if (values instanceof Uint32Array) values[0] = value;
        return values;
      });

    try {
      expect(generateBranchSlug()).toBe(`autumn-birch-${suffix}`);
    } finally {
      getRandomValues.mockRestore();
    }
  });

  it('offers at least 256 distinct short adjectives and nouns', () => {
    let wordIndex = 0;
    const getRandomValues = vi.spyOn(crypto, 'getRandomValues').mockImplementation(values => {
      if (values instanceof Uint32Array) values.fill(wordIndex);
      return values;
    });

    try {
      const slugs = Array.from({ length: 256 }, (_, index) => {
        wordIndex = index;
        const slug = generateBranchSlug();
        expect(slug).toMatch(/^[a-z]{1,10}-[a-z]{1,10}-[a-z0-9]{3}$/);
        return slug;
      });

      expect(new Set(slugs.map(slug => slug.split('-')[0])).size).toBe(256);
      expect(new Set(slugs.map(slug => slug.split('-')[1])).size).toBe(256);
    } finally {
      getRandomValues.mockRestore();
    }
  });
});

describe('generateEphemeralDeploymentSlug', () => {
  it('generates pronounceable slugs with a random base32 suffix', () => {
    const generatedSuffixes = new Set<string>();

    for (let i = 0; i < 100; i++) {
      const slug = generateEphemeralDeploymentSlug();
      generatedSuffixes.add(slug.slice(slug.lastIndexOf('-') + 1));
      expect(slug).toMatch(/^[a-z]+-[a-z]+-[a-z2-7]{8}$/);
      expect(slugSchema.safeParse(slug).success).toBe(true);
    }

    expect(generatedSuffixes.size).toBeGreaterThan(1);
  });

  it('maps suffix bytes across the full DNS-safe base32 alphabet', () => {
    const getRandomValues = vi.spyOn(crypto, 'getRandomValues').mockImplementation(values => {
      if (values instanceof Uint8Array) {
        values.set([0, 25, 26, 27, 28, 29, 30, 31]);
      } else if (values instanceof Uint32Array) {
        values[0] = 0;
      }
      return values;
    });

    try {
      expect(generateEphemeralDeploymentSlug()).toBe('autumn-birch-az234567');
    } finally {
      getRandomValues.mockRestore();
    }
  });
});

describe('generateDeploymentSlug', () => {
  it('generates pronounceable app-builder slugs that satisfy shared validation', () => {
    for (let i = 0; i < 100; i++) {
      const slug = generateDeploymentSlug(null);
      expect(slug).toMatch(/^[a-z]+-[a-z]+-\d{4}$/);
      expect(slugSchema.safeParse(slug).success).toBe(true);
    }
  });

  it('sanitizes repository names and appends a four-digit suffix', () => {
    expect(generateDeploymentSlug('Owner/my_project.name')).toMatch(
      /^owner-my-project-name-\d{4}$/
    );
    expect(generateDeploymentSlug('---Owner---my_project---')).toMatch(/^owner-my-project-\d{4}$/);
  });

  it('truncates repository prefixes to the maximum hostname label length', () => {
    const slug = generateDeploymentSlug('a'.repeat(100));
    expect(slug.length).toBeLessThanOrEqual(63);
    expect(slugSchema.safeParse(slug).success).toBe(true);
  });

  it('falls back to a pronounceable slug when sanitization removes the prefix', () => {
    const slug = generateDeploymentSlug('---');
    expect(slug).toMatch(/^[a-z]+-[a-z]+-\d{4}$/);
    expect(slugSchema.safeParse(slug).success).toBe(true);
  });
});
