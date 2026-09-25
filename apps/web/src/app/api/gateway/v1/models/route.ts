import { GET as openRouterModelsGet } from '@/app/api/openrouter/models/route';
import { withRestTiming } from '@/lib/observability/request-timing';

// Same re-wrap as `/api/gateway/models`: the v1 alias needs its own pattern.
export const GET = withRestTiming('/api/gateway/v1/models', openRouterModelsGet);
