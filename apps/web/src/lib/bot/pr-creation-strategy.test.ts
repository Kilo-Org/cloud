import { buildForceNewPrInstruction, detectPrCreationStrategy } from './pr-creation-strategy';

describe('detectPrCreationStrategy', () => {
  it.each([
    '@kilocode-bot open a new PR to update REVIEW.md',
    '@kilocode-dev create a new pull request with this fix',
    'start a new MR for this change',
    'please put this in a separate merge request',
    'ship this as a separate PR',
  ])('forces a new PR/MR for explicit request: %s', text => {
    expect(detectPrCreationStrategy(text)).toBe('force-new');
  });

  it.each([
    '@kilocode-bot fix this',
    'update the existing PR with this change',
    'do not create a new PR, just patch this branch',
    'without opening a new MR, explain the issue',
    'no new pull request needed',
  ])('keeps default behavior for non-new or negated request: %s', text => {
    expect(detectPrCreationStrategy(text)).toBe('default');
  });
});

describe('buildForceNewPrInstruction', () => {
  it('uses GitHub PR branch guidance for GitHub-origin requests', () => {
    const instruction = buildForceNewPrInstruction('github');

    expect(instruction).toContain('separate new PR');
    expect(instruction).toContain('original PR base branch');
    expect(instruction).toContain('avoid pushing to or modifying the original PR head branch');
  });

  it('uses GitLab MR branch guidance for GitLab-origin requests', () => {
    const instruction = buildForceNewPrInstruction('gitlab');

    expect(instruction).toContain('separate new MR');
    expect(instruction).toContain('original MR target branch');
    expect(instruction).toContain('avoid pushing to or modifying the original MR source branch');
  });
});
