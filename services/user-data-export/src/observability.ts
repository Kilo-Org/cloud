type LogLevel = 'info' | 'warn' | 'error';

type ExportLogFields = Record<string, boolean | number | string | null | undefined>;

export function safeError(error: unknown): { errorName: string; errorCode?: string | number } {
  if (!(error instanceof Error)) return { errorName: 'NonErrorThrow' };
  const code = (error as Error & { code?: unknown }).code;
  const errorName = /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(error.name) ? error.name : 'Error';
  const errorCode =
    typeof code === 'number'
      ? code
      : typeof code === 'string' && /^[A-Z0-9_]{1,32}$/.test(code)
        ? code
        : undefined;
  return {
    errorName,
    ...(errorCode === undefined ? {} : { errorCode }),
  };
}

export function logExportEvent(level: LogLevel, event: string, fields: ExportLogFields = {}): void {
  const value = JSON.stringify({ event, service: 'user-data-export', ...fields });
  if (level === 'error') console.error(value);
  else if (level === 'warn') console.warn(value);
  else console.log(value);
}
