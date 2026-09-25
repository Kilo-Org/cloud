import type { NextRequest } from 'next/server';
import { handleAudioTranscriptionsRequest } from '@/lib/ai-gateway/handlers/audio-transcriptions';
import { withRestTiming } from '@/lib/observability/request-timing';

export const POST = withRestTiming('/api/gateway/audio/transcriptions', (request: Request) =>
  handleAudioTranscriptionsRequest(request as NextRequest)
);

export const maxDuration = 800;
