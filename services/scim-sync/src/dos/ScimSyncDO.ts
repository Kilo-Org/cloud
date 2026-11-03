import { DurableObject } from 'cloudflare:workers';

/**
 * Placeholder Durable Object for the SCIM sync service.
 *
 * This iteration carries no behavior: it exists so the Worker and this Durable
 * Object class are registered and deploying cleanly. The Worker has no ingress,
 * so nothing reaches this class in production yet. Storage, polling, and WorkOS
 * integration come in later iterations.
 */
export const SCIM_SYNC_DO_NAME = 'scim-sync';

export type ScimSyncDOStatus = {
  instance: string;
  environment: string;
};

export class ScimSyncDO extends DurableObject<Env> {
  async getStatus(): Promise<ScimSyncDOStatus> {
    return {
      instance: SCIM_SYNC_DO_NAME,
      environment: this.env.ENVIRONMENT,
    };
  }
}

export function getScimSyncDOStub(env: Env): DurableObjectStub<ScimSyncDO> {
  return env.SCIM_SYNC_DO.getByName(SCIM_SYNC_DO_NAME);
}
