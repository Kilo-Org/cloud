import { z } from 'zod';
import type { AgentToolName } from './agent-conversation';

interface ViewportScreenshotResult {
  readonly dataUrl: string;
  readonly mediaType: 'image/png';
}

const viewportScreenshotResultSchema = z.object({
  dataUrl: z.string().refine(value => value.startsWith('data:image/png;base64,')),
  mediaType: z.literal('image/png'),
});

const isViewportScreenshotResult = (value: unknown): value is ViewportScreenshotResult =>
  viewportScreenshotResultSchema.safeParse(value).success;

export const getViewportScreenshotDataUrl = (
  toolName: AgentToolName,
  value: unknown
): string | undefined =>
  toolName === 'get_viewport_screenshot' && isViewportScreenshotResult(value)
    ? value.dataUrl
    : undefined;
