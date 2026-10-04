import { DurableObject } from 'cloudflare:workers';

export class ProvenanceStorage extends DurableObject {}

export default { fetch: () => new Response('test only') };
