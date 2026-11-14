import { describe, expect, it } from 'vitest';
import { RUNTIME_CREDENTIAL_PROXY_AUDIENCE as SESSION_SYNC_AUDIENCE } from '@kilocode/worker-utils/internal-service-token-audiences';
import { RUNTIME_CREDENTIAL_PROXY_AUDIENCE } from './runtime-credential-proxy-handle.js';

describe('runtime credential proxy audience parity', () => {
  it('keeps Session Sync handle classification in sync with the minted audience', () => {
    expect(SESSION_SYNC_AUDIENCE).toBe(RUNTIME_CREDENTIAL_PROXY_AUDIENCE);
  });
});
