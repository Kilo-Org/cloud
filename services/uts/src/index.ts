export { UtsReplayDO } from './dos/UtsReplayDO';
export { UtsSignerDO } from './dos/UtsSignerDO';

import type { Env } from './env';
import { handleRequest } from './http';

export default {
  fetch: handleRequest,
} satisfies ExportedHandler<Env>;
