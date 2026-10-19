export { SandboxControlV2 } from '../../src/control-plane/sandbox/sandbox-do.js';
export { ContainerUsageMeter } from '../../../container-usage-meter/src/meter.js';

export default {
  async fetch(): Promise<Response> {
    return new Response('Admission test Worker', { status: 404 });
  },
};
