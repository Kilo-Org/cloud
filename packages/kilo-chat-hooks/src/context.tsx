import { createContext, useContext, type ReactNode } from 'react';
import type { KiloChatClient } from '@kilocode/kilo-chat';
import type { EventServiceClient } from '@kilocode/event-service';

type Value = {
  kiloChatClient: KiloChatClient;
  eventService: EventServiceClient;
};

const Ctx = createContext<Value | null>(null);

export function KiloChatHooksProvider(props: { value: Value; children: ReactNode }) {
  return <Ctx.Provider value={props.value}>{props.children}</Ctx.Provider>;
}

export function useKiloChatClient(): KiloChatClient {
  const v = useContext(Ctx);
  if (!v) throw new Error('useKiloChatClient: missing KiloChatHooksProvider');
  return v.kiloChatClient;
}

export function useEventServiceClient(): EventServiceClient {
  const v = useContext(Ctx);
  if (!v) throw new Error('useEventServiceClient: missing KiloChatHooksProvider');
  return v.eventService;
}
