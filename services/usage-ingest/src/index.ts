import { handleFetch, type Env } from './publish-usage';
import { handleQueue } from './receipt-usage';

export default {
  fetch: handleFetch,
  queue: handleQueue,
} satisfies ExportedHandler<Env>;
