import { allFixtures } from './__fixtures__';
import { createTestSession } from './test-helpers';

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
