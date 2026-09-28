import { handleModelsRequest } from '@/lib/ai-gateway/handlers/models';
import { withRestTiming } from '@/lib/observability/request-timing';

export const GET = withRestTiming('/api/gateway/v1/models', handleModelsRequest);
