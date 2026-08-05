import type { Fixture } from './types';
import { basicStreaming } from './basic-streaming';
import { childSessions } from './child-sessions';
import { toolUseCycle } from './tool-use-cycle';
import { autocommit } from './autocommit';
import { interruption } from './interruption';
import { realSessionExcerpt } from './real-session-excerpt';
import { optimisticUserTextReconciliation } from './optimistic-user-text-reconciliation';
import { messageDeliveryExhausted } from './message-delivery-exhausted';

const allFixtures: Fixture[] = [
  basicStreaming,
  childSessions,
  toolUseCycle,
  autocommit,
  interruption,
  realSessionExcerpt,
  optimisticUserTextReconciliation,
  messageDeliveryExhausted,
];

export { allFixtures };
export type { Fixture, ExpectedPart } from './types';
