/**
 * Audience of the runtime-credential-proxy handle JWT. Shared so the Worker that
 * mints the handle and the wrapper that classifies it can never disagree.
 */
export const RUNTIME_CREDENTIAL_PROXY_AUDIENCE = 'cloud-agent-next:runtime-credential-proxy';
