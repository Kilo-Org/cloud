const maxUserDiagnosticLength = 220;

type SafeCloudAgentErrorInfo = {
  action: string;
  hasOrganizationId: boolean;
  name?: string;
  message?: string;
  code?: string;
  httpStatus?: number;
  shapeCode?: string;
  shapeHttpStatus?: number;
  causeMessage?: string;
};

type ErrorRecord = {
  name?: unknown;
  message?: unknown;
  data?: unknown;
  shape?: unknown;
  cause?: unknown;
};

function getRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  return value as Record<string, unknown>;
}

function getString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function getNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function truncateDiagnosticMessage(message: string): string {
  if (message.length <= maxUserDiagnosticLength) {
    return message;
  }
  return `${message.slice(0, maxUserDiagnosticLength - 1)}...`;
}

function cleanDiagnosticMessage(message: string | undefined): string | undefined {
  const cleaned = message?.replaceAll(/\s+/g, ' ').trim();
  return cleaned ? truncateDiagnosticMessage(cleaned) : undefined;
}

function getSafeUserMessage(info: SafeCloudAgentErrorInfo): string | undefined {
  return cleanDiagnosticMessage(info.message ?? info.causeMessage);
}

function safeCloudAgentErrorInfo(
  action: string,
  err: unknown,
  organizationId: string | undefined
): SafeCloudAgentErrorInfo {
  const errorRecord = getRecord(err) as ErrorRecord | null;
  const data = getRecord(errorRecord?.data);
  const shape = getRecord(errorRecord?.shape);
  const shapeData = getRecord(shape?.data);
  const cause = getRecord(errorRecord?.cause);

  return {
    action,
    hasOrganizationId: Boolean(organizationId),
    name: getString(errorRecord?.name),
    message: getString(errorRecord?.message),
    code: getString(data?.code),
    httpStatus: getNumber(data?.httpStatus),
    shapeCode: getString(shape?.code),
    shapeHttpStatus: getNumber(shapeData?.httpStatus),
    causeMessage: getString(cause?.message),
  };
}

export function formatSafeCloudAgentFailureDiagnostic(
  action: string,
  error: unknown,
  organizationId: string | undefined
): string | undefined {
  const info = safeCloudAgentErrorInfo(action, error, organizationId);
  const code = info.code ?? info.shapeCode;
  const httpStatus = info.httpStatus ?? info.shapeHttpStatus;
  const status = [code, httpStatus].filter(Boolean).join(' ');
  const message = getSafeUserMessage(info);
  if (!status && !message) {
    return undefined;
  }
  const prefix = status
    ? `Cloud Agent ${action} failed (${status})`
    : `Cloud Agent ${action} failed`;
  return message ? `${prefix}: ${message}` : prefix;
}

export async function withCloudAgentDiagnostics<T>(
  _action: string,
  _organizationId: string | undefined,
  run: () => Promise<T>
): Promise<T> {
  await Promise.resolve();
  return run();
}
