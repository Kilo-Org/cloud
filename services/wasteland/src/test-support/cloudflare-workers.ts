/**
 * Stand-in for the Workers runtime module in the Node test pool.
 *
 * Worker modules import `DurableObject` only to extend it; tests import
 * those modules for their plain functions and never instantiate a Durable
 * Object, so the base class carries no behaviour here.
 */

export class DurableObject<Env = unknown> {
  constructor(_ctx: unknown, _env: Env) {}
}

export class WorkerEntrypoint<Env = unknown> {
  constructor(_ctx: unknown, _env: Env) {}
}
