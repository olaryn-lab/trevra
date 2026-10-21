/** Serialize untrusted CSV data as text even when opened in Excel or Sheets. */
export function safeCsvCell(value: unknown): string {
  const source = value === null || value === undefined ? '' : String(value);
  // A leading space, tab, CR, BOM or other control cannot be used to smuggle a
  // formula prefix into an application that trims input before parsing cells.
  const risky = /^[\u0000-\u0020\uFEFF]*[=+\-@]/u.test(source) || /^[\t\r\n]/u.test(source);
  const text = risky ? `'${source}` : source;
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
