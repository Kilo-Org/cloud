import { GET as openRouterProvidersGet } from '@/app/api/openrouter/providers/route';
import { withRestTiming } from '@/lib/observability/request-timing';

// Re-wrap the already timed handler so the gateway alias emits its own line.
export const GET = withRestTiming('/api/gateway/providers', openRouterProvidersGet);
