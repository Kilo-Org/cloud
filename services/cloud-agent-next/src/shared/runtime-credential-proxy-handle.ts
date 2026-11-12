/**
 * Audience of the runtime-credential-proxy handle JWT. Shared so the Worker that
 * mints the handle, the wrapper, and Session Sync classification can never disagree.
 */
export { RUNTIME_CREDENTIAL_PROXY_AUDIENCE } from '@kilocode/worker-utils/internal-service-token-audiences';
