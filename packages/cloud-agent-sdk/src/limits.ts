/**
 * Maximum prompt length (in characters) accepted by the cloud agent.
 *
 * Mirrors the server-side cap in `services/cloud-agent-next/src/schema.ts`
 * (`Limits.MAX_PROMPT_LENGTH`). Every client enforces the same limit so a
 * composer never silently drops text the worker would have accepted.
 */
export const CLOUD_AGENT_PROMPT_MAX_LENGTH = 100_000;
