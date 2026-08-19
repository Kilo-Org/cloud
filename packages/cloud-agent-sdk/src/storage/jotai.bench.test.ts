import { createStore } from 'jotai';
import { createJotaiStorage } from './jotai';
import type { Part } from '@kilocode/app-shared/opencode';
import type { MessageInfo } from '../types';

function makeMsg(id: string): MessageInfo {
  return {
    id,
    sessionID: 'ses-bench',
    role: 'user',
    time: { created: 1 },
    agent: 'build',
    model: { providerID: 'a', modelID: 'b' },
  } as MessageInfo;
}

function makePart(id: string, messageId: string): Part {
  return { id, sessionID: 'ses-bench', messageID: messageId, type: 'text', text: 'hello' } as Part;
}

test('BENCH jotai-parts', () => {
  const store = createStore();
  const s = createJotaiStorage(store);

  // 200 messages, each with 3 parts.
  for (let m = 0; m < 200; m++) {
    const mid = `msg-${m}`;
    s.upsertMessage(makeMsg(mid));
    for (let p = 0; p < 3; p++) {
      s.upsertPart(mid, makePart(`part-${m}-${p}`, mid));
    }
  }

  // Count parts-map writes (Map allocations) by wrapping store.set.
  let partsMapWrites = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const originalSet: any = store.set.bind(store);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (store as any).set = (atom: unknown, value: unknown) => {
    if (atom === s.atoms.parts) partsMapWrites += 1;
    return originalSet(atom, value);
  };

  const start = Date.now();
  for (let i = 0; i < 2000; i++) {
    s.applyPartDelta('msg-199', 'part-199-0', 'text', 'x');
  }
  const elapsedMs = Date.now() - start;

  console.log(`BENCH jotai-parts elapsedMs=${elapsedMs} partsMapWrites=${partsMapWrites}`);
  expect(true).toBe(true);
});
