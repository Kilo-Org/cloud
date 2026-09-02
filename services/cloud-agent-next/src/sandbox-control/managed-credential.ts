import { Buffer } from 'node:buffer';
import { generateSandboxCredential } from './credential.js';

export type ControlCredentialPurpose = 'kilo' | 'github' | 'gitlab' | 'bitbucket';

const CONTROL_CREDENTIAL_PREFIX = 'kcp1';
const MAX_CONTROL_CREDENTIAL_LENGTH = 512;

function isSafeSandboxId(sandboxId: string): boolean {
  return (
    sandboxId.length > 0 &&
    sandboxId.length <= 256 &&
    !/[^A-Za-z0-9._:-]/.test(sandboxId) &&
    sandboxId !== '.' &&
    sandboxId !== '..'
  );
}

function isControlCredentialPurpose(purpose: string): purpose is ControlCredentialPurpose {
  return (
    purpose === 'kilo' || purpose === 'github' || purpose === 'gitlab' || purpose === 'bitbucket'
  );
}

export function createControlPlaneCredential(
  sandboxId: string,
  purpose: ControlCredentialPurpose
): string {
  if (!isSafeSandboxId(sandboxId) || !isControlCredentialPurpose(purpose)) {
    throw new Error('Invalid control-plane credential scope');
  }
  return `${CONTROL_CREDENTIAL_PREFIX}.${Buffer.from(sandboxId).toString('base64url')}.${purpose}.${generateSandboxCredential()}`;
}

export function parseControlPlaneCredential(
  credential: string
): { sandboxId: string; purpose: ControlCredentialPurpose } | null {
  if (credential.length > MAX_CONTROL_CREDENTIAL_LENGTH) return null;
  const parts = credential.split('.');
  if (parts.length !== 4) return null;
  const [prefix, encodedSandboxId, purpose, secret] = parts;
  if (
    prefix !== CONTROL_CREDENTIAL_PREFIX ||
    !encodedSandboxId ||
    !isControlCredentialPurpose(purpose) ||
    secret.length !== 64 ||
    /[^0-9a-f]/.test(secret)
  ) {
    return null;
  }
  const sandboxId = Buffer.from(encodedSandboxId, 'base64url').toString('utf8');
  if (
    !isSafeSandboxId(sandboxId) ||
    Buffer.from(sandboxId).toString('base64url') !== encodedSandboxId
  ) {
    return null;
  }
  return { sandboxId, purpose };
}

export function isControlPlaneCredential(credential: string): boolean {
  return credential.startsWith(CONTROL_CREDENTIAL_PREFIX);
}
