/**
 * Webhook Trigger Types
 *
 * Shared type definitions for webhook trigger components.
 */

/** GitHub repository info from listGitHubRepositories API */
export type GitHubRepository = {
  id: number;
  fullName: string;
  private: boolean;
};
