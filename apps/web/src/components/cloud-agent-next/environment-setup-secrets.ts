import type { SetupRunResponse } from '@/lib/cloud-agent/environment-setup/response';
import { formatEnvironmentVariables, parseEnvironmentVariables } from './environment-variables';

export function seedPendingSecretKeys(
  initialText: string,
  requests: SetupRunResponse['secretRequests']
) {
  const existingKeys = new Set(
    parseEnvironmentVariables(initialText).map(variable => variable.key)
  );
  const seededKeys = requests
    .filter(request => request.state === 'pending' && !existingKeys.has(request.key))
    .map(request => request.key);
  return {
    text: [initialText, ...seededKeys.map(key => `${key}=`)].filter(Boolean).join('\n'),
    seededKeys,
  };
}

export function omitUnresolvedSeededSecrets(
  text: string,
  seededKeys: readonly string[],
  skipped: readonly string[]
) {
  const seeded = new Set(seededKeys);
  const skippedKeys = new Set(skipped);
  const entered = parseEnvironmentVariables(text);
  const retained = entered.filter(
    variable =>
      !seeded.has(variable.key) || (!skippedKeys.has(variable.key) && variable.value !== '')
  );
  return formatEnvironmentVariables(
    retained.filter(variable => !variable.unchanged),
    retained.filter(variable => variable.unchanged).map(variable => variable.key)
  );
}

export function secretReferenceUrl(
  reference: SetupRunResponse['secretRequests'][number]['references'][number]
) {
  return `https://github.com/${reference.repoFullName.split('/').map(encodeURIComponent).join('/')}/blob/HEAD/${reference.path.split('/').map(encodeURIComponent).join('/')}#L${reference.line}`;
}
