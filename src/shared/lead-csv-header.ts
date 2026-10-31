/**
 * Where the header row of a lead CSV is.
 *
 * Almost always row one. The exception worth handling is LinkedIn's own
 * Connections.csv ("Get a copy of your data"), which opens with a few "Notes:"
 * lines -- one of them a quoted paragraph full of commas -- before the real
 * header. Read naively, "Notes:" becomes the only column and every connection
 * is rejected.
 *
 * DETERMINISTIC, NOT A GUESS. The header is the first row, within the first
 * `LEAD_CSV_PREAMBLE_SCAN_ROWS` records, that carries every column of the
 * Connections export's required header set -- and only if every row before it
 * is a one-cell note. A file without that shape is read exactly as before: row
 * one is the header. So an ordinary CSV, whose first row has several cells,
 * can never have a data row promoted to its header. Shared so the screen's
 * local sample and the server's parser of record pick the same row.
 */

/** How many leading records are searched for a Connections header. */
export const LEAD_CSV_PREAMBLE_SCAN_ROWS = 20;

/** Every column LinkedIn's Connections export has carried in recent formats. */
export const LINKEDIN_CONNECTIONS_COLUMNS = [
  'First Name',
  'Last Name',
  'URL',
  'Email Address',
  'Company',
  'Position',
  'Connected On'
] as const;

/**
 * The subset that identifies the export. `URL` and `Email Address` are left
 * out on purpose: older exports lacked `URL`, and neither is distinctive.
 */
const CONNECTIONS_REQUIRED = ['First Name', 'Last Name', 'Company', 'Position', 'Connected On'];

export function csvHeaderKey(value: string): string {
  return value
    .replace(/^﻿/, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

const REQUIRED_KEYS = CONNECTIONS_REQUIRED.map(csvHeaderKey);

/** True when this row is a LinkedIn Connections export header. */
export function isLinkedInConnectionsHeader(cells: readonly string[]): boolean {
  const keys = new Set(cells.map((cell) => csvHeaderKey(String(cell ?? ''))));
  return REQUIRED_KEYS.every((key) => keys.has(key));
}

/** Index of the header row among parsed records (0 unless a Connections preamble precedes it). */
export function leadCsvHeaderRowIndex(rows: ReadonlyArray<readonly string[]>): number {
  const limit = Math.min(rows.length, LEAD_CSV_PREAMBLE_SCAN_ROWS);
  for (let index = 0; index < limit; index += 1) {
    const row = rows[index] ?? [];
    if (isLinkedInConnectionsHeader(row)) return index;
    // A preamble line is a single note ("Notes:", a quoted paragraph) or blank.
    // Anything wider is a real header or data, and row one stays the header.
    if (row.filter((cell) => String(cell ?? '').trim() !== '').length > 1) return 0;
  }
  return 0;
}
