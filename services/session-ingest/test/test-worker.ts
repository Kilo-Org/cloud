export { SessionIngestDO } from '../src/dos/SessionIngestDO';

export default {
  fetch(): Response {
    return new Response('SessionIngestDO test worker');
  },
};
