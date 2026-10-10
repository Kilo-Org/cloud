import { handleModelsByProviderRequest } from '@kilocode/web-shared/lib/ai-gateway/handlers/models-by-provider';
import { withRestTiming } from '@kilocode/web-shared/lib/observability/request-timing';

export const GET = withRestTiming(
  '/api/openrouter/models-by-provider',
  handleModelsByProviderRequest
);
