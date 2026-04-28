import {
  SLACK_ASSISTANT_SUGGESTED_PROMPTS,
  updateSlackAssistantSuggestions,
} from '@/lib/bot/assistant-prompts';

function createAdapter() {
  return {
    setAssistantStatus: jest.fn<Promise<void>, [string, string, string]>().mockResolvedValue(),
    setAssistantTitle: jest.fn<Promise<void>, [string, string, string]>().mockResolvedValue(),
    setSuggestedPrompts: jest
      .fn<Promise<void>, [string, string, Array<{ title: string; message: string }>, string]>()
      .mockResolvedValue(),
  };
}

function createEvent() {
  return {
    adapter: {},
    channelId: 'D123',
    context: { teamId: 'T123', channelId: 'C123' },
    threadId: 'slack:D123:1710000000.000100',
    threadTs: '1710000000.000100',
    userId: 'U123',
  };
}

describe('Slack assistant prompts', () => {
  it('sets a title, ready status, and Kilo-specific suggested prompts', async () => {
    const adapter = createAdapter();
    const event = createEvent();

    await updateSlackAssistantSuggestions(adapter, event);

    expect(adapter.setAssistantTitle).toHaveBeenCalledWith('D123', '1710000000.000100', 'Kilo Bot');
    expect(adapter.setAssistantStatus).toHaveBeenCalledWith(
      'D123',
      '1710000000.000100',
      'Ready to help'
    );
    expect(adapter.setSuggestedPrompts).toHaveBeenCalledWith(
      'D123',
      '1710000000.000100',
      [...SLACK_ASSISTANT_SUGGESTED_PROMPTS],
      'Try asking Kilo Bot'
    );
  });
});
