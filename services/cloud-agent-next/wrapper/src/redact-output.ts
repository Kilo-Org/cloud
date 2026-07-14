const REDACTED = '[REDACTED]';

const SECRET_PATTERNS: { pattern: RegExp; replacement: string }[] = [
  {
    pattern: /(Authorization\s*:\s*Bearer\s+)(\S+)/gi,
    replacement: `$1${REDACTED}`,
  },
  {
    pattern: /(Authorization\s*:\s*Basic\s+)(\S+)/gi,
    replacement: `$1${REDACTED}`,
  },
  {
    pattern: /(https?:\/\/)[^\s/@]+@/gi,
    replacement: `$1${REDACTED}@`,
  },
  {
    pattern: /((?:Set-)?Cookie\s*:\s*)[^\r\n]+/gi,
    replacement: `$1${REDACTED}`,
  },
  {
    pattern:
      /\b([A-Za-z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSPHRASE|CREDENTIAL|API_KEY|PRIVATE_KEY|ACCESS_KEY)[A-Za-z0-9_]*)\s*=\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s\r\n]+)/gi,
    replacement: `$1=${REDACTED}`,
  },
  {
    pattern:
      /(--[A-Za-z0-9-]*(?:token|password|secret|key|apikey|api-key|passphrase|credential)[A-Za-z0-9-]*(?:\s+|=))(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s\r\n]+)/gi,
    replacement: `$1${REDACTED}`,
  },
];

export function redactSecrets(text: string): string {
  let result = text;
  for (const { pattern, replacement } of SECRET_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}
