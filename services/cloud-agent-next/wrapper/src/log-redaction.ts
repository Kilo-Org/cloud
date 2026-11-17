import { collectSecretValues, createSecretValueRedactor, redactSecrets } from './redact-output.js';

const MAX_SECRET_BYTES = 1024 * 1024;
const remembered = new Set<string>();
let redact = redactSecrets;
let rememberedBytes = 0;
let exhausted = false;

/** Retain old credential values across refreshes so historical log files stay redacted. */
export function rememberLogSecrets(
  environment: Record<string, string | undefined>,
  secretEnvKeys: readonly string[] = []
): void {
  if (exhausted) return;
  let changed = false;
  for (const value of collectSecretValues(environment, [], secretEnvKeys)) {
    if (remembered.has(value)) continue;
    rememberedBytes += Buffer.byteLength(value);
    if (rememberedBytes > MAX_SECRET_BYTES) {
      exhausted = true;
      remembered.clear();
      redact = redactSecrets;
      return;
    }
    remembered.add(value);
    changed = true;
  }
  if (changed) redact = createSecretValueRedactor(remembered);
}

rememberLogSecrets(process.env);

export function redactLogText(text: string): string {
  if (exhausted) return '[Log text suppressed: secret filtering capacity reached]\n';
  return redact(text);
}
