/**
 * A lead-list member's address, for a query that joins linkedin_lead_contacts
 * as `lc` and LEFT JOINs contacts as `p`: the canonical Person's email when it
 * has one, else the address imported with the lead. Lower-cased so suppression,
 * already-emailed and recipient comparisons all see one spelling.
 */
export const RECIPIENT_SQL = `LOWER(COALESCE(NULLIF(BTRIM(p.email),''),NULLIF(BTRIM(lc.email),'')))`;
