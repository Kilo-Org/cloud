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
    const serverName = typeof input.server_name === 'string' ? input.server_name.trim() : '';
    const toolName = typeof input.tool_name === 'string' ? input.tool_name.trim() : '';
    if (serverName && toolName) {
      return `${serverName}/${toolName}`;
    }
  }
  return tool;
}
