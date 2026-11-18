import type { GitLabDiscussion } from '@/lib/integrations/platforms/gitlab/adapter';

export function getGitLabDiscussionState(notes: GitLabDiscussion['notes'] | undefined): {
  resolvable: boolean;
  resolved: boolean;
} {
  const resolvableNote = notes?.find(note => note.resolvable);
  return {
    resolvable: Boolean(resolvableNote),
    resolved: resolvableNote?.resolved === true,
  };
}
