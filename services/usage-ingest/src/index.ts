import { STS_CANARY_VERIFY_PATH } from '@kilocode/sts-contracts';
import { handleFetch, type Env as PublishEnv } from './publish-usage';
import { handleQueue } from './consume-usage';
import { handleStsCanaryVerify, runStsCanary, type StsCanaryEnv } from './sts-canary';

type Env = PublishEnv & StsCanaryEnv;

export default {
  fetch(request: Request, env: Env, ctx?: ExecutionContext) {
    // The STS canary route sits before the publish routes and their 404 guard.
    if (new URL(request.url).pathname === STS_CANARY_VERIFY_PATH) {
      return handleStsCanaryVerify(request, env, ctx);
    }
    return handleFetch(request, env, ctx);
  },
  queue: handleQueue,
  scheduled: runStsCanary,
} satisfies ExportedHandler<Env>;
