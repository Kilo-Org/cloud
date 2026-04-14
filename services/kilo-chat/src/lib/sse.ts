export const SSE_PING = ':ping\n\n';

export function formatSseEvent(event: string, data: unknown, id?: string): string {
  let result = '';
  if (id) result += `id: ${id}\n`;
  result += `event: ${event}\n`;
  result += `data: ${JSON.stringify(data)}\n\n`;
  return result;
}
