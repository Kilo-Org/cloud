import { describe, expect, it } from 'vitest';
import { isReservedPreviewPort } from './reserved-ports.js';

describe('isReservedPreviewPort', () => {
  it('reserves the Cloudflare Sandbox control server port', () => {
    expect(isReservedPreviewPort('cloudflare', 3000)).toBe(true);
    expect(isReservedPreviewPort('cloudflare', 3001)).toBe(false);
  });

  it('reserves the Vercel runtime port, not 8080', () => {
    expect(isReservedPreviewPort('vercel', 23456)).toBe(true);
    expect(isReservedPreviewPort('vercel', 3000)).toBe(false);
    expect(isReservedPreviewPort('vercel', 8080)).toBe(false);
  });

  it('reserves no port for Cloudflare Containers', () => {
    expect(isReservedPreviewPort('cloudflare-containers', 3000)).toBe(false);
    expect(isReservedPreviewPort('cloudflare-containers', 23456)).toBe(false);
    expect(isReservedPreviewPort('cloudflare-containers', 8080)).toBe(false);
  });
});
