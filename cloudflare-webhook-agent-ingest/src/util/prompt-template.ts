import { redactSensitiveHeaders } from '@kilocode/worker-utils/redact-headers';

type WebhookRequest = {
  body: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  queryString: string | null;
  sourceIp: string | null;
  timestamp: string;
};

export function renderPromptTemplate(template: string, request: WebhookRequest): string {
  const replacements: Record<string, string> = {
    '{{body}}': request.body,
    '{{bodyJson}}': tryPrettyJson(request.body),
    '{{method}}': request.method,
    '{{path}}': request.path,
    // Headers are already redacted by TriggerDO.captureRequest before DB storage.
    // No extraHeaders needed here — this function only receives pre-redacted records.
    '{{headers}}': JSON.stringify(redactSensitiveHeaders(request.headers), null, 2),
    '{{query}}': request.queryString ?? '',
    '{{sourceIp}}': request.sourceIp ?? 'unknown',
    '{{timestamp}}': request.timestamp,
  };

  let result = template;
  for (const [placeholder, value] of Object.entries(replacements)) {
    result = result.replaceAll(placeholder, value);
  }
  return result;
}

function tryPrettyJson(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}
