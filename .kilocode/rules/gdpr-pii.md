# GDPR & PII Handling

When adding PII (email, name, IP address, etc.) to the database — whether as a new table or a new column — you MUST also update the GDPR soft-delete flow in `softDeleteUser` (`src/lib/user.ts`) to delete or anonymize that data, and add a corresponding test in `src/lib/user.test.ts`.
