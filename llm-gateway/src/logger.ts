import { WorkersLogger } from 'workers-tagged-logger';

export type LlmGatewayTags = {
  userId?: string;
  organizationId?: string;
  model?: string;
  provider?: string;
  requestId?: string;
};

export const logger = new WorkersLogger<LlmGatewayTags>({ minimumLogLevel: 'debug' });
export { withLogTags } from 'workers-tagged-logger';
