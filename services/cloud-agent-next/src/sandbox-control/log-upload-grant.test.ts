import { describe, expect, it } from 'vitest';
import jwt from 'jsonwebtoken';
import {
  validateWrapperDispatchTicket,
  validateStreamTicket,
  STREAM_TICKET_AUDIENCE,
} from '../auth.js';
import { CONTROL_LOG_GRANT_SECONDS } from '../shared/control-diagnostics.js';
import { mintControlLogUploadGrant, validateControlLogUploadGrant } from './log-upload-grant.js';

const identity = {
  sandboxId: 'sandbox_test',
  allocationId: 'allocation_test',
  wrapperInstanceId: '0fce125c-54a3-4143-b503-b7775c4d2135',
};
const secret = 'test-signing-secret';

describe('control log upload grant', () => {
  it('confers no legacy wrapper or stream authority', async () => {
    const token = mintControlLogUploadGrant(identity, secret);
    expect((await validateWrapperDispatchTicket(`Bearer ${token}`, secret)).success).toBe(false);
    expect(validateStreamTicket(token, secret, STREAM_TICKET_AUDIENCE).success).toBe(false);
  });

  it('carries only its fixed log scope and bounded expiry', () => {
    const token = mintControlLogUploadGrant(identity, secret);
    expect(validateControlLogUploadGrant(`Bearer ${token}`, secret)).toEqual(identity);
    const decoded = jwt.decode(token);
    if (!decoded || typeof decoded === 'string') throw new Error('Missing claims');
    expect(decoded.exp! - decoded.iat!).toBe(CONTROL_LOG_GRANT_SECONDS);
    expect(decoded.type).toBe('control_log_upload');
    expect(decoded.aud).toBe('cloud-agent-control-log-upload');
    expect(validateControlLogUploadGrant(`Bearer ${token}`, 'wrong-secret')).toBeUndefined();
  });

  it.each([
    { type: 'wrapper_dispatch_ticket', aud: 'cloud-agent-control-log-upload', expiresIn: 60 },
    { type: 'control_log_upload', aud: 'cloud-agent-stream', expiresIn: 60 },
    { type: 'control_log_upload', aud: 'cloud-agent-control-log-upload', expiresIn: -1 },
    {
      type: 'control_log_upload',
      aud: 'cloud-agent-control-log-upload',
      expiresIn: CONTROL_LOG_GRANT_SECONDS + 1,
    },
  ])('rejects wrong purpose, audience and expiry: %j', ({ type, aud, expiresIn }) => {
    const token = jwt.sign({ type, identity }, secret, { audience: aud, expiresIn });
    expect(validateControlLogUploadGrant(`Bearer ${token}`, secret)).toBeUndefined();
  });

  it('rejects missing, oversized and malformed credentials', () => {
    for (const auth of [null, '', 'Bearer control-credential', `Bearer ${'x'.repeat(4096)}`]) {
      expect(validateControlLogUploadGrant(auth, secret)).toBeUndefined();
    }
    expect(
      validateControlLogUploadGrant(`Bearer ${mintControlLogUploadGrant(identity, secret)}`, null)
    ).toBeUndefined();
  });
});
