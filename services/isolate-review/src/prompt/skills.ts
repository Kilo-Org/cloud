import { skills } from '@cloudflare/think';
import githubCloudReviewMarkdown from './skills/github-cloud-review.md';

const parsedSkill = skills.parseSkillMarkdown(githubCloudReviewMarkdown);

if (!parsedSkill) {
  throw new Error('Invalid github-cloud-review skill markdown');
}

export const GITHUB_CLOUD_REVIEW_SKILL = parsedSkill;

export const ISOLATE_REVIEW_SKILLS = skills.fromManifest({
  id: 'isolate-review',
  fingerprint: 'github-cloud-review/2',
  skills: [parsedSkill],
});

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

export function buildSkillCatalogPrompt(): string {
  return [
    '<available_skills>',
    '  <skill>',
    `    <name>${escapeXml(GITHUB_CLOUD_REVIEW_SKILL.name)}</name>`,
    `    <description>${escapeXml(GITHUB_CLOUD_REVIEW_SKILL.description)}</description>`,
    '    <location>activate_skill</location>',
    '  </skill>',
    '</available_skills>',
  ].join('\n');
}
