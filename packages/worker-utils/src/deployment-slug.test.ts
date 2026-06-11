import { describe, expect, it, vi } from 'vitest';
import {
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
