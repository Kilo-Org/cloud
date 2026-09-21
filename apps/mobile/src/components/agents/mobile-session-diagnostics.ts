/**
 * Runs one Cloud Agent request under the diagnostics seam. Every manager call
 * site wraps its body here, so instrumentation has a single place to land; a
 * failed send is stated by the SDK's composer status line, never by a
 * developer-worded banner built from the error shape.
 */
export async function withCloudAgentDiagnostics<T>(
  _action: string,
  _organizationId: string | undefined,
  run: () => Promise<T>
): Promise<T> {
  await Promise.resolve();
  return run();
}
