/**
 * Event Processor Module
 *
 * Framework-agnostic event processing for cloud-agent stream events.
 *
 * This module provides:
 * - EventProcessor: Core event processing with in-memory state
 * - Type definitions for callbacks and configuration
 */

export { createEventProcessor, type EventProcessor } from './event-processor';
export type { ProcessedMessage, EventProcessorCallbacks, EventProcessorConfig } from './types';
