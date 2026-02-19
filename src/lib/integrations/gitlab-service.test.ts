import { normalizeInstanceUrl } from './gitlab-service';

describe('normalizeInstanceUrl', () => {
  it('treats undefined as gitlab.com', () => {
    expect(normalizeInstanceUrl(undefined)).toBe('https://gitlab.com');
  });

  it('treats empty string as gitlab.com', () => {
    expect(normalizeInstanceUrl('')).toBe('https://gitlab.com');
  });

  it('strips trailing slashes', () => {
    expect(normalizeInstanceUrl('https://gitlab.example.com/')).toBe('https://gitlab.example.com');
    expect(normalizeInstanceUrl('https://gitlab.example.com///')).toBe(
      'https://gitlab.example.com'
    );
  });

  it('lowercases the URL', () => {
    expect(normalizeInstanceUrl('https://GitLab.Example.COM')).toBe('https://gitlab.example.com');
  });

  it('returns gitlab.com unchanged', () => {
    expect(normalizeInstanceUrl('https://gitlab.com')).toBe('https://gitlab.com');
  });

  it('preserves self-hosted URLs', () => {
    expect(normalizeInstanceUrl('http://selfhosted.test:3123')).toBe('http://selfhosted.test:3123');
  });

  it('detects instance URL changes', () => {
    // same instance (both default to gitlab.com)
    expect(normalizeInstanceUrl(undefined)).toBe(normalizeInstanceUrl('https://gitlab.com'));

    // different instances
    expect(normalizeInstanceUrl('https://gitlab.com')).not.toBe(
      normalizeInstanceUrl('http://selfhosted.test:3123')
    );

    // same self-hosted instance with trailing slash difference
    expect(normalizeInstanceUrl('http://selfhosted.test:3123/')).toBe(
      normalizeInstanceUrl('http://selfhosted.test:3123')
    );
  });
});
