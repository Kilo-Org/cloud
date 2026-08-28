import type { ProcessOutputStream } from './utils.js';

const REDACTED = '[REDACTED]';
const CONFIG_ENV_NAME = /^(?:KILO_AUTH_CONTENT|KILO_CONFIG_CONTENT|OPENCODE_CONFIG_CONTENT)$/i;
const SECRET_NAME =
  /secret|token|password|passphrase|credential|(?:api|private|access)[_-]?key|authorization|cookie|^(?:key|access|refresh)$/i;
const MAX_OUTPUT_LINE_LENGTH = 64 * 1024;
const MAX_REDACTED_CHUNK_LENGTH = 2048;

const SECRET_PATTERNS: { pattern: RegExp; replacement: string }[] = [
  {
    pattern: /\b((?:KILO_AUTH|KILO_CONFIG|OPENCODE_CONFIG)_CONTENT)\s*=\s*[^\r\n]+/gi,
    replacement: `$1=${REDACTED}`,
  },
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

export function redactSecrets(text: string, knownSecrets: readonly string[] = []): string {
  let result = text;
  for (const secret of knownSecrets) {
    if (secret) result = result.replaceAll(secret, REDACTED);
  }
  for (const { pattern, replacement } of SECRET_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function createSecretRedactor(
  environment: Record<string, string | undefined>,
  ...additionalEnvironments: Record<string, string | undefined>[]
): (text: string) => string {
  const secrets = new Set<string>();
  const remember = (value: string): void => {
    if (!value) return;
    secrets.add(value);
    secrets.add(JSON.stringify(value).slice(1, -1));
    for (const line of value.split(/\r?\n/)) {
      if (line.trim()) secrets.add(line.trim());
    }
    const authorization = /^(?:Bearer|Basic)\s+(.+)$/i.exec(value);
    if (authorization?.[1]) secrets.add(authorization[1]);
  };
  const collect = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) collect(item);
    } else if (isRecord(value)) {
      for (const [name, child] of Object.entries(value)) {
        if (typeof child === 'string' && SECRET_NAME.test(name)) remember(child);
        else collect(child);
      }
    }
  };
  for (const source of [environment, ...additionalEnvironments]) {
    for (const [name, value] of Object.entries(source)) {
      if (!value) continue;
      if (CONFIG_ENV_NAME.test(name)) {
        secrets.add(value);
        secrets.add(JSON.stringify(value).slice(1, -1));
        try {
          const parsed: unknown = JSON.parse(value);
          collect(parsed);
        } catch {
          remember(value);
        }
      } else if (SECRET_NAME.test(name)) {
        remember(value);
      }
    }
  }
  const known = [...secrets].sort((left, right) => right.length - left.length);
  return text => redactSecrets(text, known);
}

export function createOutputRedactor(
  redact: (text: string) => string,
  emit: (text: string) => void
): { onOutput: (stream: ProcessOutputStream, output: string) => void; flush: () => void } {
  const buffers: Record<ProcessOutputStream, string | null> = { stdout: '', stderr: '' };
  const send = (text: string): void => {
    const safe = redact(text);
    for (let offset = 0; offset < safe.length; offset += MAX_REDACTED_CHUNK_LENGTH) {
      emit(safe.slice(offset, offset + MAX_REDACTED_CHUNK_LENGTH));
    }
  };
  return {
    onOutput(stream, output) {
      let buffer = buffers[stream];
      const completed: string[] = [];
      const lines = output.split('\n');
      for (const [index, line] of lines.entries()) {
        if (buffer !== null) {
          if (buffer.length + line.length > MAX_OUTPUT_LINE_LENGTH) {
            completed.push('[setup output truncated]\n');
            buffer = null;
          } else {
            buffer += line;
          }
        }
        if (index < lines.length - 1) {
          if (buffer !== null) completed.push(`${buffer}\n`);
          buffer = '';
        }
      }
      buffers[stream] = buffer;
      if (completed.length) send(completed.join(''));
    },
    flush() {
      for (const stream of ['stdout', 'stderr'] as const) {
        const buffer = buffers[stream];
        if (buffer) send(buffer);
        buffers[stream] = '';
      }
    },
  };
}
