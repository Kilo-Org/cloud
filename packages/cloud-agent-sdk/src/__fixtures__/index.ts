import type { Fixture } from './types';
import { basicStreaming } from './basic-streaming';
import { childSessions } from './child-sessions';
import { toolUseCycle } from './tool-use-cycle';
import { autocommit } from './autocommit';
import { interruption } from './interruption';
import { sessionReplay } from './session-replay';
import { optimisticUserTextReconciliation } from './optimistic-user-text-reconciliation';
import { messageDeliveryExhausted } from './message-delivery-exhausted';

// Fixtures mirror wire protocol shapes with invented values: identifiers keep
// the wire prefix and a sample numeric body, and text is authored for the
// fixture. `fixture-hygiene.test.ts` enforces the identifier rule.
const allFixtures: Fixture[] = [
  basicStreaming,
  childSessions,
  toolUseCycle,
  autocommit,
  interruption,
  sessionReplay,
  optimisticUserTextReconciliation,
  messageDeliveryExhausted,
];

export { allFixtures };
export type { Fixture, ExpectedPart } from './types';
