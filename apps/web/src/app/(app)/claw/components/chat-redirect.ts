export function buildKiloChatRedirect(basePath: string, sandboxId: string): string {
  return `${basePath}?sandboxId=${encodeURIComponent(sandboxId)}`;
}
