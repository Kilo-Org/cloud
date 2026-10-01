/**
 * The Vercel request id makes a reported error traceable to the invocation that
 * produced it, so it is appended to gateway error messages when the platform
 * provided one.
 */
export function withRequestId(message: string, vercelRequestId: string | null | undefined): string {
  return vercelRequestId ? `${message} (request id: ${vercelRequestId})` : message;
}
