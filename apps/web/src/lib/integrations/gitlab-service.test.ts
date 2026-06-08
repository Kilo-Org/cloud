import { instanceUrlChanged, normalizeInstanceUrl } from './gitlab-service';

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

  it('preserves https self-hosted URLs', () => {
    expect(normalizeInstanceUrl('https://selfhosted.test:3123')).toBe(
      'https://selfhosted.test:3123'
    );
  });

  it('preserves self-hosted base paths', () => {
    expect(normalizeInstanceUrl('https://GitLab.Example.com/gitlab/')).toBe(
      'https://gitlab.example.com/gitlab'
    );
  });

  it('rejects http self-hosted URLs', () => {
    expect(() => normalizeInstanceUrl('http://selfhosted.test:3123')).toThrow('must use https');
  });

  it('rejects unsafe self-hosted URLs', () => {
    expect(() => normalizeInstanceUrl('http://127.0.0.1:8080')).toThrow('host is not allowed');
  });

  it('detects instance URL changes', () => {
    // same instance (both default to gitlab.com)
    expect(normalizeInstanceUrl(undefined)).toBe(normalizeInstanceUrl('https://gitlab.com'));

    // different instances
    expect(normalizeInstanceUrl('https://gitlab.com')).not.toBe(
      normalizeInstanceUrl('https://selfhosted.test:3123')
    );

    // same self-hosted instance with trailing slash difference
    expect(normalizeInstanceUrl('https://selfhosted.test:3123/')).toBe(
      normalizeInstanceUrl('https://selfhosted.test:3123')
    );
  });

  it('treats a legacy http URL as changed when reconnecting with https', () => {
    expect(instanceUrlChanged('http://selfhosted.test:3123', 'https://selfhosted.test:3123')).toBe(
      true
    );
  });

  it('still rejects a new http URL when checking for an instance change', () => {
    expect(() =>
      instanceUrlChanged('https://selfhosted.test:3123', 'http://selfhosted.test:3123')
    ).toThrow('must use https');
  });
});
