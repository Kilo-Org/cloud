export function sandboxControlWebSocketUrl(workerUrl: string, sandboxId: string): string {
  const base = workerUrl.replace(/\/$/, '');
  const path = `/sandbox-control/${encodeURIComponent(sandboxId)}`;
  if (base.startsWith('https://')) return `wss://${base.slice('https://'.length)}${path}`;
  if (base.startsWith('http://')) return `ws://${base.slice('http://'.length)}${path}`;
  return `${base}${path}`;
}
