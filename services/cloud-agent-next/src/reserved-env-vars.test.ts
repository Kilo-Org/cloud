import { describe, expect, it } from 'vitest';
import { isReservedEnvironmentKey } from '@kilocode/cloud-agent-profile';
import { RESERVED_ENV_VARS } from './types.js';
import {
  CONTROL_RUNTIME_RESERVED_ENV_VARS,
  RESERVED_ENV_VAR_PREFIXES,
} from './shared/runtime-environment.js';

/**
 * The profile package mirrors `RESERVED_ENV_VARS`,
 * `CONTROL_RUNTIME_RESERVED_ENV_VARS`, and the runtime-owned prefixes because it
 * cannot import from this service. These tests guard the mirror against drift:
 * every entry the runtime owns must also be rejected at environment write time.
 */
describe('repository environment reserved keys', () => {
  it('rejects every RESERVED_ENV_VARS entry', () => {
    for (const key of RESERVED_ENV_VARS) {
      expect(isReservedEnvironmentKey(key), `RESERVED_ENV_VARS entry ${key}`).toBe(true);
    }
  });

  it('rejects every CONTROL_RUNTIME_RESERVED_ENV_VARS entry', () => {
    for (const key of CONTROL_RUNTIME_RESERVED_ENV_VARS) {
      expect(isReservedEnvironmentKey(key), `CONTROL_RUNTIME_RESERVED_ENV_VARS entry ${key}`).toBe(
        true
      );
    }
  });

  it('rejects every runtime-owned prefix and HOME', () => {
    for (const prefix of RESERVED_ENV_VAR_PREFIXES) {
      const key = `${prefix}EXAMPLE`;
      expect(isReservedEnvironmentKey(key), `prefix ${prefix}`).toBe(true);
    }
    expect(isReservedEnvironmentKey('HOME')).toBe(true);
  });
});
