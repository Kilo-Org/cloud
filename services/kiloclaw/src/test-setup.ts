import { timingSafeEqual } from 'node:crypto';
import { vi } from 'vitest';

// Provide a no-op stub for cloudflare:workers so any module importing waitUntil
// works in the Node test environment. Test files that need specific behaviour
// override this with their own vi.mock('cloudflare:workers', ...) call.
vi.mock('cloudflare:workers', () => ({
  DurableObject: class {},
  waitUntil: (p: Promise<unknown>) => p,
}));

// Polyfill crypto.subtle.timingSafeEqual for Vitest (Node environment).
// This API is available natively in Cloudflare Workers but not in Node.js.
if (!crypto.subtle.timingSafeEqual) {
  Object.defineProperty(crypto.subtle, 'timingSafeEqual', {
    value(a: ArrayBuffer | ArrayBufferView, b: ArrayBuffer | ArrayBufferView): boolean {
      const bufA = ArrayBuffer.isView(a)
        ? Buffer.from(a.buffer, a.byteOffset, a.byteLength)
        : Buffer.from(a);
      const bufB = ArrayBuffer.isView(b)
        ? Buffer.from(b.buffer, b.byteOffset, b.byteLength)
        : Buffer.from(b);
      return timingSafeEqual(bufA, bufB);
    },
  });
}
