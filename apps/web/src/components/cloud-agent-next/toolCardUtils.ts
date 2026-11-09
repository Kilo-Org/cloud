import * as z from 'zod';
import { cloudAgentFileLabel } from '@kilocode/app-shared/cloud-agent';
import type { ToolPart } from './types';

export const toolPathKeys = [
  'filePath',
  'file_path',
  'filepath',
  'path',
  'workdir',
  'directory',
  'cwd',
  'root',
];
const argumentsSchema = z.record(z.string(), z.unknown());

export function getToolArguments(toolPart: ToolPart): Record<string, unknown> | undefined {
  const input = toolPart.state.input;
  if (toolPart.tool !== 'mcp') return input;
  const result = argumentsSchema.safeParse(input?.arguments);
  return result.success ? result.data : undefined;
}

export function getToolInputPath(input: Record<string, unknown> | undefined): string | undefined {
  if (!input) return undefined;
  for (const key of toolPathKeys) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return cloudAgentFileLabel(value);
  }
  return undefined;
}

export function getToolDisplayName(toolPart: ToolPart): string {
  const input = toolPart.state.input;
  return toolPart.tool === 'mcp' &&
    typeof input.server_name === 'string' &&
    typeof input.tool_name === 'string'
    ? `${input.server_name}/${input.tool_name}`
    : toolPart.tool;
}

export function getToolActivity(toolPart: ToolPart): string {
  const input = getToolArguments(toolPart);
  const detail = [
    input?.command,
    input?.pattern,
    input?.query,
    getToolInputPath(input),
    input?.url,
    input?.description,
    input?.name,
  ].find((value): value is string => typeof value === 'string' && value.trim().length > 0);
  const tool = getToolDisplayName(toolPart);
  if (!detail) return tool;
  const preview = detail.replace(/\s+/g, ' ').trim();
  return `${tool}: ${preview.length > 200 ? `${preview.slice(0, 197)}...` : preview}`;
}

export function getFilename(filePath: string): string {
  const parts = filePath.split('/');
  return parts[parts.length - 1] || filePath;
}

export function getDirectoryName(path: string): string {
  const cleaned = path.replace(/\/+$/, '');
  const parts = cleaned.split('/');
  return parts[parts.length - 1] || path || '.';
}

export function formatDuration(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds.toFixed(0)}s`;
}
