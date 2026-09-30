import { normalizeProjectId } from './normalizeProjectId';

describe('normalizeProjectId', () => {
  describe('null and empty inputs', () => {
    it('should return null for null input', () => {
      expect(normalizeProjectId(null)).toBe(null);
    });

    it('should return empty string for empty string input', () => {
      expect(normalizeProjectId('')).toBe(null);
    });
  });

  describe('HTTPS git URLs', () => {
    it('should extract repository name from standard HTTPS git URL', () => {
      expect(normalizeProjectId('https://github.com/Kilo-Org/handbook.git')).toBe('handbook');
    });

    it('should extract repository name from HTTPS git URL without .git extension', () => {
      expect(normalizeProjectId('https://github.com/Kilo-Org/handbook')).toBe('handbook');
    });

    it('should handle HTTPS git URL with trailing space (not a valid git URL)', () => {
      // Trailing space makes it not match the git URL pattern, so it returns as-is
      expect(normalizeProjectId('https://github.com/Kilo-Org/kilocode ')).toBe(
        'https://github.com/Kilo-Org/kilocode '
      );
    });

    it('should handle HTTPS git URL with uppercase .GIT extension', () => {
      expect(normalizeProjectId('https://github.com/Kilo-Org/handbook.GIT')).toBe('handbook');
    });

    it('should handle HTTPS git URL with mixed case .Git extension', () => {
      expect(normalizeProjectId('https://github.com/Kilo-Org/handbook.Git')).toBe('handbook');
    });

    it('should handle HTTP (non-secure) git URLs', () => {
      expect(normalizeProjectId('http://github.com/user/repo.git')).toBe('repo');
    });

    it('should handle GitLab HTTPS URLs', () => {
      expect(normalizeProjectId('https://gitlab.com/user/project.git')).toBe('project');
    });

    it('should handle Bitbucket HTTPS URLs', () => {
      expect(normalizeProjectId('https://bitbucket.org/user/repo.git')).toBe('repo');
    });

    it('should handle self-hosted git HTTPS URLs', () => {
      expect(normalizeProjectId('https://git.company.com/team/project.git')).toBe('project');
    });

    it('should handle deeply nested repository paths', () => {
      expect(normalizeProjectId('https://github.com/org/team/subteam/project.git')).toBe('project');
    });
  });

  describe('SSH git URLs', () => {
    it('should extract repository name from standard SSH git URL', () => {
      expect(normalizeProjectId('git@github.com:Kilo-Org/handbook.git')).toBe('handbook');
    });

    it('should extract repository name from SSH git URL with uppercase .GIT', () => {
      expect(normalizeProjectId('git@github.com:Kilo-Org/handbook.GIT')).toBe('handbook');
    });

    it('should handle GitLab SSH URLs', () => {
      expect(normalizeProjectId('git@gitlab.com:user/project.git')).toBe('project');
    });

    it('should handle Bitbucket SSH URLs', () => {
      expect(normalizeProjectId('git@bitbucket.org:user/repo.git')).toBe('repo');
    });

    it('should handle self-hosted git SSH URLs', () => {
      expect(normalizeProjectId('git@git.company.com:team/project.git')).toBe('project');
    });

    it('should handle SSH URLs with custom ports', () => {
      expect(normalizeProjectId('git@github.com:22/user/repo.git')).toBe('repo');
    });

    it('should handle deeply nested SSH repository paths', () => {
      expect(normalizeProjectId('git@github.com:org/team/subteam/project.git')).toBe('project');
    });
  });

  describe('plain project names', () => {
    it('should return plain project name as-is', () => {
      expect(normalizeProjectId('my-project')).toBe('my-project');
    });

    it('should return project name with spaces as-is', () => {
      expect(normalizeProjectId('my project name')).toBe('my project name');
    });

    it('should return project name with special characters as-is', () => {
      expect(normalizeProjectId('project_name-123')).toBe('project_name-123');
    });

    it('should return UUID-like project names as-is', () => {
      expect(normalizeProjectId('550e8400-e29b-41d4-a716-446655440000')).toBe(
        '550e8400-e29b-41d4-a716-446655440000'
      );
    });

    it('should return numeric project IDs as-is', () => {
      expect(normalizeProjectId('12345')).toBe('12345');
    });
  });

  describe('truncation to 256 characters', () => {
    it('should truncate very long plain project names to 256 characters', () => {
      const longName = 'a'.repeat(300);
      const result = normalizeProjectId(longName);
      expect(result).toBe('a'.repeat(256));
      expect(result?.length).toBe(256);
    });

    it('should truncate very long HTTPS URLs to 256 characters before processing', () => {
      const longUrl = 'https://github.com/' + 'a'.repeat(300) + '/repo.git';
      const result = normalizeProjectId(longUrl);
      expect(result?.length).toBeLessThanOrEqual(256);
    });

    it('should handle exactly 256 character input', () => {
      const exactLength = 'a'.repeat(256);
      const result = normalizeProjectId(exactLength);
      expect(result).toBe(exactLength);
      expect(result?.length).toBe(256);
    });

    it('should not modify input shorter than 256 characters', () => {
      const shortName = 'short-project-name';
      expect(normalizeProjectId(shortName)).toBe(shortName);
    });
  });

  describe('edge cases', () => {
    it('should handle URLs with query parameters', () => {
      expect(normalizeProjectId('https://github.com/user/repo.git?ref=main')).toBe(
        'https://github.com/user/repo.git?ref=main'
      );
    });

    it('should handle URLs with fragments', () => {
      expect(normalizeProjectId('https://github.com/user/repo.git#readme')).toBe(
        'https://github.com/user/repo.git#readme'
      );
    });

    it('should extract repository name from any HTTPS URL with a path', () => {
      // Any HTTPS URL with a path is treated as a potential git URL
      expect(normalizeProjectId('https://example.com/path')).toBe('path');
    });

    it('should handle git URLs with .git in the middle of the path', () => {
      expect(normalizeProjectId('https://github.com/user/repo.git.backup/project.git')).toBe(
        'project'
      );
    });

    it('should handle repository names with dots', () => {
      expect(normalizeProjectId('https://github.com/user/my.repo.name.git')).toBe('my.repo.name');
    });

    it('should handle repository names with hyphens and underscores', () => {
      expect(normalizeProjectId('https://github.com/user/my-repo_name.git')).toBe('my-repo_name');
    });

    it('should handle single character repository names', () => {
      expect(normalizeProjectId('https://github.com/user/x.git')).toBe('x');
    });

    it('should handle whitespace-only input', () => {
      expect(normalizeProjectId('   ')).toBe('   ');
    });

    it('should handle project names with newlines', () => {
      expect(normalizeProjectId('project\nname')).toBe('project\nname');
    });
  });

  describe('real-world examples', () => {
    it('should handle the kilocode repository', () => {
      expect(normalizeProjectId('https://github.com/Kilo-Org/kilocode.git')).toBe('kilocode');
    });

    it('should handle the kilocode repository with trailing space', () => {
      expect(normalizeProjectId('https://github.com/Kilo-Org/kilocode ')).toBe(
        'https://github.com/Kilo-Org/kilocode '
      );
    });

    it('should handle popular open source projects', () => {
      expect(normalizeProjectId('https://github.com/facebook/react.git')).toBe('react');
      expect(normalizeProjectId('https://github.com/microsoft/vscode.git')).toBe('vscode');
      expect(normalizeProjectId('https://github.com/vercel/next.js.git')).toBe('next.js');
    });

    it('should handle enterprise repository patterns', () => {
      expect(normalizeProjectId('git@git.enterprise.com:team/backend-api.git')).toBe('backend-api');
      expect(normalizeProjectId('https://git.company.internal/dept/project-x.git')).toBe(
        'project-x'
      );
    });
  });
});
