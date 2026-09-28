import { POST as openRouterPost } from '@/app/api/openrouter/[...path]/route';
import { withRestTiming } from '@/lib/observability/request-timing';

export const POST = withRestTiming('/api/gateway/[...path]', openRouterPost);

export const maxDuration = 800;
