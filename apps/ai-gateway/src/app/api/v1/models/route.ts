import { handleModelsRequest } from '@kilocode/web-shared/lib/ai-gateway/handlers/models';
import { withRestTiming } from '@kilocode/web-shared/lib/observability/request-timing';

export const GET = withRestTiming('/api/v1/models', handleModelsRequest);
