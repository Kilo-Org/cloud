import { timingSafeEqual } from 'node:crypto';

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
