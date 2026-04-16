import * as z from 'zod';

import { allFixtures } from './__fixtures__';
import { realSessionExcerpt } from './__fixtures__/real-session-excerpt';
import { messageUpdatedDataSchema } from './schemas';
import { createTestSession } from './test-helpers';

const messageTimeSchema = messageUpdatedDataSchema.extend({
  info: messageUpdatedDataSchema.shape.info.extend({
    role: z.string(),
    time: z.object({ created: z.number() }),
  }),
});

describe.each(allFixtures)('fixture: $name', ({ description, events, expected }) => {
  it(description, () => {
    const { storage, feedEvent } = createTestSession();

    for (const event of events) {
      feedEvent(event);
    }

    expect(storage.getMessageIds()).toEqual(expected.messageIds);

    for (const [msgId, expectedParts] of Object.entries(expected.parts)) {
      const actual = storage.getParts(msgId);
      expect(actual).toHaveLength(expectedParts.length);
      for (let i = 0; i < expectedParts.length; i++) {
        expect(actual[i]).toEqual(expect.objectContaining(expectedParts[i]));
      }
    }
  });
});

describe('real-session-excerpt fixture', () => {
  it('documents backend message timestamps are millisecond-scale', () => {
    const rootMessageEvents = realSessionExcerpt.events
      .flatMap(event => {
        if (
          typeof event.data !== 'object' ||
          event.data === null ||
          !('properties' in event.data)
        ) {
          return [];
        }
        const result = messageTimeSchema.safeParse(event.data.properties);
        return result.success ? [result.data.info] : [];
      })
      .filter(info => info.sessionID === 'ses_35fc6b339ffeaf91IozzdnLtJ7');
    const rootUserEvent = rootMessageEvents.find(info => info.role === 'user');
    const rootAssistantEvent = rootMessageEvents.find(info => info.role === 'assistant');

    expect(rootUserEvent?.time.created).toBe(1_772_214_640_111);
    expect(rootAssistantEvent?.time.created).toBe(1_772_214_640_377);
    expect(rootUserEvent?.time.created).toBeGreaterThanOrEqual(1_000_000_000_000);
    expect(rootAssistantEvent?.time.created).toBeLessThan(10_000_000_000_000);
  });
});
