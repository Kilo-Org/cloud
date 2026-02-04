import { stripVTControlCharacters } from 'node:util';
import type { IngestEvent } from '../../src/shared/protocol.js';

export function stripAnsi(str: string): string {
  return stripVTControlCharacters(str);
}

export function parseKilocodeOutput(line: string): IngestEvent {
  const timestamp = new Date().toISOString();

  const candidates = [line, stripAnsi(line)];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      return { streamEventType: 'kilocode', data: parsed, timestamp };
    } catch {
      // try next candidate
    }
  }

  const clean = stripAnsi(line);
  return { streamEventType: 'output', data: { content: clean, source: 'stdout' }, timestamp };
}

export type TerminalCheck = { isTerminal: true; reason: string } | { isTerminal: false };

export function isTerminalEvent(data: Record<string, unknown>): TerminalCheck {
  if (data.event === 'payment_required') {
    return { isTerminal: true, reason: 'Payment required' };
  }
  if (data.event === 'insufficient_funds') {
    return { isTerminal: true, reason: 'Insufficient funds' };
  }
  if (data.type === 'ask' && data.ask === 'api_req_failed') {
    const text = String(data.text ?? '');
    if (text.includes('payment') || text.includes('credit') || text.includes('balance')) {
      return { isTerminal: true, reason: 'API request failed: payment issue' };
    }
  }
  return { isTerminal: false };
}
