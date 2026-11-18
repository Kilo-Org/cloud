import { Buffer } from 'node:buffer';
import { generateSandboxCredential } from './credential.js';
import {
  CONTROL_CREDENTIAL_PREFIX,
  isControlCredentialPurpose,
  isSafeSandboxId,
  type ControlCredentialPurpose,
} from '../shared/control-plane-credential.js';

export {
  parseControlPlaneCredential,
  isControlPlaneCredential,
} from '../shared/control-plane-credential.js';
export type { ControlCredentialPurpose } from '../shared/control-plane-credential.js';

export function createControlPlaneCredential(
  sandboxId: string,
  purpose: ControlCredentialPurpose
): string {
  if (!isSafeSandboxId(sandboxId) || !isControlCredentialPurpose(purpose)) {
    throw new Error('Invalid control-plane credential scope');
  }
  return `${CONTROL_CREDENTIAL_PREFIX}.${Buffer.from(sandboxId).toString('base64url')}.${purpose}.${generateSandboxCredential()}`;
}
