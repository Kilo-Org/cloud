import { GET as openRouterModelsByProviderGet } from '@/app/api/openrouter/models-by-provider/route';
import { withRestTiming } from '@/lib/observability/request-timing';

// Re-wrap the already timed handler so the gateway alias emits its own line.
export const GET = withRestTiming('/api/gateway/models-by-provider', openRouterModelsByProviderGet);
