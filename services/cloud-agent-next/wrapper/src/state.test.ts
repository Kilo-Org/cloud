import { describe, expect, it } from 'bun:test';
import { WrapperState } from './state';
import type { IngestEvent } from '../../src/shared/protocol';

function event(): IngestEvent {
  return { streamEventType: 'preparing', data: {}, timestamp: new Date().toISOString() };
}

describe('WrapperState send-to-ingest fn lifecycle', () => {
  it('clears the send fn it installed', () => {
    const state = new WrapperState();
    const sent: IngestEvent[] = [];
    const send = (item: IngestEvent) => sent.push(item);
    state.setSendToIngestFn(send);
    state.clearSendToIngestFn(send);
    state.sendToIngest(event());
    expect(sent).toHaveLength(0);
  });

  it('does not clobber a newer connection when a stale channel closes late', () => {
    const state = new WrapperState();
    const stale = () => {};
    const sent: IngestEvent[] = [];
    state.setSendToIngestFn(stale);
    state.setSendToIngestFn(item => sent.push(item));
    state.clearSendToIngestFn(stale);
    state.sendToIngest(event());
    expect(sent).toHaveLength(1);
  });
});
