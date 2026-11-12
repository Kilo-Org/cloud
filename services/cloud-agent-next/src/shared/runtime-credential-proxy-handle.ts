/**
 * Audience of the runtime-credential-proxy handle JWT. Shared so the Worker that
 * mints the handle and the wrapper that classifies it can never disagree. The
 * isolated wrapper build cannot resolve `@kilocode/worker-utils` values, so
 * Session Sync's copy is held equal by `runtime-credential-proxy-handle.parity.test.ts`.
 */
export const RUNTIME_CREDENTIAL_PROXY_AUDIENCE = 'cloud-agent-next:runtime-credential-proxy';
