import { handleProvidersRequest } from '@kilocode/web-shared/lib/ai-gateway/handlers/providers';
import { withRestTiming } from '@kilocode/web-shared/lib/observability/request-timing';

export const GET = withRestTiming('/api/v1/providers', handleProvidersRequest);
