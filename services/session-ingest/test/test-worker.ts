export { SessionIngestDO } from '../src/dos/SessionIngestDO';
export { SessionAccessCacheDO } from '../src/dos/SessionAccessCacheDO';

export default {
  fetch(): Response {
    return new Response('SessionIngestDO test worker');
  },
};
