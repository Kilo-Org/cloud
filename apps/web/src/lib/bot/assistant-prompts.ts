import type { AssistantContextChangedEvent, AssistantThreadStartedEvent } from 'chat';

type AssistantEventCoordinates = Pick<
  AssistantThreadStartedEvent | AssistantContextChangedEvent,
  'channelId' | 'threadTs'
>;

type SlackAssistantAdapter = {
  setAssistantStatus(channelId: string, threadTs: string, status: string): Promise<void>;
  setAssistantTitle(channelId: string, threadTs: string, title: string): Promise<void>;
  setSuggestedPrompts(
    channelId: string,
    threadTs: string,
    prompts: Array<{ title: string; message: string }>,
    title?: string
  ): Promise<void>;
};

export const SLACK_ASSISTANT_SUGGESTED_PROMPTS = [
  {
    title: 'Fix an issue in my codebase',
    message: 'Please ask me for the link to an issue that I want you to fix.',
  },
  {
    title: 'Fix a bug',
    message: 'Help me investigate and fix a bug in my codebase.',
  },
  {
    title: 'Review code',
    message: 'Please ask me for a PR that you should review',
  },
  {
    title: 'Explain Kilo Bot',
    message: 'What can Kilo Bot do from Slack, and how do I get started?',
  },
] as const;

const ASSISTANT_PROMPTS_TITLE = 'Try asking Kilo Bot';

export async function updateSlackAssistantSuggestions(
  adapter: SlackAssistantAdapter,
  event: AssistantEventCoordinates
): Promise<void> {
  await Promise.all([
    adapter.setSuggestedPrompts(
      event.channelId,
      event.threadTs,
      [...SLACK_ASSISTANT_SUGGESTED_PROMPTS],
      ASSISTANT_PROMPTS_TITLE
    ),
  ]);
}
