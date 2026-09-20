import { GET as openRouterModelsGet } from '@/app/api/openrouter/models/route';
import { withRestTiming } from '@/lib/observability/request-timing';

// Re-wrap the already timed handler so `/api/gateway/models` emits its own
// `api_timing` line. The inner wrapper stays silent: a gateway pathname is
// outside its `/api/openrouter/models` prefix.
export const GET = withRestTiming('/api/gateway/models', openRouterModelsGet);
