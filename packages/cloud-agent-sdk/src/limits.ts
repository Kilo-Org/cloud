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

/**
 * Retained live-transport work a native session keeps while it awaits parsing and replay, in
 * UTF-16 bytes. Model discovery shares the same ceiling so one catalog read cannot exceed the
 * work one live session would retain.
 */
export const NATIVE_SYNC_RETAINED_WORK_BYTES = 4 * 1024 * 1024;

/** Retained live frames a native session keeps; model discovery shares the same frame budget. */
export const NATIVE_SYNC_RETAINED_WORK_FRAMES = 1024;
