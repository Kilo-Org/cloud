/** Builds the standard parameter representation used by integration callback reports. */
export function getCallbackReportParams(searchParams: URLSearchParams): Record<string, string> {
  return Object.fromEntries(
    Array.from(searchParams.entries(), ([key, value]) => [key, key === 'code' ? '***' : value])
  );
}
