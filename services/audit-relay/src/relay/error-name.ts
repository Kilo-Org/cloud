export function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}
