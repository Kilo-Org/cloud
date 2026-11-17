import { WorkersLogger } from 'workers-tagged-logger';

export const logger = new WorkersLogger({
  minimumLogLevel: 'debug',
});
