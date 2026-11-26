import type { Env } from './env';
import { handleRequest } from './http';

export default {
  fetch: handleRequest,
} satisfies ExportedHandler<Env>;
