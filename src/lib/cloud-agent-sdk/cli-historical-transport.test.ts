/**
 * Tests for CliHistoricalTransport — verifies snapshot replay order,
 * error handling, and lifecycle generation tracking.
 */
import type { ChatEvent, ServiceEvent } from './normalizer';
import type { KiloSessionId, SessionSnapshot } from './types';
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
