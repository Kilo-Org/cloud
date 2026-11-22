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

/**
 * Attachment bytes a native snapshot reader retains across reads of one client, in advertised
 * blob bytes. Blobs are content addressed, so a retained body can answer any later read of the
 * same hash. Sized to hold four maximum-size blobs (the service caps one blob at 8 MiB).
 */
export const NATIVE_SNAPSHOT_BLOB_CACHE_BYTES = 32 * 1024 * 1024;

/**
 * Longest the CLI live transport waits for one snapshot page read before it
 * stops gating live delivery on it. Matches the per-request deadline the native
 * snapshot reader already applies, so a stalled store degrades the same way on
 * both transports.
 */
export const CLI_SNAPSHOT_REPLAY_DEADLINE_MS = 15_000;

/**
 * Live CLI events the transport holds while one snapshot page read is
 * outstanding. A read that lets the buffer reach this size is stalled, so the
 * transport releases it instead of growing without bound.
 */
export const CLI_SNAPSHOT_BUFFER_MAX_EVENTS = 1024;

/**
 * Longest a `reauth_required` ticket mint may take before the socket retires and
 * reconnects. A mint is a single small POST, so a read this old is not
 * progressing and must not hold the queued transcript frames.
 */
export const NATIVE_SYNC_TICKET_MINT_DEADLINE_MS = 15_000;
