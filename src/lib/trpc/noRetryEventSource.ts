type EventSourceCtor = new (
  url: string | URL,
  eventSourceInitDict?: EventSourceInit
) => EventSource;

/**
 * Wraps an EventSource implementation so it will not auto-reconnect.
 * The wrapper closes the stream immediately on error, preventing the
 * built-in reconnection loop from firing.
 */
export function createNoRetryEventSource(BaseEventSource: EventSourceCtor): EventSourceCtor {
  return class NoRetryEventSource extends BaseEventSource {
    constructor(url: string | URL, init?: EventSourceInit) {
      super(url, init);
      this.addEventListener('error', () => {
        try {
          this.close();
        } catch {
          // Ignore close failures
        }
      });
    }
  };
}
