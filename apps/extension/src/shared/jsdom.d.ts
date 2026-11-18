/*
 * Jsdom ships without type declarations in this repo. The probe tests only need
 * a DOM implementation, so this declares exactly the surface they use.
 */
declare module 'jsdom' {
  export class JSDOM {
    constructor(html?: string, options?: Record<string, unknown>);
    readonly window: Window & typeof globalThis;
  }
}
