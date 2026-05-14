import { syncFromBench } from './sync.js';

const handler = {
  async scheduled(
    _controller: ScheduledController,
    env: CloudflareEnv,
    _ctx: ExecutionContext
  ): Promise<void> {
    const result = await syncFromBench(env);
    console.log('[model-eval-ingest] promotion sync completed', result);
  },
};

export { handler };
export default handler;
