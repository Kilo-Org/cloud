import { describe, expect, it } from 'vitest';

import { cloudAgentSyncUploadSession } from './cloud-agent-session-sync';

describe('Cloud Agent sync upload routes', () => {
  it.each([
    ['PUT', '/v1/sessions/ses_synthetic/status', 'ses_synthetic'],
    ['GET', '/v1/sessions/ses_synthetic/status', null],
    ['POST', '/v1/sessions/ses_synthetic/status', null],
    ['DELETE', '/v1/sessions/ses_synthetic/status', null],
    ['PUT', '/v1/sessions/ses_synthetic/status/extra', null],
    ['PUT', '/v1/sessions/ses_synthetic/status?scope=other', null],
    ['POST', '/v1/notifications/ticket', null],
    ['GET', '/v1/notifications', null],
    ['GET', '/v1/sessions/ses_synthetic', 'ses_synthetic'],
    ['PUT', '/v1/sessions/ses_synthetic', 'ses_synthetic'],
    ['POST', '/v1/sessions/ses_synthetic/batches', 'ses_synthetic'],
    ['GET', '/v1/sessions/ses_synthetic/entities', null],
    ['DELETE', '/v1/sessions/ses_synthetic', null],
  ])('%s %s has upload scope %s', (method, path, expected) => {
    expect(cloudAgentSyncUploadSession(method, path)).toBe(expected);
  });
});
