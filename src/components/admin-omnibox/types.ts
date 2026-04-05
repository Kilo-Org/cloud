/**
 * Admin Omnibox Types
 *
 * Declarative system for defining action groups and actions in the admin command palette.
 * Actions can be conditionally shown based on context (current page, organization, etc.)
 */

import type { LucideIcon } from 'lucide-react';

/**
 * Context available to actions for conditional rendering and execution
 */
export type OmniboxContext = {
  /** Current pathname */
  pathname: string;
  /** Organization ID if on an organization page */
  organizationId: string | null;
  /** Current user info */
  user: {
    id: string;
    email: string;
    name: string;
    isAdmin: boolean;
  } | null;
  /** Any additional context data */
  extra?: Record<string, unknown>;
};

/**
 * Condition function to determine if an action/group should be shown
 */
export type OmniboxCondition = (context: OmniboxContext) => boolean;

/**
 * Action handler function
 */
export type OmniboxActionHandler = (context: OmniboxContext) => void | Promise<void>;

/**
 * Individual action definition
 */
export type OmniboxAction = {
  /** Unique identifier for the action */
  id: string;
  /** Display label for the action */
  label: string;
  /** Optional description shown below the label */
  description?: string;
  /** Optional icon */
  icon?: LucideIcon;
  /** Keywords for search matching (in addition to label) */
  keywords?: string[];
  /** Condition to show this action (defaults to always shown) */
  condition?: OmniboxCondition;
  /** Handler when action is selected */
  onSelect: OmniboxActionHandler;
  /** Optional keyboard shortcut hint to display */
  shortcut?: string;
};

/**
 * Action group definition
 */
export type OmniboxActionGroup = {
  /** Unique identifier for the group */
  id: string;
  /** Display label for the group */
  label: string;
  /** Optional icon for the group */
  icon?: LucideIcon;
  /** Priority for ordering (higher = shown first) */
  priority?: number;
  /** Condition to show this group (defaults to always shown) */
  condition?: OmniboxCondition;
  /** Actions in this group */
  actions: OmniboxAction[];
};

/**
 * Admin link definition for the info panel
 */
export type OmniboxAdminLink = {
  /** Display label */
  label: string;
  /** URL to navigate to */
  href: string;
  /** Optional icon */
  icon?: LucideIcon;
  /** Condition to show this link */
  condition?: OmniboxCondition;
};

/**
 * Registry for all action groups
 */
export type OmniboxActionRegistry = {
  groups: OmniboxActionGroup[];
  adminLinks: OmniboxAdminLink[];
};
