import type { CommandSet } from './slash-commands';

export const DEFAULT_COMMAND_SETS: CommandSet[] = [
  {
    id: 'github',
    name: 'GitHub',
    description: 'GitHub CLI and pull request commands',
    prefix: 'github-',
    commands: [
      {
        trigger: 'github-open-pullrequest',
        label: 'Open Pull Request',
        description: 'Create a new PR using gh CLI',
        expansion:
          'Open a pull request for the current branch using gh CLI. GH_TOKEN is configured.',
      },
      {
        trigger: 'github-resolve-conflicts',
        label: 'Resolve Merge Conflicts',
        description: 'Pull latest and resolve conflicts from main',
        expansion: 'Pull latest from origin and resolve any merge conflicts with main.',
      },
      {
        trigger: 'github-address-feedback',
        label: 'Address PR Feedback',
        description: 'Check and fix all PR feedback',
        expansion:
          'Check for PR feedback using: 1) gh pr status, 2) gh pr view --comments for conversation comments, 3) gh api repos/{owner}/{repo}/pulls/{pr-number}/comments for inline diff comments. Fix all requested code changes. GH_TOKEN is configured.',
      },
      {
        trigger: 'github-fix-actions',
        label: 'Fix GitHub Actions',
        description: 'Check and fix failing workflows',
        expansion:
          'Use gh CLI to check GitHub Actions status for this branch. Quick steps: 1) gh pr checks (see failing jobs). 2) gh run list --branch <branch> (get run id). 3) gh run view <run-id> --job <job-name> --log (inspect the failing job, e.g., linter). Fix issues and verify workflows pass after pushing your fix. GH_TOKEN is configured.',
      },
    ],
  },
  // Future sets can be added here (docker, test, deploy, etc.)
];
