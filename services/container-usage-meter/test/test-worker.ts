export { FailoverBufferDO } from '../src/failover-buffer';

export default {
  async fetch(): Promise<Response> {
    return new Response('ok');
  },
};
