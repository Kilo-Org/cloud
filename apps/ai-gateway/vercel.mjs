import { usageQueueDeployment } from './src/usage-queue/deployment.mjs';

export const config = {
  buildCommand: 'pnpm run build',
  regions: ['fra1', 'sfo1'],
  skipMiddlewareRequestBody: true,
  ...usageQueueDeployment(process.env),
};
