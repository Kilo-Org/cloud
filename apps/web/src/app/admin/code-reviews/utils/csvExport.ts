/**
 * CSV Export utility for Code Reviews
 *
 * Handles CSV generation and download with proper escaping
 * and protection against formula injection attacks.
 */

type CodeReviewExportRow = {
  id: string;
  owned_by_organization_id: string | null;
  owned_by_user_id: string | null;
  repo_full_name: string | null;
  pr_number: number | null;
  pr_title: string | null;
  pr_author: string | null;
  status: string | null;
  error_message: string | null;
  started_at: Date | string | null;
  completed_at: Date | string | null;
  created_at: Date | string | null;
  session_id: string | null;
};

/**
 * Escapes a CSV value to prevent formula injection and handle special characters.
 *
 * Protection against CSV injection attacks:
 * - Values starting with =, +, -, @, tab, or carriage return are prefixed with single quote
 * - This prevents execution of formulas like =HYPERLINK() or =CMD|'/C calc'!A0
 *
 * Standard CSV escaping:
 * - Values containing commas, quotes, or newlines are wrapped in double quotes
 * - Internal double quotes are escaped by doubling them
 */
function escapeCsvValue(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  let str = String(value);

  // Prevent CSV formula injection
  // Characters that can trigger formula execution in Excel/Google Sheets
  if (/^[=+\-@\t\r]/.test(str)) {
    str = `'${str}`; // Prefix with single quote to treat as text
  }

  // Standard CSV escaping
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Exports code review data to a CSV file and triggers download.
 *
 * @param data - Array of code review records
 * @param startDate - Start date for filename
 * @param endDate - End date for filename
 */
export function exportCodeReviewsToCSV(
  data: CodeReviewExportRow[],
  startDate: string,
  endDate: string
): void {
  if (!data || data.length === 0) return;

  const headers = [
    'id',
    'ownership_type',
    'org_id',
    'user_id',
    'repo',
    'pr_number',
    'pr_title',
    'pr_author',
    'status',
    'error_message',
    'started_at',
    'completed_at',
    'created_at',
    'session_id',
  ];

  const csvRows = [
    headers.join(','),
    ...data.map(row =>
      [
        escapeCsvValue(row.id),
        escapeCsvValue(row.owned_by_organization_id ? 'organization' : 'personal'),
        escapeCsvValue(row.owned_by_organization_id),
        escapeCsvValue(row.owned_by_user_id),
        escapeCsvValue(row.repo_full_name),
        escapeCsvValue(row.pr_number),
        escapeCsvValue(row.pr_title),
        escapeCsvValue(row.pr_author),
        escapeCsvValue(row.status),
        escapeCsvValue(row.error_message),
        escapeCsvValue(row.started_at ? String(row.started_at) : ''),
        escapeCsvValue(row.completed_at ? String(row.completed_at) : ''),
        escapeCsvValue(row.created_at ? String(row.created_at) : ''),
        escapeCsvValue(row.session_id),
      ].join(',')
    ),
  ];

  // Create and download the file synchronously to avoid orphaned elements
  const csvContent = csvRows.join('\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  const url = URL.createObjectURL(blob);

  link.setAttribute('href', url);
  link.setAttribute('download', `code-reviews-${startDate}-to-${endDate}.csv`);
  link.style.visibility = 'hidden';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
