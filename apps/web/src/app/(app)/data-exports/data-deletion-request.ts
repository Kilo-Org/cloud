// Data deletion is support-mediated: kilo.ai/support creates a Pylon issue that a
// support agent fulfils manually. The support form's category select is
// uncontrolled and the page reads no search params, so the category cannot be
// preselected from a link — the confirmation dialog has to name it in copy
// instead. Keep DATA_DELETION_COPY.dialogInstruction in sync with the "Account
// Deletion" option label on that form.
//
// LANDING_URL is deliberately not imported here: it is NODE_ENV-dependent, which
// would force the test to assert a localhost URL. Callers compose the full URL.
export const DATA_DELETION_SUPPORT_PATH = '/support';

export const DATA_DELETION_COPY = {
  cardTitle: 'Delete your data',
  cardDescription:
    'Data deletion is handled by our support team. Request it from the support form.',
  triggerLabel: 'Request data deletion',
  dialogTitle: 'Delete your Kilo data?',
  dialogDescription:
    'Download your data export before requesting deletion. Once your data is deleted, any export download will no longer be available.',
  dialogInstruction: 'On the support form, choose the Account Deletion category.',
  cancelLabel: 'Cancel',
  confirmLabel: 'Continue to support form',
} as const;
