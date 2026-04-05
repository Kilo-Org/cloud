/**
 * Slash command types for cloud agent chat input autocomplete.
 * Commands are organized into sets that can be enabled/disabled.
 */

/**
 * Represents a single slash command that can be triggered in the chat input.
 */
export type SlashCommand = {
  /** Full command without the leading "/" (e.g., "github-open-pullrequest") */
  trigger: string;
  /** Human-readable label (e.g., "Open Pull Request") */
  label: string;
  /** Short description shown in autocomplete dropdown */
  description: string;
  /**
   * The full prompt text to send to the AI agent when this command is selected.
   * Should be plain text with clear, imperative instructions.
   * No special formatting or sanitization required - text is sent as-is to the model.
   * Example: "Use gh CLI to check for PR feedback. Fix all requested code changes. GH_TOKEN is configured."
   */
  expansion: string;
};

/**
 * A set of related slash commands that can be enabled/disabled together.
 */
export type CommandSet = {
  /** Unique identifier (e.g., "github") */
  id: string;
  /** Display name (e.g., "GitHub") */
  name: string;
  /** Description for settings UI */
  description: string;
  /** Prefix used for command naming (e.g., "github-") */
  prefix: string;
  /** List of commands in this set */
  commands: SlashCommand[];
};
