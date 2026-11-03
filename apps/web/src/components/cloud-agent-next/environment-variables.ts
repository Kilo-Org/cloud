import {
  ENVIRONMENT_SECRET_PLACEHOLDER,
  assertValidEnvironmentKey,
  validateEnvironmentSecretValue,
  validateEnvironmentVarCount,
  type EnvironmentSecretChange,
} from '@kilocode/cloud-agent-profile';

export { ENVIRONMENT_SECRET_PLACEHOLDER };

type Variable = { key: string; value: string; unchanged?: true };

/** Parse the editable .env subset without expansion or silently dropping invalid lines. */
export function parseEnvironmentVariables(text: string): Variable[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const variables: Variable[] = [];
  const keys = new Set<string>();
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trimStart();
    if (!line || line.startsWith('#')) continue;
    const lineNumber = index + 1;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([\s\S]*)$/.exec(line);
    if (!match) throw new Error(`Line ${lineNumber}: use KEY=value.`);
    const [, key, source] = match;
    assertValidEnvironmentKey(key);
    if (keys.has(key)) throw new Error(`Line ${lineNumber}: ${key} is entered twice.`);
    keys.add(key);

    let value = '';
    const quote = source[0];
    if (quote === '"' || quote === "'") {
      let rest = source.slice(1);
      let closed = false;
      while (!closed) {
        for (let offset = 0; offset < rest.length; offset++) {
          const char = rest[offset];
          if (quote === '"' && char === '\\' && offset + 1 < rest.length) {
            const next = rest[++offset];
            value +=
              next === 'n'
                ? '\n'
                : next === 'r'
                  ? '\r'
                  : next === '"' || next === '\\'
                    ? next
                    : `\\${next}`;
          } else if (char === quote) {
            const trailing = rest.slice(offset + 1).trim();
            if (trailing && !trailing.startsWith('#')) {
              throw new Error(`Line ${lineNumber}: unexpected text after the closing quote.`);
            }
            closed = true;
            break;
          } else {
            value += char;
          }
        }
        if (!closed) {
          index++;
          if (index >= lines.length) throw new Error(`Line ${lineNumber}: close the quoted value.`);
          value += '\n';
          rest = lines[index];
        }
      }
    } else {
      value = source.split('#', 1)[0].trim();
    }
    const unchanged = quote !== '"' && quote !== "'" && value === ENVIRONMENT_SECRET_PLACEHOLDER;
    if (!unchanged) validateEnvironmentSecretValue(value);
    variables.push({ key, value, ...(unchanged ? { unchanged: true as const } : {}) });
  }
  return variables;
}

export function formatEnvironmentVariables(
  variables: readonly Variable[],
  secretKeys: readonly string[] = []
): string {
  const plainLines = variables
    .map(({ key, value }) => {
      const quoted = value
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\r/g, '\\r')
        .replace(/\n/g, '\\n');
      return `${key}="${quoted}"`;
    })
    .join('\n');
  return [plainLines, ...secretKeys.map(key => `${key}=${ENVIRONMENT_SECRET_PLACEHOLDER}`)]
    .filter(Boolean)
    .join('\n');
}

/** Keep untouched plaintext and hidden secrets. Encrypt only new or replaced values. */
export function buildEnvironmentVariableChanges(
  text: string,
  savedPlainVars: readonly Variable[],
  savedSecretKeys: readonly string[]
): {
  plainVars: Record<string, string>;
  secrets: EnvironmentSecretChange[];
  keys: string[];
  removedKeys: string[];
} {
  const entered = parseEnvironmentVariables(text);
  const savedPlain = new Map(savedPlainVars.map(variable => [variable.key, variable.value]));
  const savedSecrets = new Set(savedSecretKeys);
  const keys = new Set(entered.map(variable => variable.key));
  const removedKeys = savedSecretKeys.filter(key => !keys.has(key));
  const secrets: EnvironmentSecretChange[] = removedKeys.map(key => ({ key, delete: true }));
  const plain: Variable[] = [];
  for (const variable of entered) {
    if (variable.unchanged) {
      if (!savedSecrets.has(variable.key))
        throw new Error(`${variable.key} has no saved secret. Enter its value.`);
      continue;
    }
    if (savedPlain.has(variable.key) && savedPlain.get(variable.key) === variable.value) {
      plain.push(variable);
    } else {
      secrets.push({ key: variable.key, value: variable.value });
    }
  }
  validateEnvironmentVarCount(keys.size);
  return {
    plainVars: Object.fromEntries(plain.map(({ key, value }) => [key, value])),
    secrets,
    keys: [...keys],
    removedKeys,
  };
}
