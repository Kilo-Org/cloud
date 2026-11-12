export function fakeCompactionSummary(prompt: string): string | undefined {
  if (
    !prompt.startsWith(
      'You MUST summarize the conversation above into a structured summary that will be given to another agent'
    ) &&
    !prompt.startsWith(
      'Update the existing checkpoint in the conversation above into one consolidated summary.'
    )
  )
    return undefined;

  return `## Objective
- Continue the current task after context compaction.

## Requirements
- Keep the conversation usable after compaction.

## Decisions
- Continue in the same chat.

## Work State
### Completed
- Summarized the earlier context.
### Active
- Verify the next message.
### Blocked
- (none)

## Next Move
1. Send a follow-up message.

## Relevant Files
- (none)

## Important Context
- This is a deterministic local test summary.`;
}
