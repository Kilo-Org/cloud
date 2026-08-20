import { sortSessionMessagesForDisplay } from './message-ordering';

function message(id: string, partIds: string[] = []) {
  return {
    info: { id },
    parts: partIds.map(partId => ({ id: partId })),
  };
}

describe('sortSessionMessagesForDisplay', () => {
  it('sorts messages by info.id ascending, matching cloud-agent-next insertSorted order', () => {
    const sorted = sortSessionMessagesForDisplay([
      message('msg_000000000003c'),
      message('msg_000000000001a'),
      message('msg_000000000002b'),
    ]);

    expect(sorted.map(m => m.info.id)).toEqual([
      'msg_000000000001a',
      'msg_000000000002b',
      'msg_000000000003c',
    ]);
  });

  it('sorts parts within each message by part id', () => {
    const sorted = sortSessionMessagesForDisplay([
      message('msg_1', ['part_000000000002b', 'part_000000000001a', 'part_000000000003c']),
    ]);

    expect(sorted[0]?.parts.map(p => p.id)).toEqual([
      'part_000000000001a',
      'part_000000000002b',
      'part_000000000003c',
    ]);
  });

  it('does not mutate the input messages or parts arrays', () => {
    const input = [message('msg_2', ['part_2', 'part_1']), message('msg_1')];

    sortSessionMessagesForDisplay(input);

    expect(input.map(m => m.info.id)).toEqual(['msg_2', 'msg_1']);
    expect(input[0]?.parts.map(p => p.id)).toEqual(['part_2', 'part_1']);
  });

  it('keeps already-ordered messages stable', () => {
    const input = [message('msg_1'), message('msg_2'), message('msg_3')];

    expect(sortSessionMessagesForDisplay(input).map(m => m.info.id)).toEqual([
      'msg_1',
      'msg_2',
      'msg_3',
    ]);
  });

  it('handles an empty message list', () => {
    expect(sortSessionMessagesForDisplay([])).toEqual([]);
  });
});
