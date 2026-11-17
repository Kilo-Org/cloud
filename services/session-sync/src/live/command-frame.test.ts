import { expect, it } from 'vitest';

import { commandFrame, type CommandFrameRow } from './command-frame';

const base: CommandFrameRow = {
  commandID: 'cmd-1',
  from: 'user-1',
  type: 'send_message',
  payload: '{"prompt":"hello"}',
  expiresAt: 1_700_000_000_123,
  liveOnly: false,
  createdAt: 1_700_000_000_000,
};

function historical(row: CommandFrameRow, seq: number): string {
  return JSON.stringify({
    v: 1,
    channel: 'commands',
    seq,
    from: row.from,
    at: row.createdAt,
    type: row.type,
    body: {
      commandID: row.commandID,
      payload: JSON.parse(row.payload),
      expiresAt: new Date(row.expiresAt).toISOString(),
      liveOnly: row.liveOnly,
    },
  });
}

it.each<[string, CommandFrameRow, number]>([
  ['null body', { ...base, payload: 'null' }, 7],
  [
    'nested values',
    { ...base, payload: '{"a":[1,2.5,-3e-7,true,false,null],"b":{"c":"d"}}' },
    1025,
  ],
  [
    'unicode and escapes',
    { ...base, payload: '{"text":"line\\nquote\\" tab\\t emoji \u{1F600}"}' },
    0,
  ],
  ['empty containers', { ...base, payload: '[[],{},""]' }, Number.MAX_SAFE_INTEGER],
  ['live only', { ...base, liveOnly: true }, 42],
  ['escaped identifiers', { ...base, commandID: 'a"b', from: 'c\\d', type: 'e\\u0000f' }, 3],
])('matches the commands envelope encoding for %s', (_label, row, seq) => {
  expect(commandFrame(row, seq)).toBe(historical(row, seq));
});
