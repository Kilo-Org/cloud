/**
 * The ports a preview may name. The Worker's `src/preview/host.ts` enforces
 * them; the web app imports the same pair for its port validation. The module
 * has no imports, so the web client and server bundles can both load it.
 */
export const PREVIEW_PORT_MIN = 1024;
export const PREVIEW_PORT_MAX = 65535;
