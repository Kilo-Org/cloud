import type { SandboxControl } from '../persistence/SandboxControl.js';
import type { Env } from '../types.js';

export const SANDBOX_ID_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/;

export function isSandboxControlId(value: string): boolean {
  return SANDBOX_ID_PATTERN.test(value);
}

export function getSandboxControlStub(
  env: Pick<Env, 'SANDBOX_CONTROL'>,
  sandboxId: string
): DurableObjectStub<SandboxControl> {
  return env.SANDBOX_CONTROL.getByName(sandboxId);
}
