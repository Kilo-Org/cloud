import { createSecretRedactor, redactSecrets } from './redact-output.js';

const MAX_ENVIRONMENT_BYTES = 1024 * 1024;
const MAX_ENVIRONMENTS = 128;
const redactors: Array<(text: string) => string> = [];
let rememberedBytes = 0;
let exhausted = false;

/** Retain old credential values across refreshes so historical log files stay redacted. */
export function rememberLogSecrets(
  environment: Record<string, string | undefined>,
  secretEnvKeys: readonly string[] = []
): void {
  if (exhausted) return;
  rememberedBytes += Object.values(environment).reduce(
    (total, value) => total + (value?.length ?? 0),
    0
  );
  if (rememberedBytes > MAX_ENVIRONMENT_BYTES || redactors.length >= MAX_ENVIRONMENTS) {
    exhausted = true;
    redactors.length = 0;
    return;
  }
  redactors.push(createSecretRedactor(environment, [], secretEnvKeys));
}

rememberLogSecrets(process.env);

export function redactLogText(text: string): string {
  if (exhausted) return '[Log text suppressed: secret filtering capacity reached]\n';
  return redactors.reduce((safe, redact) => redact(safe), redactSecrets(text));
}
