/**
 * Diagnostics seam for Cloud Agent requests. It currently just runs the
 * operation. The raw-failure formatter that used to live here is gone: the SDK
 * sets a translated error status indicator for a failed send, and mobile
 * renders that indicator above the composer, so the app never shows the reader
 * developer text (an HTTP status plus the server message).
 */
export async function withCloudAgentDiagnostics<T>(
  _action: string,
  _organizationId: string | undefined,
  run: () => Promise<T>
): Promise<T> {
  await Promise.resolve();
  return run();
}
