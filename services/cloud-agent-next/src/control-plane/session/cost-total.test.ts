import { describe, expect, it } from 'vitest';
import { messageCostContribution } from './cost-total.js';

const sessionId = 'workspace_test';
const kiloSessionId = 'ses_test';

function row(
  payload: unknown,
  overrides: Partial<Parameters<typeof messageCostContribution>[0]> = {}
) {
  return {
    session_id: sessionId,
    stream_event_type: 'kilocode',
    entity_id: 'message/msg_test',
    payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
    ...overrides,
  };
}

function v1(info: Record<string, unknown>) {
  return { type: 'message.updated', event: 'message.updated', properties: { info } };
}

function native(message: Record<string, unknown>, sessionID: unknown = kiloSessionId) {
  return {
    type: 'conversation.message.updated',
    event: 'conversation.message.updated',
    properties: { sessionID, message },
  };
}

describe('messageCostContribution', () => {
  it('attributes v1 assistant cost to the payload session', () => {
    expect(
      messageCostContribution(
        row(v1({ id: 'msg_test', sessionID: kiloSessionId, role: 'assistant', cost: 0.25 }))
      )
    ).toEqual({ sessionId, kiloSessionId, dollars: 0.25 });
  });

  it('attributes native assistant cost to the payload session', () => {
    expect(
      messageCostContribution(row(native({ id: 'msg_test', type: 'assistant', cost: 0.125 })))
    ).toEqual({ sessionId, kiloSessionId, dollars: 0.125 });
  });

  it('excludes user messages in both shapes', () => {
    expect(
      messageCostContribution(row(v1({ sessionID: kiloSessionId, role: 'user', cost: 9 })))
    ).toBeNull();
    expect(messageCostContribution(row(native({ type: 'user', cost: 9 })))).toBeNull();
    expect(messageCostContribution(row(native({ type: 'synthetic', cost: 9 })))).toBeNull();
  });

  it('excludes rows without a string sessionID or without assistant identity', () => {
    expect(messageCostContribution(row(v1({ role: 'assistant', cost: 1 })))).toBeNull();
    expect(
      messageCostContribution(row(v1({ sessionID: 42, role: 'assistant', cost: 1 })))
    ).toBeNull();
    expect(messageCostContribution(row(native({ type: 'assistant', cost: 1 }, 42)))).toBeNull();
    expect(messageCostContribution(row(v1({ sessionID: kiloSessionId, cost: 1 })))).toBeNull();
  });

  it('clamps negative cost and ignores non-numeric cost as the SQL scan did', () => {
    const base = { sessionID: kiloSessionId, role: 'assistant' };
    expect(messageCostContribution(row(v1({ ...base, cost: -3 })))?.dollars).toBe(0);
    expect(messageCostContribution(row(v1({ ...base, cost: '0.5' })))?.dollars).toBe(0);
    expect(messageCostContribution(row(v1({ ...base, cost: null })))?.dollars).toBe(0);
    expect(messageCostContribution(row(v1({ ...base, cost: { amount: 1 } })))?.dollars).toBe(0);
    expect(messageCostContribution(row(v1(base)))?.dollars).toBe(0);
  });

  it('mirrors SQLite integer coercion of JSON boolean costs', () => {
    const base = { sessionID: kiloSessionId, role: 'assistant' };
    expect(messageCostContribution(row(v1({ ...base, cost: true })))?.dollars).toBe(1);
    expect(messageCostContribution(row(v1({ ...base, cost: false })))?.dollars).toBe(0);
    expect(messageCostContribution(row(native({ type: 'assistant', cost: true })))?.dollars).toBe(
      1
    );
  });

  it('excludes other event types, stream types, and entity ranges', () => {
    const info = { sessionID: kiloSessionId, role: 'assistant', cost: 1 };
    expect(
      messageCostContribution(
        row({ type: 'message.part.updated', event: 'message.part.updated', properties: { info } })
      )
    ).toBeNull();
    expect(messageCostContribution(row(v1(info), { stream_event_type: 'output' }))).toBeNull();
    expect(messageCostContribution(row(v1(info), { entity_id: 'part/msg_test/prt' }))).toBeNull();
    expect(messageCostContribution(row(v1(info), { entity_id: 'message0' }))).toBeNull();
    expect(messageCostContribution(row(v1(info), { entity_id: null }))).toBeNull();
    expect(messageCostContribution(row(v1(info), { entity_id: 'message/' }))).not.toBeNull();
  });

  it('excludes malformed or unkeyed payloads', () => {
    expect(messageCostContribution(row('not json'))).toBeNull();
    expect(messageCostContribution(row('[]'))).toBeNull();
    expect(messageCostContribution(row({ event: 'message.updated' }))).toBeNull();
    expect(
      messageCostContribution(
        row(v1({ sessionID: kiloSessionId, role: 'assistant', cost: 1 }), {
          payload: '{"event":"message.updated","properties":{"info":[]}}',
        })
      )
    ).toBeNull();
  });

  it('keeps overflow contributions infinite so reads can report the poisoned sum', () => {
    const contribution = messageCostContribution(
      row(
        '{"event":"message.updated","properties":{"info":{"sessionID":"' +
          kiloSessionId +
          '","role":"assistant","cost":1e999}}}'
      )
    );
    expect(contribution?.dollars).toBe(Number.POSITIVE_INFINITY);
  });
});
