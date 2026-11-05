import { handleFetch, type Env } from './publish-usage';
import { handleQueue } from './consume-usage';

export default {
  fetch(request: Request, env: Env, ctx?: ExecutionContext) {
    return handleFetch(request, env, ctx);
  },
  queue: handleQueue,
} satisfies ExportedHandler<Env>;
