import { handleProvidersRequest } from '@/lib/ai-gateway/handlers/providers';
import { withRestTiming } from '@/lib/observability/request-timing';

export const GET = withRestTiming('/api/gateway/providers', handleProvidersRequest);
