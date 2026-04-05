/**
 * EventStore - Manages event ring buffer and persistence.
 * Handles event creation, storage, and trimming based on last processed event.
 */

import type { Event } from './types';

const MAX_EVENTS = 5000;

/**
 * EventStore manages a bounded ring buffer of events with delivery-aware trimming.
 *
 * Features:
 * - Ring buffer with configurable maximum size (MAX_EVENTS)
 * - Delivery-aware trimming to preserve unprocessed events
 * - Automatic persistence to durable storage
 * - Sequential event ID generation
 * - Tracks last processed event ID for trimming decisions
 */
export class EventStore {
  /** In-memory ring buffer of events */
  private eventsList: Event[] = [];
  /** Last processed event ID (-1 means no events processed yet) */
  private lastProcessedId: number = -1;

  constructor(private storage: DurableObjectStorage) {}

  /**
   * Load events and lastProcessedId from durable storage into memory.
   */
  async loadEvents(): Promise<void> {
    const storedEvents = await this.storage.get<Event[]>('events');
    if (storedEvents) {
      this.eventsList = storedEvents;
    }

    const storedLastProcessedId = await this.storage.get<number>('lastProcessedId');
    if (storedLastProcessedId !== undefined) {
      this.lastProcessedId = storedLastProcessedId;
    }
  }

  /**
   * Add an event to the ring buffer.
   * Automatically trims oldest events if buffer exceeds size limits.
   * Returns the created event so caller can use its timestamp.
   *
   * @param eventData - The event envelope to add (without id and ts which are auto-generated)
   * @returns The created event with id and timestamp
   */
  async addEvent(eventData: Omit<Event, 'id' | 'ts'>): Promise<Event> {
    // Calculate next event ID based on last event in list
    const lastEvent = this.eventsList[this.eventsList.length - 1];
    const nextEventId = lastEvent ? lastEvent.id + 1 : 0;

    const event = {
      ...eventData,
      id: nextEventId,
      ts: new Date().toISOString(),
    } as Event;

    this.eventsList.push(event);

    // Trim ring buffer if it exceeds limits
    await this.trimEvents();

    // Persist changes
    await this.storage.put('events', this.eventsList);

    return event;
  }

  /**
   * Get all events in the buffer.
   *
   * @returns Array of all events
   */
  getEvents(): Event[] {
    return this.eventsList;
  }

  /**
   * Get unprocessed events (events with id > lastProcessedId).
   *
   * @param limit - Optional maximum number of events to return
   * @returns Array of unprocessed events, optionally limited
   */
  getUnprocessedEvents(limit?: number): Event[] {
    const index = this.getFirstUnprocessedEventIndex();
    if (index === null) {
      return [];
    }

    // Slice from calculated index, applying limit if provided
    return this.eventsList.slice(index, limit !== undefined ? index + limit : undefined);
  }

  getFirstUnprocessedEvent(): Event | null {
    const index = this.getFirstUnprocessedEventIndex();
    if (index === null) {
      return null;
    }

    return this.eventsList[index];
  }

  getFirstUnprocessedEventIndex(): number | null {
    if (this.eventsList.length === 0) {
      return null;
    }

    // Calculate starting index based on first event ID and lastProcessedId
    const firstEventId = this.eventsList[0].id;
    const startIndex = this.lastProcessedId - firstEventId + 1;

    // Handle edge cases
    if (startIndex >= this.eventsList.length) {
      // All events have been processed
      return null;
    }

    // If startIndex is negative or 0, start from beginning
    return Math.max(0, startIndex);
  }

  /**
   * Get the last processed event ID.
   *
   * @returns The last processed event ID (-1 if no events processed yet)
   */
  getLastProcessedId(): number {
    return this.lastProcessedId;
  }

  /**
   * Set the last processed event ID and persist it to storage.
   *
   * @param id - The event ID to mark as last processed
   */
  async setLastProcessedId(id: number): Promise<void> {
    this.lastProcessedId = id;
    await this.storage.put('lastProcessedId', this.lastProcessedId);
  }

  /**
   * Trim events ring buffer to stay within size limits while preserving unprocessed events.
   *
   * This method implements delivery-aware trimming to ensure at-least-once delivery semantics:
   * - Only trims events that have been successfully processed (event.id <= lastProcessedId)
   * - Preserves all unprocessed events (event.id > lastProcessedId) even if total exceeds MAX_EVENTS
   * - If all events are unprocessed and buffer is full, logs a warning but does not trim
   *
   * This guarantees that no events are dropped before successful processing,
   * temporarily allowing the buffer to exceed MAX_EVENTS if necessary.
   */
  private async trimEvents(): Promise<void> {
    // Only trim events that have been successfully processed
    while (this.eventsList.length > MAX_EVENTS && this.eventsList[0].id <= this.lastProcessedId) {
      this.eventsList.shift();
    }

    // Safety check: warn if we can't trim because all events are unprocessed
    if (this.eventsList.length > MAX_EVENTS) {
      console.warn(
        `Event buffer exceeded MAX_EVENTS (${MAX_EVENTS}) but cannot trim - all events are unprocessed. ` +
          `Current size: ${this.eventsList.length}, lastProcessedId: ${this.lastProcessedId}`
      );
    }
  }
}
