import { withDORetry as withDORetryBase, type DORetryConfig } from '@kilocode/worker-utils';
import { logger } from '../logger.js';

export function withDORetry<TStub, TResult>(
  getStub: () => TStub,
  operation: (stub: TStub) => Promise<TResult>,
  operationName: string,
  config?: DORetryConfig
): Promise<TResult> {
  return withDORetryBase(getStub, operation, operationName, config, logger);
}
