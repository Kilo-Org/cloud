import {
  CONTROL_LOG_GRANT_SECONDS,
  controlLogIdentitySchema,
  type ControlLogIdentity,
} from '../shared/control-diagnostics.js';
import { createHs256GrantCodec } from './hs256-grant.js';

const codec = createHs256GrantCodec<ControlLogIdentity>({
  type: 'control_log_upload',
  audience: 'cloud-agent-control-log-upload',
  lifetimeSeconds: CONTROL_LOG_GRANT_SECONDS,
  identitySchema: controlLogIdentitySchema,
});

export function mintControlLogUploadGrant(identity: ControlLogIdentity, secret: string): string {
  return codec.mint(identity, secret);
}

export function validateControlLogUploadGrant(
  authorization: string | null,
  secret: string | null
): ControlLogIdentity | undefined {
  return codec.validate(authorization, secret);
}
