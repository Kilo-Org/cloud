/**
 * Drawer entries for the Alerts surface. An alert's type is immutable, so an
 * existing alert is referenced by identity alone and the type is only chosen
 * while creating.
 */
export type OrganizationAlertsDrawerRef =
  | { type: 'alert-create' }
  | { type: 'alert-edit'; alertId: string };
