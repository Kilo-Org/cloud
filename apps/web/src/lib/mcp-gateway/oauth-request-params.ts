import { createGatewayError, GatewayErrorCode } from '@kilocode/mcp-gateway';

const defaultMaxJsonBodyBytes = 64 * 1024;

function invalidRequest(message: string): never {
  throw createGatewayError(GatewayErrorCode.InvalidRequest, message, 400);
}

export async function readBoundedJsonBody(
  request: Request,
  maxBytes = defaultMaxJsonBodyBytes
): Promise<unknown> {
  if (!request.body) invalidRequest('Request body is required');
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let body = '';

  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      totalBytes += chunk.value.byteLength;
      if (totalBytes > maxBytes) invalidRequest('Request body is too large');
      body += decoder.decode(chunk.value, { stream: true });
    }
  } catch {
    invalidRequest('Request body is malformed');
  } finally {
    reader.releaseLock();
  }
  body += decoder.decode();
  try {
    return JSON.parse(body);
  } catch {
    invalidRequest('Request body is malformed');
  }
}

export async function readFormData(request: Request): Promise<FormData> {
  try {
    return await request.formData();
  } catch {
    invalidRequest('Request body is malformed');
  }
}

export function hasDuplicateSingletonParams(
  params: URLSearchParams | FormData,
  keys: readonly string[]
): boolean {
  return keys.some(key => params.getAll(key).length > 1);
}

export function stringFormParams(
  form: FormData,
  singletonKeys: readonly string[],
  ignoredKeys: readonly string[] = []
): Record<string, string> | null {
  const singletonKeySet = new Set(singletonKeys);
  const ignoredKeySet = new Set(ignoredKeys);
  const params: Record<string, string> = {};

  for (const [key, value] of form.entries()) {
    if (ignoredKeySet.has(key)) continue;
    if (singletonKeySet.has(key) && typeof value !== 'string') return null;
    if (typeof value !== 'string') continue;
    params[key] = value;
  }

  return params;
}
