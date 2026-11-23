/**
 * Cost of one streamed native frame at transcript scale.
 *
 * A live `session.text.delta` reaches the reducer once per fragment, so the cost that matters
 * is per frame and it must not grow with the transcript or with the reply already streamed.
 * This benchmark replays a fixed number of deltas into the last assistant message of a
 * synthetic transcript of N messages and reports the cost of one frame.
 *
 *   node --import tsx packages/cloud-agent-sdk/bench/native-frames.bench.ts
 *   node --import tsx packages/cloud-agent-sdk/bench/native-frames.bench.ts --messages 8000 --frames 2000
 *
 * It is a measurement, not a test: no assertion depends on the machine's speed.
 */
import { performance } from 'node:perf_hooks';
import { applyNativeEvent } from '../src/native-conversation-reducer';
import type { NativeEvent } from '../src/native-sync';
import type { NativeSnapshotMessage } from '../src/native-sync-snapshot';

const args = new Map<string, string>();
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index];
  const value = process.argv[index + 1];
  if (!key?.startsWith('--') || value === undefined) throw new Error(`Bad argument ${key}`);
  args.set(key.slice(2), value);
}
const sizes = (args.get('messages') ?? '20,200,2000,8000').split(',').map(Number);
const frames = Number(args.get('frames') ?? '1000');
const deltaSize = Number(args.get('delta') ?? '192');

const now = () => performance.now();

/** One transcript entry: a mix of shapes so a frame walks what a real transcript holds. */
function message(index: number): NativeSnapshotMessage {
  const id = `msg_${String(index).padStart(5, '0')}`;
  switch (index % 5) {
    case 0:
      return {
        seq: index,
        message: {
          id,
          type: 'assistant',
          agent: 'build',
          model: { id: 'model', providerID: 'kilo' },
          time: { created: index, completed: index + 1 },
          content: [
            { type: 'text', text: `answer ${index}` },
            {
              type: 'tool',
              id: `tool_${index}`,
              name: 'bash',
              time: { created: index, completed: index + 1 },
              state: {
                status: 'completed',
                input: { command: `echo ${index}` },
                content: [{ type: 'text', text: `line ${index}` }],
              },
            },
          ],
        },
      };
    case 1:
      return {
        seq: index,
        message: {
          id,
          type: 'user',
          time: { created: index },
          text: `question ${index}`,
          files: [
            {
              mime: 'image/png',
              name: 'shot.png',
              uri: `media:${'0'.repeat(64)}`,
              source: { type: 'uri', uri: `media:${'0'.repeat(64)}` },
            },
          ],
        },
      };
    case 2:
      return {
        seq: index,
        message: {
          id,
          type: 'assistant',
          agent: 'build',
          time: { created: index, completed: index + 1 },
          content: [{ type: 'reasoning', text: `thinking ${index}` }],
        },
      };
    case 3:
      return {
        seq: index,
        message: { id, type: 'idle', outcome: 'succeeded', time: { created: index } },
      };
    default:
      return {
        seq: index,
        message: { id, type: 'synthetic', text: `notice ${index}`, time: { created: index } },
      };
  }
}

function transcript(count: number): NativeSnapshotMessage[] {
  const messages: NativeSnapshotMessage[] = [];
  for (let index = 0; index < count; index++) messages.push(message(index));
  messages.push({
    seq: count,
    message: {
      id: 'msg_target',
      type: 'assistant',
      agent: 'build',
      model: { id: 'model', providerID: 'kilo' },
      time: { created: count },
      content: [{ type: 'text', text: '' }],
    },
  });
  return messages;
}

let sequence = 1_000_000;
function delta(created: number): NativeEvent {
  sequence += 1;
  return {
    v: 1,
    channel: 'events',
    seq: sequence,
    from: 'runner',
    at: created,
    type: 'session.text.delta',
    body: {
      version: 1,
      syncPosition: sequence,
      data: {
        id: `evt_${sequence}`,
        type: 'session.text.delta',
        created,
        data: {
          sessionID: 'ses_bench',
          assistantMessageID: 'msg_target',
          ordinal: 0,
          delta: 'x'.repeat(deltaSize),
        },
      },
    },
  };
}

const rows: { messages: number; nsPerFrame: number; projectedTextLength: number }[] = [];
for (const size of sizes) {
  let messages = transcript(size);
  // Warm-up: the first frames also grow the streamed part, so the timed run starts warm.
  for (let index = 0; index < 50; index++) messages = applyNativeEvent(messages, delta(index));
  const started = now();
  for (let index = 0; index < frames; index++) messages = applyNativeEvent(messages, delta(index));
  const elapsed = now() - started;
  const text = (
    messages.find(item => item.message.id === 'msg_target')?.message.content?.[0] as
      | { text?: string }
      | undefined
  )?.text;
  rows.push({
    messages: size,
    nsPerFrame: Number(((elapsed * 1e6) / frames).toFixed(0)),
    projectedTextLength: text?.length ?? 0,
  });
}

console.log(
  JSON.stringify({
    frames,
    deltaSize,
    rows,
    usPerFrame: rows.map(row => ({
      messages: row.messages,
      us: Number((row.nsPerFrame / 1000).toFixed(3)),
    })),
  })
);
