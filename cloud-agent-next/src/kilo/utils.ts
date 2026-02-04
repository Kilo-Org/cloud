import { isExecutionId, type ExecutionId } from '../types/ids.js';
import { KiloClientError } from './errors.js';

/**
 * Convert an execution ID to a message ID for kilo server.
 *
 * Since executionId is now in msg_<uuid> format, this is an identity function.
 * It validates the input and returns it unchanged.
 *
 * @param executionId - The execution ID to convert
 * @returns The message ID (same as input for msg_ format)
 */
export const executionIdToMessageId = (executionId: string): string => {
  if (!isExecutionId(executionId)) {
    throw new KiloClientError(`Invalid executionId: "${executionId}". Expected prefix "msg_".`);
  }
  // executionId === messageId (identity function)
  return executionId;
};

/**
 * @deprecated Use executionIdToMessageId instead. This alias exists for migration clarity.
 */
export const asMessageId = executionIdToMessageId;

/**
 * Type-safe extraction of the UUID portion from an execution/message ID.
 */
export const extractUuid = (id: ExecutionId): string => {
  return id.replace(/^msg_/, '');
};
