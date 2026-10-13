/**
 * UX validation only: the Worker's `src/preview/host.ts` owns the enforced
 * bounds. Kept in a dependency-free module so both the router schema (server)
 * and the preview dialog (client) share one pair.
 */
export const CLOUD_AGENT_PREVIEW_PORT_MIN = 1024;
export const CLOUD_AGENT_PREVIEW_PORT_MAX = 65535;
