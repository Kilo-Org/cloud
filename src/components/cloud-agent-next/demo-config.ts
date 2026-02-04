import type { AgentMode } from './types';

export const DEMO_SOURCE_OWNER = 'Kilo-Org';
export const DEMO_SOURCE_REPO_NAME = 'KiloMan';
export const DEMO_SOURCE_REPO = `${DEMO_SOURCE_OWNER}/${DEMO_SOURCE_REPO_NAME}`;

export type DemoConfig = {
  id: string;
  title: string;
  description: string;
  prompt: string;
  mode: AgentMode;
  model: string;
};

export const DEMO_CONFIGS: DemoConfig[] = [
  {
    id: 'update-avatar',
    title: 'Update Player Avatar in the KiloMan repo',
    description:
      'Personalize the KiloMan game by updating the player avatar to use your GitHub Gravatar',
    prompt:
      'Update the player avatar in this game to use the Gravatar for GitHub user "{username}". The Gravatar URL should be: https://github.com/{username}.png. Once complete, please use "gh" the github cli to create a draft pull request with the changes, the GH_TOKEN is already available in the environment. Please be sure assign the pr to the user.',
    mode: 'build',
    model: 'x-ai/grok-code-fast-1',
  },
  {
    id: 'explain-game-mechanics',
    title: 'Learn About Game Mechanics in the KiloMan repo',
    description: 'Discover how the game mechanics work in KiloMan',
    prompt: 'Explain to me how the game mechanics work in this game',
    mode: 'plan',
    model: 'x-ai/grok-code-fast-1',
  },
];

// Helper to replace template variables in prompts
export function templatePrompt(prompt: string, githubUsername: string): string {
  return prompt.replace(/\{username\}/g, githubUsername);
}
