import { WorkerEntrypoint } from 'cloudflare:workers';
import type { Env } from './types';

export class AdminRPCEntrypoint extends WorkerEntrypoint<Env> {
  private getAppDb(appId: string) {
    const id = this.env.APP_DB.idFromName(appId);
    return this.env.APP_DB.get(id);
  }

  async provision(appId: string): Promise<{ token: string; isNew: boolean }> {
    return await this.getAppDb(appId).provision();
  }
}
