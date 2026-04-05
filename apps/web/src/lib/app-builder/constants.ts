/**
 * App Builder Constants
 *
 * Shared constants for the App Builder feature.
 */

/**
 * Minimum balance required for full App Builder access (all models).
 * Users/organizations must have at least this amount of credits to access all models.
 */
export const MIN_BALANCE_FOR_APP_BUILDER = 1;

/**
 * Image upload constraints for App Builder messages
 */
export const APP_BUILDER_IMAGE_MAX_COUNT = 5;
export const APP_BUILDER_IMAGE_MAX_SIZE_BYTES = 5 * 1024 * 1024; // 5MB
export const APP_BUILDER_IMAGE_ALLOWED_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
] as const;
export const APP_BUILDER_IMAGE_PRESIGNED_URL_EXPIRY_SECONDS = 900; // 15 min

/**
 * The first line of the system context.
 * Used to detect and filter out messages containing the system context from the chat UI.
 * Must match the first non-empty line of APP_BUILDER_SYSTEM_CONTEXT.
 */
export const APP_BUILDER_SYSTEM_CONTEXT_FIRST_LINE = '## Project Context';

/**
 * Gallery templates available for the Template Gallery feature.
 * These are pre-built templates that users can preview and select.
 */
export const APP_BUILDER_GALLERY_TEMPLATES = ['resume', 'startup-landing-page'] as const;
export type AppBuilderGalleryTemplate = (typeof APP_BUILDER_GALLERY_TEMPLATES)[number];

/**
 * Constructs the preview URL for a gallery template.
 */
export function getTemplatePreviewUrl(templateId: AppBuilderGalleryTemplate): string {
  return `https://${templateId}.d.kiloapps.io`;
}

/**
 * Gallery template metadata for UI display.
 * Only includes metadata for gallery templates (not nextjs-starter).
 */
export const APP_BUILDER_GALLERY_TEMPLATE_METADATA: Record<
  AppBuilderGalleryTemplate,
  { name: string; shortDescription: string; longDescription: string }
> = {
  resume: {
    name: 'Resume / CV',
    shortDescription: 'Professional resume or CV showcase',
    longDescription:
      'A clean, professional resume template with sections for experience, education, skills, and contact information. Perfect for job seekers and professionals.',
  },
  'startup-landing-page': {
    name: 'Startup Landing Page',
    shortDescription: 'Marketing page for your product or startup',
    longDescription:
      'A modern marketing landing page with hero section, features, pricing, testimonials, and call-to-action. Great for launching your product or startup.',
  },
};

/**
 * Default prompt for template creation.
 * Used when a user selects a template and wants to start customizing it.
 */
export const APP_BUILDER_TEMPLATE_ASK_PROMPT =
  'What are my next steps and how can I best customize this template?';

/**
 * System prompt appended to cloud agent sessions for App Builder.
 * Guides the AI's communication style and workflow when helping users build websites.
 */
export const APP_BUILDER_APPEND_SYSTEM_PROMPT = `You are Kilo, a friendly website builder assistant helping users create their website through chat.

## Communication Style
- Be conversational, concise, and encouraging
- Skip technical jargon — explain concepts simply when needed
- Ask clarifying questions if the request is vague
- Celebrate progress ("Great choice!" "Looking good!")
- Proactively suggest next steps or improvements

## User Awareness
- Assume the user is NOT technical unless they demonstrate otherwise
- Never overwhelm with multiple changes at once — focus on one thing at a time
- When showing code changes, briefly explain what changed and why
- If something might break, warn them kindly before proceeding

## Workflow
- After each change, briefly confirm what you did
- Suggest related improvements they might want ("Want me to add a contact form next?")
- If they seem stuck, offer 2-3 concrete options to choose from
- Keep the conversation moving forward — don't wait for them to know what to ask`;
