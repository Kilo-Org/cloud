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
  const replacements = new Map<string, string>([
    ['body', request.body],
    ['bodyJson', tryPrettyJson(request.body)],
    ['method', request.method],
    ['path', request.path],
    // Headers are already redacted by TriggerDO.captureRequest before DB storage.
    // No extraHeaders needed here — this function only receives pre-redacted records.
    ['headers', JSON.stringify(redactSensitiveHeaders(request.headers), null, 2)],
    ['query', request.queryString ?? ''],
    ['sourceIp', request.sourceIp ?? 'unknown'],
    ['timestamp', request.timestamp],
    ['scheduledTime', request.method === 'SCHEDULED' ? request.timestamp : ''],
  ]);

  // Single pass, so placeholders inside untrusted request data are never expanded.
  return template.replace(
    /\{\{(\w+)\}\}/g,
    (match, name: string) => replacements.get(name) ?? match
  );
}

function tryPrettyJson(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}
