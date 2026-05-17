/**
 * WastelandContainerDO — retired stub.
 *
 * The Cloudflare Container runtime that backed this DO has been
 * removed. The class survives only so the existing
 * `WASTELAND_CONTAINER` durable_objects binding in `wrangler.jsonc`
 * still resolves until a future migration removes the binding
 * entirely.
 *
 * Nothing routes traffic to this class anymore; all wanted-board ops
 * run through `wanted-board-ops-sdk.ts`.
 */

import { DurableObject } from 'cloudflare:workers';

export class WastelandContainerDO extends DurableObject<Env> {}
