export { FailoverBufferDO } from './failover-buffer';
export { ContainerUsageMeter } from './meter';

import { CONTAINER_USAGE_RECONCILIATION_CRON, runReconciliationScaffold } from './reconciliation';

export default {
  async fetch(): Promise<Response> {
    return Response.json({ ok: true, service: 'container-usage-meter' });
  },

  async scheduled(controller, env): Promise<void> {
    if (controller.cron !== CONTAINER_USAGE_RECONCILIATION_CRON) {
      console.warn(
        JSON.stringify({
          message: 'Ignoring unknown container usage cron trigger',
          event: 'reconciliation_skipped',
          cron: controller.cron,
        })
      );
      return;
    }
    await runReconciliationScaffold(env);
  },
} satisfies ExportedHandler<Cloudflare.Env>;
