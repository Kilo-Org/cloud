import type { NextRequest } from 'next/server';
import { POST as openRouterAudioTranscriptionsPost } from '@/app/api/openrouter/audio/transcriptions/route';
import { withRestTiming } from '@/lib/observability/request-timing';

export const POST = withRestTiming('/api/gateway/audio/transcriptions', (request: Request) =>
  openRouterAudioTranscriptionsPost(request as NextRequest)
);

export const maxDuration = 800;
