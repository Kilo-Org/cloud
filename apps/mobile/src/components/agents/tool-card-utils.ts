import { z } from 'zod';

const optionalStringSchema = z.string().optional();

export function getFilename(filePath: string): string {
  return filePath.split('/').pop() ?? filePath;
}

export function getDirectoryName(path: string): string {
  const parts = path.split('/');
  return parts.at(-1) ?? path;
}

export function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}\u2026`;
}

export function getGenericToolTitle(
  tool: string,
  stateTitle: string | undefined,
  input: Record<string, unknown>
): string {
  const title = stateTitle?.trim();
  if (title) {
    return title;
  }
  if (tool === 'mcp') {
    const serverName = (optionalStringSchema.safeParse(input.server_name).data ?? '').trim();
    const toolName = (optionalStringSchema.safeParse(input.tool_name).data ?? '').trim();
    if (serverName && toolName) {
      return `${serverName}/${toolName}`;
    }
  }
  return tool;
}
