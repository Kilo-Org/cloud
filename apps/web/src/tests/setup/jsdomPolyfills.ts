// jsdom (used by component tests via a per-file `@jest-environment jsdom`
// docblock) does not implement TextEncoder/TextDecoder, but the shared
// `workerSetup.ts` (loaded for every test file) transitively requires `pg`,
// which needs them at import time. The Node `testEnvironment: 'node'` default
// already has these globals, so this is a no-op there.
import { TextDecoder, TextEncoder } from 'node:util';

if (typeof globalThis.TextEncoder === 'undefined') {
  Object.assign(globalThis, { TextEncoder, TextDecoder });
}
