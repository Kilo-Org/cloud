/**
 * Jest runs in the node environment where tests install per-test linkedom
 * windows; linkedom does not implement form association, so
 * `window.HTMLFormElement` and the `HTMLFormElement` global never exist.
 * @radix-ui/react-switch and @radix-ui/react-select evaluate
 * `associatedForm instanceof HTMLFormElement` inside an effect, which throws
 * `ReferenceError: HTMLFormElement is not defined` in that environment.
 *
 * Define a constructor that matches no element: no element ever fails
 * `instanceof` here, so with no real form association Radix's form-reset
 * path stays off, exactly as it did under the pre-1.4/2.3 packages, and the
 * later linkedom global patch-up in the test cannot re-enable it.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

if (typeof globalThis.HTMLFormElement === 'undefined') {
  Object.defineProperty(globalThis, 'HTMLFormElement', {
    value: class HTMLFormElement {
      constructor() {
        // Intentionally matches no linkedom element for `instanceof`.
      }
    },
    configurable: true,
    writable: false,
  });
}

/**
 * The new Radix packages (@radix-ui/react-select@2.4.1 among them) read
 * `getComputedStyle(...)` inside effects during render, which the node
 * environment has never provided; linkedom implements no CSSOM at all, so
 * its window has no `getComputedStyle` either. Stub it with an empty style
 * object: layout numbers parse to NaN exactly where the old packages never
 * computed them, and no test asserts measured geometry.
 */
if (typeof globalThis.getComputedStyle === 'undefined') {
  Object.defineProperty(globalThis, 'getComputedStyle', {
    value: (): CSSStyleDeclaration =>
      ({ animationName: 'none', display: 'block' }) as unknown as CSSStyleDeclaration,
    configurable: true,
    // Per-test linkedom shims (EnvironmentAccess.test.ts) reassign this
    // global between tests, so it must stay writable.
    writable: true,
  });
}

/**
 * Next's server runtime reads `globalThis.AsyncLocalStorage` when it builds
 * the request async stores and caches the store on `globalThis` under a
 * versioned symbol. A store module that loads before this global is set
 * caches a fake store whose `run` throws, and a later assignment cannot
 * repair the cached fake. The node runtime has the real class, so install
 * it here, before any test module's import chain reaches `next/server`.
 */
if (typeof globalThis.AsyncLocalStorage === 'undefined') {
  globalThis.AsyncLocalStorage = AsyncLocalStorage;
}
