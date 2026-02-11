import { generateDeploymentSlug } from './slug-generator';
import { slugSchema } from './validation';

describe('generateDeploymentSlug', () => {
  describe('app-builder deployments (repoName is null)', () => {
    it('generates a slug matching adjective-noun-NNNN pattern', () => {
      const slug = generateDeploymentSlug(null);
      expect(slug).toMatch(/^[a-z]+-[a-z]+-\d{4}$/);
    });

    it('passes slugSchema validation', () => {
      for (let i = 0; i < 100; i++) {
        const slug = generateDeploymentSlug(null);
        const result = slugSchema.safeParse(slug);
        expect(result.success).toBe(true);
      }
    });
  });

  describe('regular deployments (repoName provided)', () => {
    it('generates a slug with repoName prefix and 4-digit suffix', () => {
      const slug = generateDeploymentSlug('owner-repo');
      expect(slug).toMatch(/^owner-repo-\d{4}$/);
    });

    it('lowercases the repo name', () => {
      const slug = generateDeploymentSlug('Owner-Repo');
      expect(slug).toMatch(/^owner-repo-\d{4}$/);
    });

    it('passes slugSchema validation', () => {
      for (let i = 0; i < 100; i++) {
        const slug = generateDeploymentSlug('my-project');
        const result = slugSchema.safeParse(slug);
        expect(result.success).toBe(true);
      }
    });

    it('replaces invalid characters with hyphens', () => {
      const slug = generateDeploymentSlug('my_project.name');
      expect(slug).toMatch(/^my-project-name-\d{4}$/);
    });

    it('collapses consecutive hyphens from replacements', () => {
      const slug = generateDeploymentSlug('my--project');
      expect(slug).toMatch(/^my-project-\d{4}$/);
    });

    it('strips leading and trailing hyphens from repo name', () => {
      const slug = generateDeploymentSlug('-my-project-');
      expect(slug).toMatch(/^my-project-\d{4}$/);
    });
  });

  describe('long repo name truncation', () => {
    it('truncates long repo names to fit within 63-char limit', () => {
      const longName = 'a'.repeat(100);
      const slug = generateDeploymentSlug(longName);
      expect(slug.length).toBeLessThanOrEqual(63);
      expect(slugSchema.safeParse(slug).success).toBe(true);
    });

    it('does not leave a trailing hyphen after truncation', () => {
      // 58 chars: 57 a's + hyphen at the end — truncation to 58 then strip trailing hyphen
      const name = 'a'.repeat(57) + '-b';
      const slug = generateDeploymentSlug(name);
      expect(slug).not.toMatch(/--/);
      expect(slug.length).toBeLessThanOrEqual(63);
      expect(slugSchema.safeParse(slug).success).toBe(true);
    });

    it('handles repo name exactly at the max prefix length', () => {
      const name = 'a'.repeat(58); // exactly max prefix length
      const slug = generateDeploymentSlug(name);
      expect(slug.length).toBeLessThanOrEqual(63);
      expect(slugSchema.safeParse(slug).success).toBe(true);
    });

    it('handles truncation at a hyphen boundary', () => {
      // Create a name where the 58th char is a hyphen
      const name = 'a'.repeat(57) + '-' + 'b'.repeat(10);
      const slug = generateDeploymentSlug(name);
      expect(slug).not.toMatch(/--/);
      expect(slug).not.toMatch(/-$/);
      expect(slug.length).toBeLessThanOrEqual(63);
      expect(slugSchema.safeParse(slug).success).toBe(true);
    });
  });

  describe('edge cases', () => {
    it('falls back to pronounceable name when repo name is empty after sanitization', () => {
      const slug = generateDeploymentSlug('---');
      // Should fall back to adjective-noun-NNNN
      expect(slug).toMatch(/^[a-z]+-[a-z]+-\d{4}$/);
      expect(slugSchema.safeParse(slug).success).toBe(true);
    });

    it('falls back to pronounceable name for all-invalid-char repo name', () => {
      const slug = generateDeploymentSlug('!!!');
      expect(slug).toMatch(/^[a-z]+-[a-z]+-\d{4}$/);
      expect(slugSchema.safeParse(slug).success).toBe(true);
    });

    it('never exceeds 63 characters', () => {
      const testCases = [
        null,
        'short',
        'a'.repeat(100),
        'owner-with-many-segments-in-the-repo-name-that-goes-on-and-on-forever',
      ];
      for (const repoName of testCases) {
        for (let i = 0; i < 20; i++) {
          const slug = generateDeploymentSlug(repoName);
          expect(slug.length).toBeLessThanOrEqual(63);
        }
      }
    });

    it('never contains consecutive hyphens', () => {
      const testCases = [null, 'my-project', 'a--b', 'x-', '-y', '---'];
      for (const repoName of testCases) {
        for (let i = 0; i < 20; i++) {
          const slug = generateDeploymentSlug(repoName);
          expect(slug).not.toMatch(/--/);
        }
      }
    });
  });
});
