import type { Event } from './types';

const MAX_EVENTS = 5000;

export class EventStore {
  private eventsList: Event[] = [];
  /** Last processed event ID (-1 means no events processed yet) */
  private lastProcessedId: number = -1;

  constructor(private storage: DurableObjectStorage) {}

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

  async addEvent(eventData: Omit<Event, 'id' | 'ts'>): Promise<Event> {
    const lastEvent = this.eventsList[this.eventsList.length - 1];
    const nextEventId = lastEvent ? lastEvent.id + 1 : 0;

    const event = {
      ...eventData,
      id: nextEventId,
      ts: new Date().toISOString(),
    } as Event;

    this.eventsList.push(event);

    await this.trimEvents();

    await this.storage.put('events', this.eventsList);

    return event;
  }

  getEvents(): Event[] {
    return this.eventsList;
  }

  getUnprocessedEvents(limit?: number): Event[] {
    const index = this.getFirstUnprocessedEventIndex();
    if (index === null) {
      return [];
    }

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

    const firstEventId = this.eventsList[0].id;
    const startIndex = this.lastProcessedId - firstEventId + 1;

    if (startIndex >= this.eventsList.length) {
      // All events have been processed
      return null;
    }

    return Math.max(0, startIndex);
  }

  getLastProcessedId(): number {
    return this.lastProcessedId;
  }

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
    while (this.eventsList.length > MAX_EVENTS && this.eventsList[0].id <= this.lastProcessedId) {
      this.eventsList.shift();
    }

    if (this.eventsList.length > MAX_EVENTS) {
      console.warn(
        `Event buffer exceeded MAX_EVENTS (${MAX_EVENTS}) but cannot trim - all events are unprocessed. ` +
          `Current size: ${this.eventsList.length}, lastProcessedId: ${this.lastProcessedId}`
      );
    }
  }
}
