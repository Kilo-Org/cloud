import { describe, expect, it } from 'vitest';
import { resolveDockerLocalKiloCodeApiBaseUrl } from './config';

describe('resolveDockerLocalKiloCodeApiBaseUrl', () => {
  it('rewrites localhost backend URLs to the Docker host gateway endpoint', () => {
    expect(resolveDockerLocalKiloCodeApiBaseUrl('http://localhost:3000')).toBe(
      'http://host.docker.internal:3000/api/gateway/'
    );
  });

  it('rewrites loopback backend URLs to the Docker host gateway endpoint', () => {
    expect(resolveDockerLocalKiloCodeApiBaseUrl('http://127.0.0.1:3000')).toBe(
      'http://host.docker.internal:3000/api/gateway/'
    );
  });

  it('preserves non-loopback hosts while replacing the path', () => {
    expect(resolveDockerLocalKiloCodeApiBaseUrl('https://dev.example.com/base')).toBe(
      'https://dev.example.com/api/gateway/'
    );
  });

  it('returns null when BACKEND_API_URL is missing or invalid', () => {
    expect(resolveDockerLocalKiloCodeApiBaseUrl(undefined)).toBeNull();
    expect(resolveDockerLocalKiloCodeApiBaseUrl('not a url')).toBeNull();
  });
});
