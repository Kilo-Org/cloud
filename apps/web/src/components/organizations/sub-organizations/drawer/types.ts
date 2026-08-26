import type { inferRouterOutputs } from '@trpc/server';
import type { RootRouter } from '@/routers/root-router';

/**
 * The already-loaded `organizations.subOrganizations.people` response. Both
 * bulk-action wizards render entirely from this shape (people + direct
 * children) — see `MemberManagementDrawerStack.tsx` for how it's threaded
 * down from the page query into the drawer's `renderContent` closure — so
 * neither wizard issues its own fetch for directory data.
 */
export type SubOrganizationPeopleData =
  inferRouterOutputs<RootRouter>['organizations']['subOrganizations']['people'];

/**
 * The member-management drawer originally had exactly one entry shape:
 * managing a single child organization's members. A second and third kind
 * (the add-people and remove-people bulk wizards) have since arrived, so
 * this is now the discriminated union the original single-shape type's
 * comment anticipated.
 *
 * Every variant is opened via `drawer.open(...)`, replacing the whole stack
 * with a single entry, rather than `push`ed onto an existing one — see
 * `MemberManagementDrawerStack.tsx` for why that matters for the wizards'
 * Back/Close semantics.
 */
export type MemberManagementDrawerEntry =
  | {
      type: 'manage-members';
      /** The child organization to manage. */
      childOrganizationId: string;
      /** Display name of the child organization, for the drawer title. */
      childOrganizationName: string;
    }
  | {
      type: 'add-people';
      /**
       * Identity keys pre-selected from the directory table's checkbox
       * column. May be empty — the wizard's own select-people step falls
       * back to a full searchable list in that case.
       */
      seededIdentityKeys: string[];
    }
  | {
      type: 'remove-people';
      /** Same seeding contract as `add-people`. */
      seededIdentityKeys: string[];
    }
  | {
      /**
       * Invites a brand-new person — someone with no existing membership or
       * invitation anywhere in this org tree, so they can't be seeded from
       * the directory table the way `add-people`/`remove-people` are —
       * into the parent org or any one of its direct children.
       */
      type: 'invite-person';
    };
