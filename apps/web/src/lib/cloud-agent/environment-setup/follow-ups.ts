function listOrNone(values: readonly string[]): string {
  return values.length === 0 ? 'none' : values.join(', ');
}

export function secretsResolved(provided: readonly string[], skipped: readonly string[]): string {
  return `The user resolved your secret requests. Provided: ${listOrNone(provided)}. Skipped: ${listOrNone(skipped)}. Call get_environment_draft and continue.`;
}

export function hostsResolved(approved: readonly string[], declined: readonly string[]): string {
  return `The user resolved your network requests. Approved: ${listOrNone(approved)}. Declined: ${listOrNone(declined)}. Call get_environment_draft. Adapt setup for declined hosts, then verify with the draft's restricted network policy.`;
}

export function resumeRun(reason: string): string {
  return `Continue the environment setup. Previous stop reason: ${reason}. Call get_environment_draft first.`;
}

export function prChanged(): string {
  return 'The setup pull request changed after verification. Verify the draft again.';
}
