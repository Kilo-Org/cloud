import type {
  OrganizationAlertDefinitionOf,
  OrganizationAlertType,
} from '@/lib/organizations/alerts/organization-alerts';
import type { LucideIcon } from 'lucide-react';
import type { ComponentType } from 'react';

/** What the shared drawer shell tells a type-specific editor about its alert. */
export type OrganizationAlertEditorContext<T extends OrganizationAlertType> = {
  mode: 'create' | 'edit';
  /** The stored configuration when editing, the type's initial one when creating. */
  definition: OrganizationAlertDefinitionOf<T>;
  /**
   * Distinct recipients already admitted to delivery for this alert's current
   * period, exactly as the router reports it. An editor uses it to explain that a
   * newly added address cannot receive this alert until the next period; it never
   * blocks the edit, because admission is enforced when a claim is created.
   */
  admittedRecipientCount: number;
  /**
   * Whether the organization may still create, enable, or expand alerts.
   * Disabling, archiving, and removing recipients stay available when false, so
   * losing entitlement cannot trap a disclosure configuration.
   */
  canExpand: boolean;
};

export type OrganizationAlertSaveInput<T extends OrganizationAlertType> = {
  definition: OrganizationAlertDefinitionOf<T>;
  recipientDisclosureConfirmed: boolean;
};

/** Generic lifecycle chrome, available only for an alert that already exists. */
export type OrganizationAlertLifecycleActions = {
  isEnabled: boolean;
  onSetEnabled: (enabled: boolean) => void;
  isUpdatingEnabled: boolean;
  onArchive: () => Promise<void> | void;
  isArchiving: boolean;
};

export type OrganizationAlertEditorProps<T extends OrganizationAlertType> = {
  context: OrganizationAlertEditorContext<T>;
  onSave: (input: OrganizationAlertSaveInput<T>) => void;
  isSaving: boolean;
  /**
   * The last server failure, including a stale-version conflict. The shell
   * refreshes the alert on failure, so showing this inline lets the user retry
   * against the current version instead of losing the edit.
   */
  error: string | null;
  onCancel: () => void;
  lifecycle: OrganizationAlertLifecycleActions | null;
};

/**
 * Everything the Alerts shell needs to present and edit one alert type. A new
 * type is added by writing its definition and registering it; the list, the type
 * dropdown, and the drawer panels read it from here.
 */
export type OrganizationAlertClientDefinition<T extends OrganizationAlertType> = {
  type: T;
  label: string;
  description: string;
  Icon: LucideIcon;
  createInitialDefinition: (context: {
    /** The creating user's address, suggested as the first recipient. */
    suggestedRecipient: string | null;
  }) => OrganizationAlertDefinitionOf<T>;
  Editor: ComponentType<OrganizationAlertEditorProps<T>>;
};
