/**
 * SSEStreamProcessor
 *
 * Generic SSE (Server-Sent Events) stream processing service.
 * Handles SSE parsing, buffer management, and error handling.
 */

type StreamEventHandler = {
  onSessionId?: (sessionId: string) => void;
  onTextContent?: (text: string) => void;
  onKilocodeEvent?: (payload: Record<string, unknown>) => void;
  onComplete?: () => void;
  onError?: (error: Error) => void;
};

type StreamMetrics = {
  totalEvents: number;
  errorEvents: number;
  parseErrors: number;
  eventTypeCounts: Record<string, number>;
  startTime: number;
  endTime?: number;
};

export class SSEStreamProcessor {
  /** Maximum time to wait for SSE stream (20 minutes) */
  private static readonly STREAM_TIMEOUT_MS = 20 * 60 * 1000;

  /**
   * Process an SSE stream with custom event handlers
   */
  async processStream(
    response: Response,
    handlers: StreamEventHandler,
    timeoutMs: number = SSEStreamProcessor.STREAM_TIMEOUT_MS
  ): Promise<void> {
    // Add timeout protection
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error('SSE stream timeout - processing exceeded maximum time limit')),
        timeoutMs
      )
    );

    await Promise.race([this.processStreamInternal(response, handlers), timeoutPromise]);
  }

  /**
   * Internal stream processing with metrics tracking
   */
  private async processStreamInternal(
    response: Response,
    handlers: StreamEventHandler
  ): Promise<void> {
    if (!response.body) {
      throw new Error('No response body from stream');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    // Initialize metrics
    const metrics: StreamMetrics = {
      totalEvents: 0,
      errorEvents: 0,
      parseErrors: 0,
      eventTypeCounts: {},
      startTime: Date.now(),
    };

    console.log('[SSEStreamProcessor] Starting stream processing');

    try {
      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          metrics.endTime = Date.now();
          const durationMs = metrics.endTime - metrics.startTime;
          console.log('[SSEStreamProcessor] Stream ended naturally', {
            ...metrics,
            durationMs,
            durationSeconds: Math.floor(durationMs / 1000),
          });
          break;
        }

        buffer += decoder.decode(value, { stream: true });

        // Process complete lines
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6);

            if (data === '' || data === ':ping') {
              continue;
            }

            try {
              const event = JSON.parse(data);
              metrics.totalEvents++;

              // Track event type counts
              const eventType = event.streamEventType || 'unknown';
              metrics.eventTypeCounts[eventType] = (metrics.eventTypeCounts[eventType] || 0) + 1;

              // Extract sessionId from first event
              if (handlers.onSessionId && event.sessionId) {
                handlers.onSessionId(event.sessionId);
              }

              // Extract text content from kilocode events
              if (event.streamEventType === 'kilocode' && event.payload) {
                // Call raw event handler if provided
                if (handlers.onKilocodeEvent) {
                  handlers.onKilocodeEvent(event.payload as Record<string, unknown>);
                }

                if (handlers.onTextContent) {
                  if (typeof event.payload.content === 'string') {
                    handlers.onTextContent(event.payload.content);
                  } else if (
                    event.payload.type === 'text' &&
                    typeof event.payload.text === 'string'
                  ) {
                    handlers.onTextContent(event.payload.text);
                  }
                }
              }
              // Also check for output events
              else if (
                handlers.onTextContent &&
                event.streamEventType === 'output' &&
                event.content
              ) {
                handlers.onTextContent(event.content);
              }

              // Handle completion event
              if (event.streamEventType === 'complete') {
                console.log('[SSEStreamProcessor] Stream completion event received', {
                  totalEvents: metrics.totalEvents,
                });
                if (handlers.onComplete) {
                  handlers.onComplete();
                }
                break;
              }

              // Handle error event
              if (event.streamEventType === 'error') {
                metrics.errorEvents++;
                const error = new Error(`Stream error: ${event.message || 'Unknown error'}`);

                // Log the error event details for debugging
                console.warn('[SSEStreamProcessor] Error event received', {
                  message: event.message,
                  errorDetails: event.error,
                  eventNumber: metrics.totalEvents,
                  totalErrorEvents: metrics.errorEvents,
                });

                if (handlers.onError) {
                  handlers.onError(error);
                }

                // Don't throw - error events are informational
                // The stream should continue processing unless explicitly terminated
                continue;
              }
            } catch (parseError) {
              metrics.parseErrors++;
              // Enhanced logging for parse errors
              console.warn('[SSEStreamProcessor] Failed to parse SSE event', {
                eventNumber: metrics.totalEvents + 1,
                parseErrorCount: metrics.parseErrors,
                dataLength: data.length,
                dataPreview: data.slice(0, 100),
                errorType: parseError?.constructor?.name,
                errorMessage: parseError instanceof Error ? parseError.message : String(parseError),
              });
              // Skip invalid JSON and continue processing
              continue;
            }
          }
        }
      }
    } finally {
      reader.releaseLock();

      // Final summary log
      metrics.endTime = metrics.endTime || Date.now();
      const durationMs = metrics.endTime - metrics.startTime;
      console.log('[SSEStreamProcessor] Stream processing complete', {
        ...metrics,
        durationMs,
        durationSeconds: Math.floor(durationMs / 1000),
        finalBufferSize: buffer.length,
      });
    }
  }
}
