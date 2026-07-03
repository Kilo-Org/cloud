export function parseReasoningDefault(raw: string | null): boolean {
  if (raw === 'true') {
    return true;
  }
  return false;
}
