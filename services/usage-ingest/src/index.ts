import { handleFetch, type Env } from './publish-usage';

export default {
  fetch: handleFetch,
} satisfies ExportedHandler<Env>;
