import { describe, it, expect } from 'vitest';
import { webUrlHost } from './web-url-host.js';

describe('webUrlHost', () => {
  it('reads the host of an https URL', () => {
    expect(webUrlHost('https://docs.example.com/a/b')).toBe('docs.example.com');
  });

  it('keeps the port the URL names and drops the path', () => {
    expect(webUrlHost('https://localhost:8080/search?q=1#top')).toBe('localhost:8080');
  });

  it('lowercases the host as the URL parser does', () => {
    expect(webUrlHost('https://Docs.Example.COM/')).toBe('docs.example.com');
  });

  it('returns null for text that is not a URL', () => {
    expect(webUrlHost('not a url')).toBeNull();
    expect(webUrlHost('')).toBeNull();
  });
});
