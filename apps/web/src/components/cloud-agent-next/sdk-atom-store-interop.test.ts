import { createStore } from 'jotai';
import { createJotaiStorage } from '@kilocode/cloud-agent-sdk';

// `@kilocode/cloud-agent-sdk` resolves jotai 3.0.0 (the graph kilo-app uses)
// while apps/web stays on jotai 2.18.1, so the SDK creates its atoms with a
// different major than the store that reads them. The shared chat surface
// relies on that interop, so this drives a real SDK-created atom through
// apps/web's store instead of assuming the two majors agree.
describe('cloud-agent-sdk atoms through the apps/web jotai store', () => {
  it('publishes SDK atom updates through the caller store', () => {
    const store = createStore();
    const storage = createJotaiStorage(store as never);
    const { messageIds } = storage.atoms;

    const seen: unknown[] = [];
    const unsubscribe = store.sub(messageIds as never, () => {
      seen.push(store.get(messageIds as never));
    });

    storage.upsertMessage({ id: 'msg-1', sessionID: 'ses-1', role: 'user' } as never);
    storage.upsertMessage({ id: 'msg-2', sessionID: 'ses-1', role: 'assistant' } as never);

    expect(store.get(messageIds as never)).toEqual(['msg-1', 'msg-2']);
    expect(storage.getMessageIds()).toEqual(['msg-1', 'msg-2']);
    expect(seen).toEqual([['msg-1'], ['msg-1', 'msg-2']]);

    unsubscribe();
  });
});
