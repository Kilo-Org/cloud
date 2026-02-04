/**
 * Execution CRUD operations for CloudAgentSession Durable Object.
 *
 * These operations use the DO's key-value storage (not SQLite) to track
 * execution metadata for WebSocket streaming support.
 */

import type { ExecutionId } from '../../types/ids.js';
import type { ExecutionStatus } from '../../core/execution.js';
import { canTransition, isTerminal } from '../../core/execution.js';
import type {
  ExecutionMetadata,
  AddExecutionParams,
  UpdateExecutionStatusParams,
} from '../types.js';
import { Ok, Err, type Result } from '../../lib/result.js';

// ---------------------------------------------------------------------------
// Storage Keys
// ---------------------------------------------------------------------------

const EXECUTIONS_KEY = 'executions';
const ACTIVE_EXECUTION_KEY = 'active_execution_id';
const INTERRUPT_KEY = 'interrupt_requested';

/** Storage interface for key-value operations */
type KVStorage = DurableObjectState['storage'];

// ---------------------------------------------------------------------------
// Error Types
// ---------------------------------------------------------------------------

export type AddExecutionError = { code: 'ALREADY_EXISTS' };

export type UpdateStatusError =
  | { code: 'NOT_FOUND' }
  | { code: 'INVALID_TRANSITION'; from: ExecutionStatus; to: ExecutionStatus };

export type SetActiveError = { code: 'ALREADY_ACTIVE'; currentExecutionId: ExecutionId };

// ---------------------------------------------------------------------------
// Query Factory
// ---------------------------------------------------------------------------

/**
 * Create execution query functions bound to a DurableObject storage.
 *
 * @param storage - The storage instance from the DO context
 * @returns Object with execution query methods
 */
export function createExecutionQueries(storage: KVStorage) {
  return {
    /**
     * Get all executions for this session.
     */
    async getAll(): Promise<ExecutionMetadata[]> {
      return (await storage.get<ExecutionMetadata[]>(EXECUTIONS_KEY)) ?? [];
    },

    /**
     * Get a specific execution by ID.
     */
    async get(executionId: ExecutionId): Promise<ExecutionMetadata | null> {
      const executions = await this.getAll();
      return executions.find(e => e.executionId === executionId) ?? null;
    },

    /**
     * Add a new execution with initial 'pending' status.
     * Returns Err if an execution with the same ID already exists.
     */
    async add(params: AddExecutionParams): Promise<Result<ExecutionMetadata, AddExecutionError>> {
      const executions = await this.getAll();

      if (executions.some(e => e.executionId === params.executionId)) {
        return Err({ code: 'ALREADY_EXISTS' });
      }

      const execution: ExecutionMetadata = {
        executionId: params.executionId,
        status: 'pending',
        startedAt: Date.now(),
        mode: params.mode,
        streamingMode: params.streamingMode,
        ingestToken: params.ingestToken,
      };

      executions.push(execution);
      await storage.put(EXECUTIONS_KEY, executions);

      return Ok(execution);
    },

    /**
     * Update execution status with state machine validation.
     * Automatically clears active execution when transitioning to terminal state.
     */
    async updateStatus(
      params: UpdateExecutionStatusParams
    ): Promise<Result<ExecutionMetadata, UpdateStatusError>> {
      const executions = await this.getAll();
      const index = executions.findIndex(e => e.executionId === params.executionId);

      if (index === -1) {
        return Err({ code: 'NOT_FOUND' });
      }

      const execution = executions[index];

      if (!canTransition(execution.status, params.status)) {
        return Err({
          code: 'INVALID_TRANSITION',
          from: execution.status,
          to: params.status,
        });
      }

      execution.status = params.status;

      if (params.error !== undefined) {
        execution.error = params.error;
      }

      if (params.completedAt !== undefined) {
        execution.completedAt = params.completedAt;
      } else if (isTerminal(params.status)) {
        execution.completedAt = Date.now();
      }

      executions[index] = execution;
      await storage.put(EXECUTIONS_KEY, executions);

      // Clear active execution if terminal
      if (isTerminal(params.status)) {
        const activeId = await storage.get<ExecutionId>(ACTIVE_EXECUTION_KEY);
        if (activeId === params.executionId) {
          await storage.delete(ACTIVE_EXECUTION_KEY);
        }
      }

      return Ok(execution);
    },

    /**
     * Update execution heartbeat timestamp.
     * Returns false if execution not found.
     */
    async updateHeartbeat(executionId: ExecutionId, timestamp: number): Promise<boolean> {
      const executions = await this.getAll();
      const index = executions.findIndex(e => e.executionId === executionId);

      if (index === -1) return false;

      executions[index].lastHeartbeat = timestamp;
      await storage.put(EXECUTIONS_KEY, executions);

      return true;
    },

    /**
     * Set process ID for long-running executions.
     * Returns false if execution not found.
     */
    async setProcessId(executionId: ExecutionId, processId: string): Promise<boolean> {
      const executions = await this.getAll();
      const index = executions.findIndex(e => e.executionId === executionId);

      if (index === -1) return false;

      executions[index].processId = processId;
      await storage.put(EXECUTIONS_KEY, executions);

      return true;
    },

    /**
     * Get the currently active execution ID, if any.
     */
    async getActiveExecutionId(): Promise<ExecutionId | null> {
      return (await storage.get<ExecutionId>(ACTIVE_EXECUTION_KEY)) ?? null;
    },

    /**
     * Set the active execution for this session.
     * Enforces single active execution per session.
     *
     * SAFETY NOTE: This check-then-set pattern is safe because Durable Objects
     * serialize all incoming requests within a single instance. There is no
     * concurrent execution of RPC methods within a DO, so no race condition
     * can occur between the read and write operations.
     */
    async setActiveExecution(executionId: ExecutionId): Promise<Result<void, SetActiveError>> {
      const currentActive = await this.getActiveExecutionId();

      if (currentActive !== null && currentActive !== executionId) {
        return Err({
          code: 'ALREADY_ACTIVE',
          currentExecutionId: currentActive,
        });
      }

      await storage.put(ACTIVE_EXECUTION_KEY, executionId);
      return Ok(undefined);
    },

    /**
     * Clear the active execution.
     */
    async clearActiveExecution(): Promise<void> {
      await storage.delete(ACTIVE_EXECUTION_KEY);
    },

    /**
     * Check if interrupt was requested for the current execution.
     */
    async isInterruptRequested(): Promise<boolean> {
      return (await storage.get<boolean>(INTERRUPT_KEY)) ?? false;
    },

    /**
     * Request interrupt for the current execution.
     */
    async requestInterrupt(): Promise<void> {
      await storage.put(INTERRUPT_KEY, true);
    },

    /**
     * Clear the interrupt flag.
     */
    async clearInterrupt(): Promise<void> {
      await storage.delete(INTERRUPT_KEY);
    },
  };
}

export type ExecutionQueries = ReturnType<typeof createExecutionQueries>;
