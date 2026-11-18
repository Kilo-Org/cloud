/**
 * Maximum prompt length (in characters) accepted by the cloud agent.
 *
 * Mirrors the server-side cap in `services/cloud-agent-next/src/schema.ts`
 * (`Limits.MAX_PROMPT_LENGTH`). Every client enforces the same limit so a
 * composer never silently drops text the worker would have accepted.
 */
export const CLOUD_AGENT_PROMPT_MAX_LENGTH = 100_000;

/**
 * Longest single preparation step-output delta accepted on the wire, in
 * characters. `schemas.ts` enforces it, so a client that composes or displays a
 * step-output payload uses the same ceiling.
 */
export const PREPARATION_OUTPUT_MAX_LENGTH = 65_536;

/**
 * Most recent step-output bytes a client retains per preparation step. Mirrors
 * the server-side tail in `services/cloud-agent-next/src/session/preparation-history.ts`,
 * which keeps the last 65,536 UTF-8 bytes of a running setup command.
 */
export const PREPARATION_OUTPUT_TAIL_MAX_BYTES = 65_536;
