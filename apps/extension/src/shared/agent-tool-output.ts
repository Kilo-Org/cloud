import type { AgentToolName } from './agent-conversation';

interface ViewportScreenshotResult {
  readonly dataUrl: string;
  readonly mediaType: 'image/png';
}

const isViewportScreenshotResult = (value: unknown): value is ViewportScreenshotResult =>
  typeof value === 'object' &&
  value !== null &&
  'dataUrl' in value &&
  typeof value.dataUrl === 'string' &&
  value.dataUrl.startsWith('data:image/png;base64,') &&
  'mediaType' in value &&
  value.mediaType === 'image/png';

export const getViewportScreenshotDataUrl = (
  toolName: AgentToolName,
  value: unknown
): string | undefined =>
  toolName === 'get_viewport_screenshot' && isViewportScreenshotResult(value)
    ? value.dataUrl
    : undefined;
