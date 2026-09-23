export function attachBranch(branch: string | undefined, scopeId: string): string {
  return branch ?? `session/${scopeId}`;
}
