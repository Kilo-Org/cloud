import { z } from 'zod';
import type { AgentToolName } from './agent-conversation';

interface ViewportScreenshotResult {
  readonly dataUrl: string;
  readonly mediaType: 'image/jpeg' | 'image/png' | 'image/webp';
}

const viewportScreenshotResultSchema = z.object({
  dataUrl: z.string().refine(value => /^data:image\/(?:jpeg|png|webp);base64,/u.test(value)),
  mediaType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
});

const isViewportScreenshotResult = (value: unknown): value is ViewportScreenshotResult =>
  viewportScreenshotResultSchema.safeParse(value).success;

export const getViewportScreenshotDataUrl = (
  toolName: AgentToolName,
  value: unknown
): string | undefined =>
  toolName === 'kilo_browser_take_screenshot' && isViewportScreenshotResult(value)
    ? value.dataUrl
    : undefined;
