export function stripAnsi(raw: string): string {
  // eslint-disable-next-line no-control-regex
  return raw.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
}
