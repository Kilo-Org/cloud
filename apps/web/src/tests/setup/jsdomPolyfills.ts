// jsdom (used by component tests via a per-file `@jest-environment jsdom`
// docblock) does not implement TextEncoder/TextDecoder, but the shared
// `workerSetup.ts` (loaded for every test file) transitively requires `pg`,
// which needs them at import time. The Node `testEnvironment: 'node'` default
// already has these globals, so this is a no-op there.
import { TextDecoder, TextEncoder } from 'node:util';

if (typeof globalThis.TextEncoder === 'undefined') {
  Object.assign(globalThis, { TextEncoder, TextDecoder });
}

// jsdom does not implement `Element.prototype.scrollIntoView` at all — Radix
// `Select` calls it while positioning `SelectContent` on open and again when
// scrolling the newly-chosen item into view after a click, so any test that
// actually clicks a `SelectItem` (not just asserts one is present) throws and
// unmounts the tree with "scrollIntoView is not a function" otherwise.
if (typeof Element !== 'undefined' && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function scrollIntoView() {};
}
