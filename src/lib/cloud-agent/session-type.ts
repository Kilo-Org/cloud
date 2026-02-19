export function isNewSession(sessionId: string): boolean {
  return sessionId.startsWith('ses_');
}
