import { type UtsSecretName, type UtsSecrets, isUtsSecretName } from '../src/secrets';
import type { SignInEnv, SignInInput, SignInVarName } from '../src/signin/providers/config';

/** A secrets read holding `values`, as the `worker` source answers. */
export function secretsOf(values: Partial<Record<UtsSecretName, string>> = {}): UtsSecrets {
  return { status: 'read', source: 'worker', values };
}

/** Vars and secrets in one record, the way a test writes an environment's settings. */
export type FlatSettings = Partial<Record<SignInVarName | UtsSecretName, string>>;

/** Splits flat settings into the vars and the secrets read the sign-in readers take. */
export function signInInput(flat: FlatSettings): SignInInput {
  const vars: Record<string, string | undefined> = {};
  const values: Partial<Record<UtsSecretName, string>> = {};
  for (const [name, value] of Object.entries(flat)) {
    if (isUtsSecretName(name)) values[name] = value;
    else vars[name] = value;
  }
  // Every key that is not a secret name is a var name of `FlatSettings`.
  return { vars: vars as SignInEnv, secrets: secretsOf(values) };
}
