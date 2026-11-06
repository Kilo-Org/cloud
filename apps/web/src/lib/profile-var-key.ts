import {
  ENVIRONMENT_KEY_PATTERN,
  ENVIRONMENT_LIMITS,
  isReservedEnvironmentKey,
} from '@kilocode/cloud-agent-profile';

/**
 * Why a profile variable key cannot be saved, or `null` when it can.
 *
 * The editors that assemble variables for `agentProfiles.setVar` check the key
 * here first: the profile write path applies the package's environment-key
 * rules, and a manual entry that breaks one would otherwise fail after a profile
 * row already exists.
 */
export function profileVarKeyError(key: string): string | null {
  if (key.length === 0) {
    return 'Keys must not be empty';
  }
  if (key.length > ENVIRONMENT_LIMITS.MAX_KEY_LENGTH || !ENVIRONMENT_KEY_PATTERN.test(key)) {
    return `Key "${key}" must start with a letter or underscore and use only letters, digits and underscores, up to ${ENVIRONMENT_LIMITS.MAX_KEY_LENGTH} characters`;
  }
  if (isReservedEnvironmentKey(key)) {
    return `Key "${key}" is reserved`;
  }
  return null;
}
