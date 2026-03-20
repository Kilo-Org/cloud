/**
 * Admin Omnibox Action Registry
 *
 * Central registry for all admin omnibox actions.
 * Actions are organized into groups and can be conditionally shown based on context.
 */

import { Shield, User, Users, Building2, ExternalLink } from 'lucide-react';
import type {
  OmniboxActionRegistry,
  OmniboxActionGroup,
  OmniboxAdminLink,
  OmniboxContext,
} from './types';

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Check if the current page is an organization page
 */
const isOrganizationPage = (ctx: OmniboxContext): boolean => {
  return ctx.pathname.startsWith('/organizations/') && ctx.organizationId !== null;
};

// ============================================================================
// Action Groups
// ============================================================================

/**
 * Role Testing action group
 * Only shown on organization pages
 */
export const createRoleTestingGroup = (
  onRoleChange: (role: 'KILO ADMIN' | 'owner' | 'member') => void
): OmniboxActionGroup => ({
  id: 'role-testing',
  label: 'Role Testing',
  icon: Shield,
  priority: 100,
  condition: isOrganizationPage,
  actions: [
    {
      id: 'role-kilo-admin',
      label: 'Switch to Kilo Admin',
      description: 'View as a Kilo administrator',
      icon: Shield,
      keywords: ['admin', 'kilo', 'role', 'testing', 'switch'],
      onSelect: () => onRoleChange('KILO ADMIN'),
    },
    {
      id: 'role-owner',
      label: 'Switch to Owner',
      description: 'View as organization owner',
      icon: User,
      keywords: ['owner', 'role', 'testing', 'switch'],
      onSelect: () => onRoleChange('owner'),
    },
    {
      id: 'role-member',
      label: 'Switch to Member',
      description: 'View as organization member',
      icon: Users,
      keywords: ['member', 'role', 'testing', 'switch'],
      onSelect: () => onRoleChange('member'),
    },
  ],
});

// ============================================================================
// Admin Links
// ============================================================================

/**
 * Generate admin links based on context
 */
export const createAdminLinks = (): OmniboxAdminLink[] => [
  {
    label: 'Admin Panel',
    href: '/admin/users',
    icon: Building2,
  },
  {
    label: 'Organization Admin',
    href: '', // Will be dynamically set based on organizationId
    icon: ExternalLink,
    condition: isOrganizationPage,
  },
];

// ============================================================================
// Registry Factory
// ============================================================================

export type CreateRegistryOptions = {
  onRoleChange: (role: 'KILO ADMIN' | 'owner' | 'member') => void;
};

/**
 * Create the action registry with all groups and links
 */
export const createActionRegistry = (options: CreateRegistryOptions): OmniboxActionRegistry => {
  const groups: OmniboxActionGroup[] = [createRoleTestingGroup(options.onRoleChange)];

  const adminLinks = createAdminLinks();

  return {
    groups,
    adminLinks,
  };
};

/**
 * Filter groups and actions based on context
 */
export const filterRegistry = (
  registry: OmniboxActionRegistry,
  context: OmniboxContext
): OmniboxActionRegistry => {
  const filteredGroups = registry.groups
    .filter(group => !group.condition || group.condition(context))
    .map(group => ({
      ...group,
      actions: group.actions.filter(action => !action.condition || action.condition(context)),
    }))
    .filter(group => group.actions.length > 0)
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));

  const filteredLinks = registry.adminLinks.filter(
    link => !link.condition || link.condition(context)
  );

  return {
    groups: filteredGroups,
    adminLinks: filteredLinks,
  };
};
