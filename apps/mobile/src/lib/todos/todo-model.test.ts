import { describe, expect, it } from 'vitest';

import {
  TODO_TITLE_MAX_LENGTH,
  todoFromDraft,
  todoLinkCandidates,
  todoListGitUrl,
  todoListRepoSelection,
  todoSessionPrompt,
  todoSessionStatus,
} from './todo-model';

const PR_URL = 'https://github.com/owner/repo/pull/42';

describe('todoSessionStatus', () => {
  it('has no status without sessions', () => {
    expect(todoSessionStatus([])).toBeNull();
  });

  it('reads only the newest session', () => {
    expect(
      todoSessionStatus([
        { status: 'idle', prUrl: null },
        { status: 'question', prUrl: null },
      ])
    ).toEqual({ kind: 'done' });
  });

  it('puts a waiting session ahead of its pull request', () => {
    expect(todoSessionStatus([{ status: 'permission', prUrl: PR_URL }])).toEqual({
      kind: 'needsInput',
    });
  });

  it('shows a working session as running', () => {
    expect(todoSessionStatus([{ status: 'busy', prUrl: PR_URL }])).toEqual({ kind: 'running' });
  });

  it('shows the pull request number of an idle session', () => {
    expect(todoSessionStatus([{ status: 'idle', prUrl: PR_URL }])).toEqual({
      kind: 'pullRequest',
      number: 42,
    });
  });

  it('shows nothing for a session that reported no status yet', () => {
    expect(todoSessionStatus([{ status: null, prUrl: null }])).toBeNull();
  });
});

describe('todoSessionPrompt', () => {
  it('joins the title and notes with a blank line', () => {
    expect(todoSessionPrompt({ title: 'Fix login', notes: ' Steps:\n1. open ' })).toBe(
      'Fix login\n\nSteps:\n1. open'
    );
  });

  it('is the title alone without notes', () => {
    expect(todoSessionPrompt({ title: 'Fix login', notes: '  ' })).toBe('Fix login');
    expect(todoSessionPrompt({ title: 'Fix login', notes: null })).toBe('Fix login');
  });
});

describe('todoFromDraft', () => {
  it('splits the first line into the title and the rest into notes', () => {
    expect(todoFromDraft('  Fix login \n\n details\nmore ')).toEqual({
      title: 'Fix login',
      notes: 'details\nmore',
    });
  });

  it('has no notes for a one-line draft', () => {
    expect(todoFromDraft('Fix login')).toEqual({ title: 'Fix login', notes: null });
  });

  it('caps the title at the router limit', () => {
    const title = todoFromDraft('x'.repeat(TODO_TITLE_MAX_LENGTH + 20))?.title;
    expect(title).toHaveLength(TODO_TITLE_MAX_LENGTH);
  });

  it('is null for a blank draft', () => {
    expect(todoFromDraft(' \n ')).toBeNull();
  });
});

describe('todoLinkCandidates', () => {
  const SAME_REPO_HTTPS = {
    session_id: 's-https',
    git_url: 'https://github.com/drain-labs/notes.git',
  };
  const SAME_REPO_SSH = { session_id: 's-ssh', git_url: 'git@github.com:drain-labs/notes.git' };
  const OTHER_REPO = { session_id: 's-other', git_url: 'https://github.com/drain-labs/tasks' };
  const NO_REPO = { session_id: 's-none', git_url: null };
  const sessions = [SAME_REPO_HTTPS, SAME_REPO_SSH, OTHER_REPO, NO_REPO];

  const linkedNone: ReadonlySet<string> = new Set();

  it.each([
    ['https clone URL', 'https://github.com/drain-labs/notes.git'],
    ['https clone URL without the .git suffix', 'https://github.com/drain-labs/notes'],
    ['ssh clone URL', 'git@github.com:drain-labs/notes.git'],
    ['owner/repo', 'drain-labs/notes'],
    ['another host case', 'https://GitHub.com/Drain-Labs/Notes.git'],
  ])('offers every session on the list repository for a %s list', (_label, repository) => {
    expect(
      todoLinkCandidates(sessions, { repository, linkedSessionIds: linkedNone }).map(
        session => session.session_id
      )
    ).toEqual(['s-https', 's-ssh']);
  });

  it('offers every unlinked session when the list names no repository', () => {
    expect(
      todoLinkCandidates(sessions, { repository: null, linkedSessionIds: linkedNone }).map(
        session => session.session_id
      )
    ).toEqual(['s-https', 's-ssh', 's-other', 's-none']);
  });

  it('never offers a session already linked to the to-do', () => {
    expect(
      todoLinkCandidates(sessions, {
        repository: 'drain-labs/notes',
        linkedSessionIds: new Set(['s-ssh']),
      }).map(session => session.session_id)
    ).toEqual(['s-https']);
  });

  it('offers nothing when the list repository has no session', () => {
    expect(
      todoLinkCandidates(sessions, {
        repository: 'drain-labs/missing',
        linkedSessionIds: linkedNone,
      })
    ).toEqual([]);
  });
});

describe('list repository mapping', () => {
  const repositories = [
    { platform: 'gitlab', fullName: 'Owner/Repo' },
    { platform: 'github', fullName: 'Owner/Repo' },
  ];

  it('selects the GitHub row case-insensitively', () => {
    expect(todoListRepoSelection('owner/repo', repositories)).toBe('github:Owner/Repo');
  });

  it('keeps an unknown repository selectable', () => {
    expect(todoListRepoSelection('other/repo', repositories)).toBe('github:other/repo');
  });

  it('is empty without a repository', () => {
    expect(todoListRepoSelection(null, repositories)).toBe('');
  });

  it('stores the full name of a picker value', () => {
    expect(todoListGitUrl('gitlab:group/project')).toBe('group/project');
    expect(todoListGitUrl('')).toBeNull();
  });
});
