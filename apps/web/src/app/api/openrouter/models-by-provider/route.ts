import { handleModelsByProviderRequest } from '@/lib/ai-gateway/handlers/models-by-provider';
import { withRestTiming } from '@/lib/observability/request-timing';

export const GET = withRestTiming(
  '/api/openrouter/models-by-provider',
  handleModelsByProviderRequest
);
