/**
 * Tests for CliHistoricalTransport — verifies snapshot replay order,
 * error handling, and lifecycle generation tracking.
 */
import type { ChatEvent, ServiceEvent } from './normalizer';
import type {
  KiloSessionId,
  SessionSnapshot,
  SessionSnapshotPage,
  SessionSnapshotPageOutcome,
} from './types';
import { createCliHistoricalTransport } from './cli-historical-transport';
import { kiloId, makeSnapshot, stubUserMessage, stubTextPart } from './test-helpers';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SES_ID = 'ses-1';

function createTransportWithSinks(
  fetchSnapshot: (kiloSessionId: KiloSessionId) => Promise<SessionSnapshot>,
  onError?: (message: string) => void
) {
  const chatEvents: ChatEvent[] = [];
  const serviceEvents: ServiceEvent[] = [];

  const factory = createCliHistoricalTransport({
    kiloSessionId: kiloId('kilo-ses-1'),
    fetchSnapshot,
    onError,
  });

  const transport = factory({
    onChatEvent: event => chatEvents.push(event),
    onServiceEvent: event => serviceEvents.push(event),
  });

  return { transport, chatEvents, serviceEvents };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CliHistoricalTransport', () => {
  it('replays snapshot in correct order', async () => {
    const snapshot = makeSnapshot({ id: SES_ID }, [
      {
        info: stubUserMessage({ id: 'msg-1', sessionID: SES_ID }),
        parts: [
          stubTextPart({ id: 'part-1a', messageID: 'msg-1', sessionID: SES_ID, text: 'hi' }),
          stubTextPart({ id: 'part-1b', messageID: 'msg-1', sessionID: SES_ID, text: 'there' }),
        ],
      },
      {
        info: stubUserMessage({ id: 'msg-2', sessionID: SES_ID }),
        parts: [
          stubTextPart({ id: 'part-2a', messageID: 'msg-2', sessionID: SES_ID, text: 'hello' }),
        ],
      },
    ]);

    const { transport, chatEvents, serviceEvents } = createTransportWithSinks(() =>
      Promise.resolve(snapshot)
    );

    transport.connect();
    await Promise.resolve();

    // Chat events: msg1, part1a, part1b, msg2, part2a
    expect(chatEvents).toHaveLength(5);
    expect(chatEvents[0]).toEqual(
      expect.objectContaining({ type: 'message.updated', info: snapshot.messages[0].info })
    );
    expect(chatEvents[1]).toEqual(
      expect.objectContaining({ type: 'message.part.updated', part: snapshot.messages[0].parts[0] })
    );
    expect(chatEvents[2]).toEqual(
      expect.objectContaining({ type: 'message.part.updated', part: snapshot.messages[0].parts[1] })
    );
    expect(chatEvents[3]).toEqual(
      expect.objectContaining({ type: 'message.updated', info: snapshot.messages[1].info })
    );
    expect(chatEvents[4]).toEqual(
      expect.objectContaining({ type: 'message.part.updated', part: snapshot.messages[1].parts[0] })
    );

    // Service events: session.created, stopped(complete)
    expect(serviceEvents).toHaveLength(2);
    expect(serviceEvents[0]).toEqual(
      expect.objectContaining({ type: 'session.created', info: snapshot.info })
    );
    expect(serviceEvents[1]).toEqual({ type: 'stopped', reason: 'complete' });

    transport.destroy();
  });

  it('fires session.created and stopped for empty snapshot', async () => {
    const snapshot = makeSnapshot({ id: SES_ID });

    const { transport, chatEvents, serviceEvents } = createTransportWithSinks(() =>
      Promise.resolve(snapshot)
    );

    transport.connect();
    await Promise.resolve();

    expect(chatEvents).toHaveLength(0);
    expect(serviceEvents).toHaveLength(2);
    expect(serviceEvents[0]).toEqual(
      expect.objectContaining({ type: 'session.created', info: snapshot.info })
    );
    expect(serviceEvents[1]).toEqual({ type: 'stopped', reason: 'complete' });

    transport.destroy();
  });

  it('handles fetch error gracefully', async () => {
    const onError = jest.fn();

    const { transport, chatEvents, serviceEvents } = createTransportWithSinks(
      () => Promise.reject(new Error('Network failure')),
      onError
    );

    transport.connect();
    await Promise.resolve();

    expect(onError).toHaveBeenCalledWith('Network failure');
    expect(chatEvents).toHaveLength(0);
    expect(serviceEvents).toHaveLength(1);
    expect(serviceEvents[0]).toEqual({ type: 'stopped', reason: 'error' });

    transport.destroy();
  });

  it('disconnect cancels pending fetch', async () => {
    let resolveSnapshot: ((snapshot: SessionSnapshot) => void) | undefined;
    const fetchSnapshot = () =>
      new Promise<SessionSnapshot>(resolve => {
        resolveSnapshot = resolve;
      });

    const { transport, chatEvents, serviceEvents } = createTransportWithSinks(fetchSnapshot);

    transport.connect();
    transport.disconnect();

    // Resolve after disconnect — should be discarded
    resolveSnapshot?.(
      makeSnapshot({ id: SES_ID }, [
        {
          info: stubUserMessage({ id: 'msg-1', sessionID: SES_ID }),
          parts: [],
        },
      ])
    );
    await Promise.resolve();

    expect(chatEvents).toHaveLength(0);
    expect(serviceEvents).toHaveLength(0);
  });

  it('destroy cancels pending fetch', async () => {
    let resolveSnapshot: ((snapshot: SessionSnapshot) => void) | undefined;
    const fetchSnapshot = () =>
      new Promise<SessionSnapshot>(resolve => {
        resolveSnapshot = resolve;
      });

    const { transport, chatEvents, serviceEvents } = createTransportWithSinks(fetchSnapshot);

    transport.connect();
    transport.destroy();

    // Resolve after destroy — should be discarded
    resolveSnapshot?.(
      makeSnapshot({ id: SES_ID }, [
        {
          info: stubUserMessage({ id: 'msg-1', sessionID: SES_ID }),
          parts: [],
        },
      ])
    );
    await Promise.resolve();

    expect(chatEvents).toHaveLength(0);
    expect(serviceEvents).toHaveLength(0);
  });

  it('exposes no command methods (read-only transport)', async () => {
    const snapshot = makeSnapshot({ id: SES_ID });
    const { transport } = createTransportWithSinks(() => Promise.resolve(snapshot));

    expect(transport.send).toBeUndefined();
    expect(transport.interrupt).toBeUndefined();
    expect(transport.answer).toBeUndefined();
    expect(transport.reject).toBeUndefined();
    expect(transport.respondToPermission).toBeUndefined();

    transport.destroy();
  });
});

// ---------------------------------------------------------------------------
// Page-seam: transport uses fetchSnapshotPage when provided so the manager can
// record the cursor and the user can load older pages later. Legacy
// `fetchSnapshot` is preserved for callers that haven't migrated.
// ---------------------------------------------------------------------------

type FetchPage = (
  kiloSessionId: KiloSessionId,
  options: { cursor?: string }
) => Promise<SessionSnapshotPageOutcome | null>;

type CreatePageTransportOptions = {
  fetchSnapshotPage: FetchPage;
  fetchSnapshot?: (kiloSessionId: KiloSessionId) => Promise<SessionSnapshot>;
  onInitialPageLoaded?: (page: SessionSnapshotPage) => void;
  onError?: (message: string) => void;
};

function createPageTransport(options: CreatePageTransportOptions) {
  const chatEvents: ChatEvent[] = [];
  const serviceEvents: ServiceEvent[] = [];
  const fetchSnapshotPage = jest.fn(options.fetchSnapshotPage);
  const onInitialPageLoaded = jest.fn(options.onInitialPageLoaded ?? (() => undefined));
  const onError = jest.fn(options.onError ?? (() => undefined));

  const factory = createCliHistoricalTransport({
    kiloSessionId: kiloId('kilo-ses-1'),
    fetchSnapshotPage,
    ...(options.fetchSnapshot ? { fetchSnapshot: options.fetchSnapshot } : {}),
    onInitialPageLoaded,
    onError,
  });

  const transport = factory({
    onChatEvent: event => chatEvents.push(event),
    onServiceEvent: event => serviceEvents.push(event),
  });

  return { transport, chatEvents, serviceEvents, fetchSnapshotPage, onInitialPageLoaded, onError };
}

function makeSuccessPage(
  options: {
    kiloSessionId?: string;
    messages?: SessionSnapshot['messages'];
    nextCursor?: string | null;
    omittedItemCount?: number;
  } = {}
): Extract<SessionSnapshotPageOutcome, { kind: 'success' }> {
  return {
    kind: 'success',
    info: { id: options.kiloSessionId ?? 'kilo-ses-1' },
    messages: options.messages ?? [],
    nextCursor: options.nextCursor ?? null,
    omittedItemCount: options.omittedItemCount ?? 0,
  };
}

describe('CliHistoricalTransport page-seam', () => {
  it('replays a successful page and reports it via onInitialPageLoaded', async () => {
    const page = makeSuccessPage({
      kiloSessionId: 'kilo-ses-1',
      nextCursor: 'cursor-A',
      omittedItemCount: 3,
      messages: [
        {
          info: stubUserMessage({ id: 'msg-1', sessionID: 'kilo-ses-1' }),
          parts: [
            stubTextPart({
              id: 'part-1',
              sessionID: 'kilo-ses-1',
              messageID: 'msg-1',
              text: 'hello',
            }),
          ],
        },
      ],
    });
    const { transport, fetchSnapshotPage, onInitialPageLoaded, chatEvents, serviceEvents } =
      createPageTransport({ fetchSnapshotPage: async () => page });

    transport.connect();
    await Promise.resolve();
    await Promise.resolve();

    expect(fetchSnapshotPage).toHaveBeenCalledWith('kilo-ses-1', {});
    expect(onInitialPageLoaded).toHaveBeenCalledWith(page);
    expect(chatEvents).toHaveLength(2);
    expect(serviceEvents).toEqual([
      expect.objectContaining({ type: 'session.created', info: page.info }),
      { type: 'stopped', reason: 'complete' },
    ]);
    transport.destroy();
  });

  it('replays a successful page with no cursor and zero omitted items', async () => {
    const page = makeSuccessPage({ nextCursor: null, omittedItemCount: 0 });
    const { transport, onInitialPageLoaded, serviceEvents } = createPageTransport({
      fetchSnapshotPage: async () => page,
    });

    transport.connect();
    await Promise.resolve();
    await Promise.resolve();

    expect(onInitialPageLoaded).toHaveBeenCalledWith(page);
    expect(serviceEvents).toEqual([
      expect.objectContaining({ type: 'session.created' }),
      { type: 'stopped', reason: 'complete' },
    ]);
    transport.destroy();
  });

  it('surfaces retryable_failure as a recoverable error message and stops with error', async () => {
    const { transport, onError, serviceEvents, onInitialPageLoaded } = createPageTransport({
      fetchSnapshotPage: async () => ({ kind: 'retryable_failure' }),
    });

    transport.connect();
    await Promise.resolve();
    await Promise.resolve();

    expect(onError).toHaveBeenCalledWith('Session history temporarily unavailable');
    expect(onInitialPageLoaded).not.toHaveBeenCalled();
    expect(serviceEvents).toEqual([{ type: 'stopped', reason: 'error' }]);
    transport.destroy();
  });

  it('surfaces too_large as a non-retryable terminal message and stops with error', async () => {
    const { transport, onError, serviceEvents, onInitialPageLoaded } = createPageTransport({
      fetchSnapshotPage: async () => ({ kind: 'too_large' }),
    });

    transport.connect();
    await Promise.resolve();
    await Promise.resolve();

    expect(onError).toHaveBeenCalledWith('Session history too large to load');
    expect(onInitialPageLoaded).not.toHaveBeenCalled();
    expect(serviceEvents).toEqual([{ type: 'stopped', reason: 'error' }]);
    transport.destroy();
  });

  it('surfaces invalid_data as a non-retryable terminal message and stops with error', async () => {
    const { transport, onError, serviceEvents } = createPageTransport({
      fetchSnapshotPage: async () => ({ kind: 'invalid_data' }),
    });

    transport.connect();
    await Promise.resolve();
    await Promise.resolve();

    expect(onError).toHaveBeenCalledWith('Session history is unavailable');
    expect(serviceEvents).toEqual([{ type: 'stopped', reason: 'error' }]);
    transport.destroy();
  });

  it('treats a null page result as session not found and stops with error', async () => {
    const { transport, onError, serviceEvents, onInitialPageLoaded } = createPageTransport({
      fetchSnapshotPage: async () => null,
    });

    transport.connect();
    await Promise.resolve();
    await Promise.resolve();

    expect(onError).toHaveBeenCalledWith('Session not found');
    expect(onInitialPageLoaded).not.toHaveBeenCalled();
    expect(serviceEvents).toEqual([{ type: 'stopped', reason: 'error' }]);
    transport.destroy();
  });

  it('surfaces a thrown fetch error via onError and stops with error', async () => {
    const { transport, onError, serviceEvents } = createPageTransport({
      fetchSnapshotPage: async () => {
        throw new Error('Network failure');
      },
    });

    transport.connect();
    await Promise.resolve();
    await Promise.resolve();

    expect(onError).toHaveBeenCalledWith('Network failure');
    expect(serviceEvents).toEqual([{ type: 'stopped', reason: 'error' }]);
    transport.destroy();
  });

  it('disconnect cancels a pending initial page fetch', async () => {
    let resolvePage: ((page: SessionSnapshotPageOutcome) => void) | undefined;
    const { transport, chatEvents, serviceEvents, onInitialPageLoaded } = createPageTransport({
      fetchSnapshotPage: () =>
        new Promise<SessionSnapshotPageOutcome | null>(resolve => {
          resolvePage = resolve;
        }),
    });

    transport.connect();
    transport.disconnect();

    resolvePage?.(makeSuccessPage({ nextCursor: 'cursor-A' }));
    await Promise.resolve();
    await Promise.resolve();

    expect(onInitialPageLoaded).not.toHaveBeenCalled();
    expect(chatEvents).toHaveLength(0);
    expect(serviceEvents).toHaveLength(0);
    transport.destroy();
  });

  it('destroy cancels a pending initial page fetch', async () => {
    let resolvePage: ((page: SessionSnapshotPageOutcome) => void) | undefined;
    const { transport, chatEvents, serviceEvents, onInitialPageLoaded } = createPageTransport({
      fetchSnapshotPage: () =>
        new Promise<SessionSnapshotPageOutcome | null>(resolve => {
          resolvePage = resolve;
        }),
    });

    transport.connect();
    transport.destroy();

    resolvePage?.(makeSuccessPage({ nextCursor: 'cursor-A' }));
    await Promise.resolve();
    await Promise.resolve();

    expect(onInitialPageLoaded).not.toHaveBeenCalled();
    expect(chatEvents).toHaveLength(0);
    expect(serviceEvents).toHaveLength(0);
  });

  it('prefers fetchSnapshotPage over legacy fetchSnapshot when both are provided', async () => {
    const page = makeSuccessPage({ nextCursor: 'cursor-A' });
    const fetchSnapshot = jest.fn(() =>
      Promise.reject(new Error('legacy fetchSnapshot must not be called'))
    );
    const { transport, fetchSnapshotPage, onInitialPageLoaded } = createPageTransport({
      fetchSnapshotPage: async () => page,
      fetchSnapshot,
    });

    transport.connect();
    await Promise.resolve();
    await Promise.resolve();

    expect(fetchSnapshotPage).toHaveBeenCalledTimes(1);
    expect(fetchSnapshot).not.toHaveBeenCalled();
    expect(onInitialPageLoaded).toHaveBeenCalledWith(page);
    transport.destroy();
  });

  it('falls back to legacy fetchSnapshot when fetchSnapshotPage is omitted', async () => {
    const snapshot = makeSnapshot({ id: SES_ID }, [
      {
        info: stubUserMessage({ id: 'msg-1', sessionID: SES_ID }),
        parts: [stubTextPart({ id: 'part-1', sessionID: SES_ID, messageID: 'msg-1', text: 'hi' })],
      },
    ]);
    const onInitialPageLoaded = jest.fn();
    const onError = jest.fn();
    const fetchSnapshot = jest.fn(() => Promise.resolve(snapshot));
    const chatEvents: ChatEvent[] = [];
    const serviceEvents: ServiceEvent[] = [];

    const factory = createCliHistoricalTransport({
      kiloSessionId: kiloId('kilo-ses-1'),
      fetchSnapshot,
      onInitialPageLoaded,
      onError,
    });
    const transport = factory({
      onChatEvent: event => chatEvents.push(event),
      onServiceEvent: event => serviceEvents.push(event),
    });

    transport.connect();
    await Promise.resolve();
    await Promise.resolve();

    expect(fetchSnapshot).toHaveBeenCalledWith('kilo-ses-1');
    expect(onInitialPageLoaded).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(chatEvents).toHaveLength(2);
    expect(serviceEvents).toEqual([
      expect.objectContaining({ type: 'session.created' }),
      { type: 'stopped', reason: 'complete' },
    ]);
    transport.destroy();
  });
});
