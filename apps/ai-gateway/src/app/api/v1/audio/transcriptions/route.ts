import type { NextRequest } from 'next/server';
import { handleAudioTranscriptionsRequest } from '@kilocode/web-shared/lib/ai-gateway/handlers/audio-transcriptions';
import { withRestTiming } from '@kilocode/web-shared/lib/observability/request-timing';

export const POST = withRestTiming('/api/v1/audio/transcriptions', (request: Request) =>
  handleAudioTranscriptionsRequest(request as NextRequest)
);

export const maxDuration = 800;
