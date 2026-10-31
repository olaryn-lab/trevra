import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight,
  Check,
  CircleAlert,
  FileUp,
  LoaderCircle,
  Pencil,
  RefreshCw,
  Trash2,
  Upload,
  Users,
  X
} from 'lucide-react';
import {
  createLinkedInManagerLeadList,
  deleteLinkedInManagerLeadContact,
  getLinkedInManagerLeadContacts,
  getLinkedInManagerLeadLists,
  importLinkedInManagerLeadCsv,
  importLinkedInManagerProfileUrls,
  previewLinkedInManagerLeadCsv,
  previewLinkedInManagerProfileUrls,
  renameLinkedInManagerLeadList,
  updateLinkedInManagerLeadContact,
  type LinkedInLeadCsvPreview,
  type PastedProfileRejection
} from './api';
import type {
  LeadListSourceKind,
  LinkedInLeadContact,
  LinkedInLeadList
} from '../server/linkedin/lead-lists';
import { LEAD_CSV_PREAMBLE_SCAN_ROWS, leadCsvHeaderRowIndex } from '../shared/lead-csv-header';
import { useActiveSeatKey } from './LinkedInActiveAccount';
import { useIsWorkspaceOwner } from './auth-client';
import {
  LEAD_CSV_PRESETS,
  detectLeadCsvPreset,
  leadCsvPreset,
  type LeadCsvPresetId
} from './leadCsvPresets';
import { errorMessage } from './LinkedInSafety';
import { CrmContactSync } from './CrmContactSync';
import { ActionMenu } from './ui/action-menu';
import { Button, Field, Select, Textarea } from './ui/primitives';
import { pluralGrouped } from './ui/plural';
/**
 * Building a lead list, and living with one afterwards.
 *
 * A CSV lands here in three moves -- read it, confirm which column is which,
 * put it in a list -- and the file is never stored until the last one. The
 * middle move is the point: the automatch is a guess at somebody else's export
 * format, and the operator is the only person who can see that "Account" meant
 * the company and "Name" meant both names at once.
 *
 * THE SECOND PANEL IS NOT AN AFTERTHOUGHT. A list is something people come
 * back to -- one bad row, one person who left, one company spelled two ways --
 * so the leads in it are editable here rather than only re-uploadable.
 */

/** Matches the server's own upload ceiling; a bigger file is refused before it is sent. */
const MAX_CSV_BYTES = 2 * 1024 * 1024;
/** How many data rows are read locally, for the header list and the name examples. */
const SAMPLE_ROWS = 8;
/** Rows of a list shown before "show more". */
const PAGE = 50;

type FieldMapping = LinkedInLeadCsvPreview['mapping'];
type LeadField = keyof FieldMapping;

/** What one import did. `reused` is on the wire; the client type predates it. */
type ImportReport = Awaited<ReturnType<typeof importLinkedInManagerLeadCsv>> & { reused?: number };

const FIELDS: ReadonlyArray<{ field: LeadField; label: string; required: boolean }> = [
  { field: 'firstName', label: 'First name', required: true },
  { field: 'lastName', label: 'Last name', required: true },
  { field: 'fullName', label: 'Full name (alternative)', required: false },
  { field: 'company', label: 'Company', required: true },
  { field: 'email', label: 'Email', required: false },
  { field: 'phone', label: 'Phone', required: false },
  { field: 'country', label: 'Country', required: false },
  { field: 'profileUrl', label: 'LinkedIn profile URL', required: false },
  { field: 'title', label: 'Job title', required: false }
];

/** Rejected pasted entries listed on screen; the count beside them is always exact. */
const PASTE_REJECTIONS_SHOWN = 20;

const REQUIRED_FIELDS: readonly LeadField[] = ['firstName', 'lastName', 'company'];

const SOURCE_LABELS: Record<LeadListSourceKind, string> = {
  csv: 'CSV',
  linkedin_search: 'LinkedIn people search',
  sales_navigator: 'Sales Navigator',
  post_keyword: 'Post and comment keywords',
  recruiter: 'LinkedIn Recruiter',
  group_members: 'LinkedIn group',
  event_attendees: 'LinkedIn event',
  company_employees: 'LinkedIn company people',
  profile_urls: 'LinkedIn profile URLs',
  signal: 'External signal'
};

const formatSize = (bytes: number) =>
  bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

/**
 * Enough CSV to read a header row and the first few lines, here in the page.
 *
 * The server is the parser of record -- this reads only what the screen has to
 * show before the server has answered: the column names, so the mapper can be
 * used even when the automatch missed a required field and the preview was
 * refused, and a handful of raw names, so the cleaned ones have something to
 * be compared against.
 */
function parseCsvRows(text: string, maxRows: number): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char !== '"') {
        cell += char;
        continue;
      }
      if (text[index + 1] === '"') {
        cell += '"';
        index += 1;
        continue;
      }
      quoted = false;
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === ',') {
      row.push(cell);
      cell = '';
      continue;
    }
    if (char === '\r') continue;
    if (char === '\n') {
      row.push(cell);
      rows.push(row);
      cell = '';
      row = [];
      if (rows.length >= maxRows) return rows;
      continue;
    }
    cell += char;
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

async function readCsvHead(
  file: File
): Promise<{ headers: string[]; rows: Array<Record<string, string>> }> {
  const slice = file.slice(0, 256 * 1024);
  const text = await slice.text();
  // Room for a LinkedIn Connections preamble above the header, then the sample.
  const raw = parseCsvRows(text, LEAD_CSV_PREAMBLE_SCAN_ROWS + SAMPLE_ROWS + 2);
  if (raw.length === 0) return { headers: [], rows: [] };
  // A sliced file can end mid-row, so the last row of a truncated read is dropped.
  const complete = slice.size < file.size && raw.length > 1 ? raw.slice(0, -1) : raw;
  // The same header rule as the server's parser, so the sample lines up with it.
  const headerIndex = leadCsvHeaderRowIndex(
    complete.filter((cells) => cells.some((cell) => cell.trim() !== ''))
  );
  const nonBlank = complete.filter((cells) => cells.some((cell) => cell.trim() !== ''));
  const headers = (nonBlank[headerIndex] ?? []).map((header) => header.replace(/^﻿/, ''));
  const rows = nonBlank
    .slice(headerIndex + 1)
    .slice(0, SAMPLE_ROWS)
    .map((cells) => {
      const record: Record<string, string> = {};
      headers.forEach((header, index) => {
        record[header] = cells[index] ?? '';
      });
      return record;
    });
  return { headers, rows };
}

function fileProblem(file: File): string {
  if (!/\.csv$/i.test(file.name))
    return `“${file.name}” is not a .csv file. Export your list as CSV and drop it here again.`;
  if (file.size === 0) return `“${file.name}” is empty.`;
  if (file.size > MAX_CSV_BYTES)
    return `“${file.name}” is ${formatSize(file.size)}, and 2 MB is the most one upload takes. Split it and import the parts one after another.`;
  return '';
}

interface ContactDraft {
  id: string;
  firstName: string;
  lastName: string;
  company: string;
  email: string;
  phone: string;
  country: string;
  profileUrl: string;
  doNotContact: boolean;
}

/** A request, from the screen around this one, to bring one way of adding leads forward. */
export interface LeadIntakeRequest {
  mode: 'csv' | 'paste';
  /** Bumped per request, so asking for the same mode twice still moves focus. */
  seq: number;
}

interface ProfileUrlCheck {
  /** The exact text that was checked; editing it makes the check stale. */
  text: string;
  acceptedCount: number;
  duplicates: number;
  rejected: PastedProfileRejection[];
  rejectedCount: number;
  cap: number;
}

export function LinkedInManagerLeadConfig({
  onChanged,
  setToast,
  compact = false,
  onImported,
  showSourceGuide = true,
  intakeRequest = null
}: {
  onChanged: () => Promise<void>;
  setToast: (message: string) => void;
  /**
   * The inline uploader used on the campaign screen: CSV -> a new list, full
   * stop. No destination picker (nothing to add to yet is the common case,
   * and picking an existing list already has its own card there), no "where
   * lead lists come from" aside, and -- the actual bug this mode exists to
   * kill -- no contacts browser, so nothing here calls `openList` and nothing
   * here can 404 on some other list while this one is mid-import.
   */
  compact?: boolean;
  /** Compact mode only: fires with the list a successful import just created. */
  onImported?: (list: LinkedInLeadList) => void;
  /** Off where the surrounding screen already explains which sources exist. */
  showSourceGuide?: boolean;
  /** Opens and focuses the paste box, or brings the CSV chooser into view. */
  intakeRequest?: LeadIntakeRequest | null;
}) {
  const [activeSeatKey] = useActiveSeatKey();
  const isOwner = useIsWorkspaceOwner();
  const [lists, setLists] = useState<LinkedInLeadList[]>([]);
  const [listsLoading, setListsLoading] = useState(true);

  /* -- the CSV half ------------------------------------------------------ */
  const [destination, setDestination] = useState('new');
  const [newName, setNewName] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [sample, setSample] = useState<{
    headers: string[];
    rows: Array<Record<string, string>>;
  } | null>(null);
  const [preview, setPreview] = useState<LinkedInLeadCsvPreview | null>(null);
  /** What the automatch chose on its own, kept so a change can be named as one. */
  const [autoMapping, setAutoMapping] = useState<FieldMapping>({});
  const [overrides, setOverrides] = useState<FieldMapping>({});
  /** The CSV format preset that pre-filled the mapping; '' when none did. */
  const [preset, setPreset] = useState<LeadCsvPresetId | ''>('');
  /** What that preset chose, so a column it set can be named as its choice. */
  const [presetMapping, setPresetMapping] = useState<FieldMapping>({});
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState<'' | 'preview' | 'import' | 'check'>('');
  const [report, setReport] = useState<{
    listName: string;
    listId: string;
    counts: ImportReport;
  } | null>(null);
  const [error, setError] = useState('');
  const [profileUrls, setProfileUrls] = useState('');
  const [pasteOpen, setPasteOpen] = useState(false);
  /** The last server check of the pasted text: per-line rejections, before any write. */
  const [pasteCheck, setPasteCheck] = useState<ProfileUrlCheck | null>(null);
  const [pasteError, setPasteError] = useState('');
  /** Last preview wins: changing two columns quickly must not race. */
  const previewToken = useRef(0);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const chooseFileRef = useRef<HTMLButtonElement | null>(null);
  const pasteRef = useRef<HTMLTextAreaElement | null>(null);

  /* -- the list half ----------------------------------------------------- */
  const [openListId, setOpenListId] = useState('');
  const [contacts, setContacts] = useState<LinkedInLeadContact[]>([]);
  const [nextContactOffset, setNextContactOffset] = useState(0);
  const [contactsMoreLoading, setContactsMoreLoading] = useState(false);
  /** Every new list/filter request invalidates earlier page responses. */
  const contactReadVersion = useRef(0);
  /** Number matching the current server-side filter, before pagination. */
  const [contactTotal, setContactTotal] = useState(0);
  const [listTotal, setListTotal] = useState(0);
  const [identityReviewCount, setIdentityReviewCount] = useState(0);
  const [contactsLoading, setContactsLoading] = useState(false);
  const [filter, setFilter] = useState('');
  const [needsIdentityOnly, setNeedsIdentityOnly] = useState(false);
  const [visible, setVisible] = useState(PAGE);
  const [draft, setDraft] = useState<ContactDraft | null>(null);
  const [armed, setArmed] = useState('');
  /** TRV-051: the lead whose CRM sync panel is open above the table. */
  const [crmSync, setCrmSync] = useState<{ id: string; name: string } | null>(null);
  const crmSyncRef = useRef<HTMLDivElement | null>(null);
  const [rowBusy, setRowBusy] = useState('');
  const [listError, setListError] = useState('');
  const [renamingList, setRenamingList] = useState(false);
  const [renameName, setRenameName] = useState('');
  const [renameBusy, setRenameBusy] = useState(false);
  const editorRef = useRef<HTMLDivElement | null>(null);
  /** The confirmation is brought to the operator for the same reason the editor is. */
  const confirmRef = useRef<HTMLDivElement | null>(null);

  const loadLists = useCallback(async (): Promise<LinkedInLeadList[]> => {
    setListsLoading(true);
    try {
      const next = await getLinkedInManagerLeadLists(activeSeatKey);
      setLists(next);
      return next;
    } catch (err) {
      setListError(errorMessage(err, 'Unable to read your lead lists.'));
      return [];
    } finally {
      setListsLoading(false);
    }
  }, [activeSeatKey]);

  const readContacts = useCallback(
    async (listId: string, query: string, needsReview: boolean, version: number) => {
      try {
        const result = await getLinkedInManagerLeadContacts(listId, activeSeatKey, {
          query,
          needsIdentityOnly: needsReview
        });
        if (contactReadVersion.current !== version) return;
        setContacts(result.contacts);
        setContactTotal(result.total);
        setListTotal(result.listTotal);
        setIdentityReviewCount(result.identityReviewCount);
        setNextContactOffset(result.offset + result.contacts.length);
        setListError('');
      } catch (err) {
        if (contactReadVersion.current === version)
          setListError(errorMessage(err, 'Unable to read the leads in that list.'));
      } finally {
        if (contactReadVersion.current === version) setContactsLoading(false);
      }
    },
    [activeSeatKey]
  );

  const openList = useCallback(
    async (listId: string) => {
      const version = ++contactReadVersion.current;
      setOpenListId(listId);
      setRenamingList(false);
      setContacts([]);
      setContactTotal(0);
      setListTotal(0);
      setIdentityReviewCount(0);
      setNextContactOffset(0);
      setContactsMoreLoading(false);
      setDraft(null);
      setArmed('');
      setFilter('');
      setNeedsIdentityOnly(false);
      setVisible(PAGE);
      if (!listId) return;
      setContactsLoading(true);
      await readContacts(listId, '', false, version);
    },
    [readContacts]
  );

  // Search all list members on the server; debounce keystrokes and invalidate
  // in-flight older queries before they can overwrite a newer filter.
  useEffect(() => {
    if (!openListId) return;
    const version = ++contactReadVersion.current;
    setContactsLoading(true);
    setContactsMoreLoading(false);
    // A failed new search must never leave stale contacts actionable as though
    // they matched the current server-side filter.
    setContacts([]);
    setContactTotal(0);
    setNextContactOffset(0);
    const timer = setTimeout(() => {
      setVisible(PAGE);
      void readContacts(openListId, filter, needsIdentityOnly, version);
    }, 250);
    return () => clearTimeout(timer);
    // Opening a new list starts its own default read; this effect is for filter changes.
  }, [filter, needsIdentityOnly]);
  const loadMoreContacts = async () => {
    if (!openListId || contactsLoading || contactsMoreLoading || nextContactOffset >= contactTotal)
      return;
    const version = contactReadVersion.current;
    const listId = openListId;
    setContactsMoreLoading(true);
    try {
      const page = await getLinkedInManagerLeadContacts(listId, activeSeatKey, {
        offset: nextContactOffset,
        query: filter,
        needsIdentityOnly
      });
      if (contactReadVersion.current !== version) return;
      setContacts((current) => {
        const known = new Set(current.map((contact) => contact.id));
        return [...current, ...page.contacts.filter((contact) => !known.has(contact.id))];
      });
      setContactTotal(page.total);
      setListTotal(page.listTotal);
      setIdentityReviewCount(page.identityReviewCount);
      setNextContactOffset(page.hasMore ? page.offset + page.contacts.length : page.total);
      setListError('');
    } catch (err) {
      if (contactReadVersion.current === version)
        setListError(errorMessage(err, 'Could not load the next page of leads.'));
    } finally {
      if (contactReadVersion.current === version) setContactsMoreLoading(false);
    }
  };
  useEffect(() => {
    // COMPACT MODE READS NOTHING ON MOUNT. The bug this shape exists to avoid:
    // opening some unrelated existing list's contacts here is exactly what
    // produced a "Lead list not found" banner over a CSV import that had
    // nothing to do with that list. A compact uploader has no contacts panel
    // to populate and no destination picker that needs the list of lists, so
    // it makes no request at all until a file is actually dropped.
    if (compact) return;
    void (async () => {
      const next = await loadLists();
      if (next.length > 0) await openList(next[0].id);
    })();
  }, [compact, loadLists, openList]);

  useEffect(() => {
    if (!intakeRequest) return;
    if (intakeRequest.mode === 'paste') {
      setPasteOpen(true);
      requestAnimationFrame(() => {
        pasteRef.current?.scrollIntoView({ block: 'center' });
        pasteRef.current?.focus();
      });
    } else {
      requestAnimationFrame(() => {
        chooseFileRef.current?.scrollIntoView({ block: 'center' });
        chooseFileRef.current?.focus();
      });
    }
  }, [intakeRequest]);

  const headers = preview?.headers ?? sample?.headers ?? [];

  /** The column each field is on right now: the operator's choice, else the server's. */
  const chosenHeader = useCallback(
    (field: LeadField): string =>
      overrides[field] ?? preview?.mapping?.[field] ?? autoMapping[field] ?? '',
    [overrides, preview, autoMapping]
  );

  const mappingToSend = useCallback(
    (next: FieldMapping): FieldMapping => {
      const mapping: FieldMapping = {};
      for (const { field } of FIELDS) {
        const header = next[field] ?? preview?.mapping?.[field] ?? autoMapping[field] ?? '';
        if (header) mapping[field] = header;
      }
      return mapping;
    },
    [preview, autoMapping]
  );

  const missingRequired = useMemo(
    () =>
      FIELDS.filter(
        (entry) =>
          entry.required &&
          !chosenHeader(entry.field) &&
          !(chosenHeader('fullName') && (entry.field === 'firstName' || entry.field === 'lastName'))
      ),
    [chosenHeader]
  );

  const runPreview = useCallback(
    async (
      target: File,
      mapping: FieldMapping,
      first: boolean
    ): Promise<LinkedInLeadCsvPreview | null> => {
      const token = previewToken.current + 1;
      previewToken.current = token;
      setBusy('preview');
      try {
        const result = await previewLinkedInManagerLeadCsv(
          target,
          Object.keys(mapping).length > 0 ? mapping : undefined
        );
        if (previewToken.current !== token) return null;
        setPreview(result);
        if (first) setAutoMapping(result.mapping);
        setError('');
        return result;
      } catch (err) {
        if (previewToken.current !== token) return null;
        setPreview(null);
        const message = errorMessage(err, 'Unable to read that CSV.');
        // "Could not map required field" is not a fault to report twice: the
        // mapper below already shows which identity columns are still unanswered.
        setError(/Could not map required field/i.test(message) ? '' : message);
        return null;
      } finally {
        if (previewToken.current === token) setBusy('');
      }
    },
    []
  );

  /** Pre-fill the mapping from a preset. Every column stays visible and changeable. */
  const applyPresetTo = useCallback(
    async (target: File, id: LeadCsvPresetId | '', fileHeaders: readonly string[]) => {
      const chosen = id ? leadCsvPreset(id) : undefined;
      const mapping = chosen ? chosen.map(fileHeaders) : {};
      setPreset(chosen ? chosen.id : '');
      setPresetMapping(mapping);
      setOverrides(mapping);
      await runPreview(target, mapping, false);
    },
    [runPreview]
  );

  const takeFile = useCallback(
    async (next: File | null) => {
      if (!next) return;
      const problem = fileProblem(next);
      if (problem) {
        setError(problem);
        return;
      }
      setReport(null);
      setError('');
      setFile(next);
      setPreview(null);
      setAutoMapping({});
      setOverrides({});
      setPreset('');
      setPresetMapping({});
      setSample(null);
      // Compact mode has no destination picker, so the list name has to come
      // from somewhere other than an operator typing it first -- the file's
      // own name, same spirit as the campaign name default: filled in,
      // editable, never blank.
      if (compact && !newName.trim()) {
        const guess = next.name
          .replace(/\.csv$/i, '')
          .replace(/[_-]+/g, ' ')
          .trim();
        setNewName(guess || 'Leads');
      }
      let head: Awaited<ReturnType<typeof readCsvHead>> | null = null;
      try {
        head = await readCsvHead(next);
        setSample(head);
      } catch {
        /* the preview below reports what is wrong with it */
      }
      // The plain automatch runs first so "Changed from" keeps naming what the
      // headings alone would have chosen.
      const first = await runPreview(next, {}, true);
      // LinkedIn's Connections export is recognisable from its own header, so
      // its preset is pre-selected; the select and the mapping stay editable.
      const fileHeaders = first?.headers ?? head?.headers ?? [];
      const detected = detectLeadCsvPreset(fileHeaders);
      if (detected) await applyPresetTo(next, detected, fileHeaders);
    },
    [runPreview, applyPresetTo, compact, newName]
  );

  const changeMapping = (field: LeadField, header: string) => {
    // An explicit '' is kept, not deleted: deleting would fall back to the
    // column the previous preview (or a preset) chose, so "Not imported" could
    // never stick.
    const next: FieldMapping = { ...overrides, [field]: header };
    setOverrides(next);
    if (!file) return;
    const mapping = mappingToSend(next);
    // A mapping without a company and a usable name source would come back as
    // an error, not a preview. It is a half-finished form, so it waits.
    if (
      mapping.company &&
      (mapping.fullName || REQUIRED_FIELDS.every((required) => mapping[required]))
    )
      void runPreview(file, mapping, false);
    else {
      setPreview(null);
      setError('');
    }
  };

  const changePreset = (id: string) => {
    if (!file || !headers.length) return;
    void applyPresetTo(file, (leadCsvPreset(id)?.id ?? '') as LeadCsvPresetId | '', headers);
  };

  /**
   * A few rows as they are in the file, beside the names that will be stored.
   *
   * Accepted rows come back in file order and every rejected row names its own
   * line number, so walking the local sample and the accepted list together
   * pairs raw row to cleaned row without either side carrying an id.
   */
  const scrubExamples = useMemo(() => {
    if (!preview || !sample) return [];
    const rejectedRows = new Set(preview.rejected.map((entry) => entry.row));
    const firstHeader = chosenHeader('firstName');
    const lastHeader = chosenHeader('lastName');
    const fullHeader = chosenHeader('fullName');
    const pairs: Array<{ before: string; after: string; changed: boolean }> = [];
    let acceptedIndex = 0;
    sample.rows.forEach((row, index) => {
      if (rejectedRows.has(index + 2)) return;
      const clean = preview.accepted[acceptedIndex];
      acceptedIndex += 1;
      if (!clean) return;
      const before = (
        firstHeader || lastHeader
          ? `${firstHeader ? (row[firstHeader] ?? '') : ''} ${lastHeader ? (row[lastHeader] ?? '') : ''}`
          : fullHeader
            ? (row[fullHeader] ?? '')
            : ''
      )
        .replace(/\s+/g, ' ')
        .trim();
      const after = `${clean.firstName} ${clean.lastName}`.trim();
      if (before) pairs.push({ before, after, changed: before !== after });
    });
    const changed = pairs.filter((pair) => pair.changed);
    return (changed.length > 0 ? changed : pairs).slice(0, 3);
  }, [preview, sample, chosenHeader]);

  const destinationList = lists.find((list) => list.id === destination) ?? null;
  const canImport =
    busy === '' &&
    file !== null &&
    preview !== null &&
    preview.acceptedCount > 0 &&
    missingRequired.length === 0 &&
    (destination !== 'new' ? destinationList !== null : newName.trim().length > 0);

  /** Why the import button is off, said where the button is. */
  const blocker = !file
    ? ''
    : missingRequired.length > 0
      ? 'Map company and either a full-name column or separate first and last names before importing.'
      : !preview
        ? ''
        : preview.acceptedCount === 0
          ? 'No row has usable first and last names plus a company; correct the source data or mapping.'
          : destination === 'new' && !newName.trim()
            ? 'Name the new list before importing.'
            : '';

  const runImport = async () => {
    if (!file || !canImport) return;
    setBusy('import');
    setError('');
    try {
      const list =
        destination === 'new'
          ? await createLinkedInManagerLeadList({
              seatKey: activeSeatKey,
              name: newName.trim(),
              sourceKind: (preset ? leadCsvPreset(preset)?.listKind : undefined) ?? 'csv'
            })
          : destinationList!;
      const counts = (await importLinkedInManagerLeadCsv(
        list.id,
        file,
        mappingToSend(overrides),
        activeSeatKey
      )) as ImportReport;
      setToast(
        counts.inserted > 0
          ? `${pluralGrouped(counts.inserted, 'lead')} added to “${list.name}”. Campaigns can enrol from it now.`
          : `Nothing new was added to “${list.name}” — every usable row was already there.`
      );
      // The file is done. A second import is a deliberate act, not a stray click.
      setFile(null);
      setPreview(null);
      setSample(null);
      setOverrides({});
      setAutoMapping({});
      setPreset('');
      setPresetMapping({});
      setNewName('');
      if (compact) {
        // No report panel, no reopening a contacts browser this mode doesn't
        // have -- the caller (the campaign screen) already knows what to do
        // with the list it just got handed.
        onImported?.(list);
      } else {
        setReport({ listId: list.id, listName: list.name, counts });
        setDestination(list.id);
        await loadLists();
        await openList(list.id);
      }
      await onChanged();
    } catch (err) {
      setError(errorMessage(err, 'Unable to import that CSV. Nothing was stored.'));
    } finally {
      setBusy('');
    }
  };

  /** The check of the text in the box right now, or null once the text has changed. */
  const currentPasteCheck = pasteCheck && pasteCheck.text === profileUrls ? pasteCheck : null;

  /**
   * Two steps, the same pipeline as a CSV. First the server checks the paste
   * (nothing is written, no list is created): over the 10,000 cap it refuses
   * the whole paste, and every rejected line comes back with its reason. If
   * anything was rejected the operator sees it first; the next press adds the
   * valid profiles. A clean paste goes straight through.
   */
  const runProfileUrlImport = async () => {
    const text = profileUrls;
    if (!text.trim()) return;
    if ((compact || destination === 'new') && !newName.trim()) {
      setPasteError('Name the new list below before adding profile URLs.');
      return;
    }
    setPasteError('');
    let check = currentPasteCheck;
    if (!check) {
      setBusy('check');
      try {
        const result = await previewLinkedInManagerProfileUrls(text);
        check = { text, ...result };
        setPasteCheck(check);
      } catch (err) {
        setPasteCheck(null);
        setPasteError(errorMessage(err, 'Unable to check those LinkedIn profile URLs.'));
        return;
      } finally {
        setBusy('');
      }
      if (check.rejectedCount > 0) return;
    }
    if (check.acceptedCount === 0) return;
    setBusy('import');
    try {
      const list =
        destination === 'new'
          ? await createLinkedInManagerLeadList({
              seatKey: activeSeatKey,
              name: newName.trim(),
              sourceKind: 'profile_urls'
            })
          : destinationList!;
      const counts = await importLinkedInManagerProfileUrls(list.id, text, activeSeatKey);
      setToast(
        counts.inserted > 0 || counts.reused > 0
          ? `${pluralGrouped(counts.inserted + counts.reused, 'profile')} added to “${list.name}”.${counts.rejectedCount ? ` ${pluralGrouped(counts.rejectedCount, 'entry', 'entries')} rejected.` : ''}`
          : `Nothing new was added to “${list.name}”.`
      );
      setProfileUrls('');
      setPasteCheck(null);
      setNewName('');
      if (compact) {
        onImported?.(list);
      } else {
        setDestination(list.id);
        await loadLists();
        await openList(list.id);
      }
      await onChanged();
    } catch (err) {
      setPasteError(errorMessage(err, 'Unable to import those LinkedIn profile URLs.'));
    } finally {
      setBusy('');
    }
  };

  const pasteButtonLabel = !currentPasteCheck
    ? ' Check and add profiles'
    : currentPasteCheck.acceptedCount === 0
      ? ' No valid profile to add'
      : ` Add ${pluralGrouped(currentPasteCheck.acceptedCount, 'valid profile')}`;

  /* -- editing what is already in a list --------------------------------- */

  const startEdit = (contact: LinkedInLeadContact) => {
    setArmed('');
    // The editor is not inside the table -- a form in a sideways-scrolling row
    // is a form a phone cannot reach -- so it is brought to the operator
    // instead of the operator hunting for it.
    requestAnimationFrame(() => editorRef.current?.scrollIntoView({ block: 'nearest' }));
    setDraft({
      id: contact.id,
      firstName: contact.firstName,
      lastName: contact.lastName,
      company: contact.company,
      email: contact.email ?? '',
      phone: contact.phone ?? '',
      country: contact.country ?? '',
      profileUrl: contact.profileUrl ?? '',
      doNotContact: contact.doNotContact
    });
  };

  const saveContact = async () => {
    if (!draft) return;
    setRowBusy(draft.id);
    try {
      const updated = await updateLinkedInManagerLeadContact(draft.id, {
        firstName: draft.firstName.trim(),
        lastName: draft.lastName.trim(),
        company: draft.company.trim(),
        email: draft.email.trim() || null,
        phone: draft.phone.trim() || null,
        country: draft.country.trim() || null,
        profileUrl: draft.profileUrl.trim() || null,
        doNotContact: draft.doNotContact
      });
      setDraft(null);
      setVisible(PAGE);
      setContactsLoading(true);
      await readContacts(openListId, filter, needsIdentityOnly, ++contactReadVersion.current);
      setToast(`${updated.firstName} ${updated.lastName} updated.`);
      await onChanged();
    } catch (err) {
      setListError(errorMessage(err, 'Unable to save that lead.'));
    } finally {
      setRowBusy('');
    }
  };

  /**
   * Removing a lead is not removing a row from a list.
   *
   * `linkedin_campaign_members.contact_id` and `linkedin_manual_tasks.contact_id`
   * both reference this record ON DELETE CASCADE, so deleting the contact takes
   * their place in every campaign they are enrolled in and every message a
   * campaign was waiting on the operator to write for them. The old sentence --
   * "any campaign they are already in is unaffected" -- was the exact opposite
   * of what the schema does, and it was said AFTER the fact. What Trevra
   * already sent is untouched: `linkedin_actions` keys on the profile URL and
   * holds no reference to this record, so the ledger keeps its history.
   */
  const removeContact = async (contact: LinkedInLeadContact) => {
    setRowBusy(contact.id);
    try {
      // The success state follows an authenticated, affirmative deletion reply.
      await deleteLinkedInManagerLeadContact(contact.id);
      setArmed('');
      setVisible(PAGE);
      setContactsLoading(true);
      await readContacts(openListId, filter, needsIdentityOnly, ++contactReadVersion.current);
      setToast(
        `${contact.firstName} ${contact.lastName} removed. Their place in every campaign they were in went with them, along with any message a campaign was waiting on you to write for them. What Trevra already sent stays in the ledger.`
      );
      await loadLists();
      await onChanged();
    } catch (err) {
      setListError(errorMessage(err, 'Unable to remove that lead.'));
    } finally {
      setRowBusy('');
    }
  };

  const openMeta = lists.find((list) => list.id === openListId) ?? null;
  /** The lead a Remove press has armed, so the consequences can be read before the second press. */
  const armedContact = contacts.find((contact) => contact.id === armed) ?? null;
  const needsIdentity = (contact: LinkedInLeadContact) =>
    !contact.firstName.trim() || !contact.lastName.trim() || !contact.company.trim();
  /** The server filters the whole list; these are only the currently loaded matching rows. */
  const filtered = contacts;
  const shown = filtered.slice(0, visible);
  const draftValid =
    draft !== null &&
    draft.firstName.trim() !== '' &&
    draft.lastName.trim() !== '' &&
    draft.company.trim() !== '';

  /**
   * The mapping row, built once and rendered either always-open (a required
   * field is still unmapped, so there is nothing to progressively disclose --
   * the operator has to look at it) or behind a closed `<details>` (fuzzy
   * automatch already resolved everything, so the grid is the exception now,
   * not the default view of a successful drop).
   */
  const mappingRows = FIELDS.map((entry) => {
    const chosen = chosenHeader(entry.field);
    const auto = autoMapping[entry.field] ?? '';
    const missing = missingRequired.some((item) => item.field === entry.field);
    const guessed = chosen === auto && preview?.mappingConfidence?.[entry.field] === 'guessed';
    return (
      <label
        key={entry.field}
        className={
          missing ? 'lead-map-row is-missing' : guessed ? 'lead-map-row is-guessed' : 'lead-map-row'
        }
      >
        <span className="lead-map-name">
          {entry.label}
          {entry.required && !chosenHeader('fullName') && <em>Required</em>}
          {entry.field === 'company' && chosenHeader('fullName') && <em>Required</em>}
        </span>
        <Select
          value={chosen}
          disabled={busy !== ''}
          onChange={(event) => changeMapping(entry.field, event.target.value)}
        >
          {!chosen && <option value="">{missing ? 'Choose a column…' : 'Not imported'}</option>}
          {!entry.required && !auto && chosen && <option value="">Not imported</option>}
          {headers.map((header) => (
            <option key={header} value={header}>
              {header || '(unnamed column)'}
            </option>
          ))}
        </Select>
        <span className="lead-map-note">
          {preset && presetMapping[entry.field] && chosen === presetMapping[entry.field]
            ? 'Set by the format preset'
            : chosen && auto && chosen !== auto
              ? `Changed from “${auto}”`
              : guessed
                ? 'Guessed from its heading — check this'
                : chosen && chosen === auto
                  ? 'Matched by its heading'
                  : chosen
                    ? 'Your choice'
                    : 'No column matched'}
        </span>
      </label>
    );
  });

  return (
    <div className="lead-build li-polished">
      <section
        className="page-panel"
        onDragOver={(event) => {
          if (busy === '') {
            event.preventDefault();
            setDragging(true);
          }
        }}
        onDragLeave={(event) => {
          if (event.currentTarget === event.target) setDragging(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          if (busy !== '') return;
          void takeFile(event.dataTransfer.files?.[0] ?? null);
        }}
      >
        <div className="section-heading">
          <div>
            <h3 aria-level={2}>
              <Users size={18} className="li-heading-icon" /> Add leads from a CSV
            </h3>
            <p>
              Import a CSV you are authorized to use, such as LinkedIn’s own connections export or a
              list exported from another tool, or paste LinkedIn profile URLs. Review before
              importing. No scraping or contact action happens on upload.
            </p>
          </div>
        </div>

        {error && <div className="error-banner">{error}</div>}

        <details
          className="mgr-advanced"
          open={pasteOpen}
          onToggle={(event) => setPasteOpen(event.currentTarget.open)}
        >
          <summary>Paste LinkedIn profile URLs instead</summary>
          <p className="li-hint">
            One /in/ profile per line, or separated by commas — up to 10,000 different profiles per
            paste. Search, company, post and Sales Navigator links are rejected with the reason.
            Imported profiles enter the identity-review queue and cannot join a campaign until you
            complete first name, last name and company in Lead lists.
          </p>
          <Field label="LinkedIn profile URLs">
            <Textarea
              ref={pasteRef}
              rows={5}
              value={profileUrls}
              disabled={busy !== ''}
              placeholder={
                'https://www.linkedin.com/in/ada-lovelace/\nhttps://www.linkedin.com/in/grace-hopper/'
              }
              onChange={(event) => {
                setProfileUrls(event.target.value);
                setPasteError('');
              }}
            />
          </Field>
          {pasteError && <div className="error-banner">{pasteError}</div>}
          {currentPasteCheck && (
            <div className="lead-section" role="status">
              <p className="li-hint">
                {pluralGrouped(currentPasteCheck.acceptedCount, 'profile')} ready to add
                {currentPasteCheck.duplicates > 0
                  ? `, ${pluralGrouped(currentPasteCheck.duplicates, 'repeat')} counted once`
                  : ''}
                {currentPasteCheck.rejectedCount > 0
                  ? `, ${pluralGrouped(currentPasteCheck.rejectedCount, 'entry', 'entries')} rejected and skipped.`
                  : '.'}
              </p>
              {currentPasteCheck.rejectedCount > 0 && (
                <div className="li-table-scroll">
                  <table className="li-table lead-rejects">
                    <thead>
                      <tr>
                        <th>Line</th>
                        <th>Entry</th>
                        <th>Why</th>
                      </tr>
                    </thead>
                    <tbody>
                      {currentPasteCheck.rejected
                        .slice(0, PASTE_REJECTIONS_SHOWN)
                        .map((entry, index) => (
                          <tr key={`${entry.line}:${index}`}>
                            <td className="li-num">{entry.line}</td>
                            <td>{entry.value}</td>
                            <td>{entry.reason}</td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              )}
              {currentPasteCheck.rejectedCount > PASTE_REJECTIONS_SHOWN && (
                <p className="li-hint">
                  {pluralGrouped(
                    currentPasteCheck.rejectedCount - PASTE_REJECTIONS_SHOWN,
                    'other entry',
                    'other entries'
                  )}{' '}
                  rejected as well.
                </p>
              )}
            </div>
          )}
          <Button
            disabled={
              busy !== '' ||
              !profileUrls.trim() ||
              (currentPasteCheck !== null && currentPasteCheck.acceptedCount === 0)
            }
            onClick={() => void runProfileUrlImport()}
          >
            {busy === 'import' || busy === 'check' ? (
              <LoaderCircle className="spin" size={14} aria-hidden="true" />
            ) : (
              <Users size={14} aria-hidden="true" />
            )}
            {pasteButtonLabel}
          </Button>
        </details>

        <div className="li-form-grid">
          {!compact && (
            <label>
              Add these leads to
              <Select
                value={destination}
                disabled={busy !== ''}
                onChange={(event) => setDestination(event.target.value)}
              >
                <option value="new">A new list…</option>
                {lists.map((list) => (
                  <option key={list.id} value={list.id}>
                    {list.name} · {pluralGrouped(list.leadCount, 'lead')}
                  </option>
                ))}
              </Select>
            </label>
          )}
          {(compact || destination === 'new') && (
            <label>
              Name the new list
              <input
                value={newName}
                disabled={busy !== ''}
                placeholder="Q3 founders"
                onChange={(event) => setNewName(event.target.value)}
              />
            </label>
          )}
        </div>

        <div className={dragging ? 'lead-drop is-dragging' : 'lead-drop'}>
          <FileUp size={20} />
          <div className="lead-drop-copy">
            <strong>{file ? file.name : 'Drop a CSV here'}</strong>
            <p>
              {file
                ? `${formatSize(file.size)}${preview ? ` · ${pluralGrouped(preview.acceptedCount, 'usable row')}` : busy === 'preview' ? ' · reading it…' : ''}`
                : 'Or choose one below. Up to 2 MB, .csv only — a file dropped here is read, not stored.'}
            </p>
          </div>
          <Button
            ref={chooseFileRef}
            disabled={busy !== ''}
            onClick={() => fileInputRef.current?.click()}
          >
            {busy === 'preview' ? (
              <LoaderCircle className="spin" size={14} aria-hidden="true" />
            ) : (
              <FileUp size={14} aria-hidden="true" />
            )}
            {file ? ' Choose another file' : ' Choose a CSV'}
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,text/csv"
            hidden
            tabIndex={-1}
            aria-hidden="true"
            disabled={busy !== ''}
            onChange={(event) => {
              void takeFile(event.target.files?.[0] ?? null);
              event.target.value = '';
            }}
          />
        </div>

        {file && headers.length > 0 && (
          <div className="lead-section">
            <Field
              label="CSV format"
              hint={
                preset
                  ? `${leadCsvPreset(preset)?.hint ?? ''} The preset only fills in the columns below; change any of them.`
                  : 'Pick the format the file came from to fill in its columns, or map them yourself below. Nothing here connects to LinkedIn.'
              }
            >
              <Select
                value={preset}
                disabled={busy !== ''}
                onChange={(event) => changePreset(event.target.value)}
              >
                <option value="">No preset — match by heading</option>
                {LEAD_CSV_PRESETS.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.label}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        )}
        {file &&
          headers.length > 0 &&
          (missingRequired.length > 0 || preset !== '' ? (
            <div className="lead-section">
              <h4>Which column is which</h4>
              <p className="li-hint">
                Matched from your headings. Change any of them and the rows below are read again.
                Company is required, plus either Full name or separate first and last name columns.
                Rows with insufficient names remain excluded from import.
              </p>
              <div className="li-form-grid lead-map-grid">{mappingRows}</div>
            </div>
          ) : (
            // PROGRESSIVE DISCLOSURE: automatch already resolved every required
            // field, so the grid that used to be the loudest thing on a
            // successful drop is closed by default -- still one click away to
            // review or correct a guess, never a permanent fixture.
            <details className="lead-section">
              <summary>
                Which column is which{' '}
                <span className="li-hint">
                  — every required field matched automatically. Open to review or change it.
                </span>
              </summary>
              <div className="li-form-grid lead-map-grid">{mappingRows}</div>
            </details>
          ))}

        {file && missingRequired.length > 0 && (
          <div className="li-warn-block">
            <CircleAlert size={15} />
            <div>
              <strong>
                {missingRequired.length === 1
                  ? 'One column is still unanswered'
                  : `${missingRequired.length} columns are still unanswered`}
              </strong>
              <ul>
                {missingRequired.map((entry) => (
                  <li key={entry.field}>
                    Point <b>{entry.label}</b> at the column that holds it.
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}

        {scrubExamples.length > 0 && (
          <div className="lead-section">
            <h4>What the names will look like</h4>
            <p className="li-hint">
              Titles and qualifications — Dr, Prof, Mrs, PhD, MBA, MSc, CEO, LION and the rest of
              the usual list — along with emoji and stray punctuation, are removed before a lead is
              stored, so a message that opens with a first name opens with a name.
            </p>
            <ul className="lead-scrub-list">
              {scrubExamples.map((example, index) => (
                <li key={`${example.before}:${index}`}>
                  <span
                    className={example.changed ? 'lead-scrub-raw is-changed' : 'lead-scrub-raw'}
                  >
                    {example.before}
                  </span>
                  <ArrowRight size={13} />
                  <strong>{example.after}</strong>
                  {!example.changed && <em>unchanged</em>}
                </li>
              ))}
            </ul>
          </div>
        )}

        {preview && preview.rejectedCount > 0 && (
          <div className="lead-section">
            <h4>{pluralGrouped(preview.rejectedCount, 'row')} will not be imported</h4>
            <p className="li-hint">
              Fix them in the file and drop it again, or import the rest and leave them. Row numbers
              count the heading as row 1.
            </p>
            <div className="li-table-scroll">
              <table className="li-table lead-rejects">
                <thead>
                  <tr>
                    <th>Row</th>
                    <th>Why</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.rejected.slice(0, 8).map((entry) => (
                    <tr key={entry.row}>
                      <td className="li-num">{entry.row}</td>
                      <td>{entry.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {preview.rejectedCount > 8 && (
              <p className="li-hint">
                {pluralGrouped(preview.rejectedCount - 8, 'other row')} for the same kinds of
                reason.
              </p>
            )}
          </div>
        )}

        <div className="panel-footer">
          <span title={blocker || undefined}>
            {blocker ||
              (preview
                ? `${pluralGrouped(preview.acceptedCount, 'lead')} ready for ${destination === 'new' ? (newName.trim() ? `“${newName.trim()}”` : 'a new list') : `“${destinationList?.name ?? 'this list'}”`}.`
                : 'Reading a file changes nothing. Importing writes the leads and contacts nobody.')}
          </span>
          <button
            className="primary-button"
            type="button"
            disabled={!canImport}
            title={blocker || undefined}
            onClick={() => void runImport()}
          >
            {busy === 'import' ? <LoaderCircle className="spin" size={14} /> : <Upload size={14} />}
            {preview ? ` Import ${pluralGrouped(preview.acceptedCount, 'lead')}` : ' Import'}
          </button>
        </div>

        {report && (
          <div className="lead-report" role="status">
            <strong>
              <Check size={15} /> “{report.listName}” updated
            </strong>
            <ul className="lead-counts">
              <li>
                <strong>{report.counts.inserted.toLocaleString()}</strong> added
              </li>
              <li>
                <strong>
                  {Math.max(
                    0,
                    report.counts.duplicates - (report.counts.reused ?? 0)
                  ).toLocaleString()}
                </strong>{' '}
                already in this list
              </li>
              <li>
                <strong>{(report.counts.reused ?? 0).toLocaleString()}</strong> already yours in
                another list
              </li>
              <li>
                <strong>{report.counts.rejected.length.toLocaleString()}</strong> rejected
              </li>
            </ul>
            <p className="li-hint">
              Somebody who was already in another list keeps their single record rather than being
              copied — one person is one lead, so a campaign cannot reach them twice.
            </p>
            <div className="mgr-actions">
              <button
                className="secondary-button"
                type="button"
                onClick={() => void openList(report.listId)}
              >
                <Users size={14} /> See the leads in this list
              </button>
            </div>
          </div>
        )}

        {!compact && showSourceGuide && (
          <div className="lead-kinds">
            <h4>Where lead lists come from</h4>
            <dl>
              <div>
                <dt>{SOURCE_LABELS.csv}</dt>
                <dd>
                  A file you are allowed to use: LinkedIn’s own connections export, or a list
                  exported from another tool. Pick its format above to fill in the columns.
                </dd>
              </div>
              <div>
                <dt>{SOURCE_LABELS.profile_urls}</dt>
                <dd>Paste /in/ profile links you already have, one per line.</dd>
              </div>
              <div>
                <dt>Search, Sales Navigator and post engagers</dt>
                <dd>
                  Not supported. Collecting them means scraping LinkedIn, which breaks its terms and
                  puts your account at risk of restriction.
                </dd>
              </div>
            </dl>
            <a className="li-link" href="/outreach?focus=leads">
              Why these sources are not supported <ArrowRight size={13} aria-hidden="true" />
            </a>
          </div>
        )}
      </section>

      {!compact && (
        <section className="page-panel">
          <div className="section-heading">
            <div>
              <h3 aria-level={2}>Leads in a list</h3>
              <p>
                Review pasted URLs, complete missing identity, edit existing leads and manage
                exclusions. Incomplete identities cannot be admitted to campaigns; saving the
                required fields rechecks campaign eligibility.
              </p>
            </div>
            <button
              className="ghost-button"
              type="button"
              disabled={contactsLoading || listsLoading}
              onClick={() =>
                void (async () => {
                  await loadLists();
                  await openList(openListId);
                })()
              }
            >
              {contactsLoading || listsLoading ? (
                <LoaderCircle className="spin" size={14} />
              ) : (
                <RefreshCw size={14} />
              )}{' '}
              Refresh
            </button>
          </div>

          {listError && <div className="error-banner">{listError}</div>}

          {!listsLoading && lists.length === 0 ? (
            <div className="mgr-empty">
              <h4 aria-level={3}>No lead list yet</h4>
              <p>
                Import a CSV or paste LinkedIn profile URLs above. A campaign enrols from a list —
                until one has leads in it, there is nobody to reach.
              </p>
            </div>
          ) : (
            <>
              <div className="li-filter-row">
                <label>
                  List
                  <Select
                    value={openListId}
                    disabled={contactsLoading}
                    onChange={(event) => void openList(event.target.value)}
                  >
                    {lists.map((list) => (
                      <option key={list.id} value={list.id}>
                        {list.name} · {pluralGrouped(list.leadCount, 'lead')}
                      </option>
                    ))}
                  </Select>
                </label>
                <label>
                  Find someone
                  <input
                    value={filter}
                    maxLength={200}
                    placeholder="Name, company, email or profile URL"
                    onChange={(event) => {
                      setFilter(event.target.value);
                      setVisible(PAGE);
                    }}
                  />
                </label>
                <label className="li-check-row">
                  <input
                    type="checkbox"
                    checked={needsIdentityOnly}
                    onChange={(event) => {
                      setNeedsIdentityOnly(event.target.checked);
                      setVisible(PAGE);
                    }}
                  />
                  Needs identity review ({identityReviewCount.toLocaleString()})
                </label>
                {openMeta && (
                  <span className="li-chip">From {SOURCE_LABELS[openMeta.sourceKind]}</span>
                )}
                {openMeta && isOwner && !renamingList && (
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={renameBusy || contactsLoading}
                    onClick={() => {
                      setRenameName(openMeta.name);
                      setRenamingList(true);
                    }}
                  >
                    <Pencil size={14} /> Rename list
                  </button>
                )}
              </div>

              {renamingList && openMeta && (
                <form
                  className="li-filter-row"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (!renameName.trim()) return;
                    setRenameBusy(true);
                    setListError('');
                    void (async () => {
                      try {
                        const updated = await renameLinkedInManagerLeadList(
                          openMeta.id,
                          renameName
                        );
                        await loadLists();
                        await onChanged();
                        setToast(
                          `Lead list renamed to “${updated.name}”. Membership and campaigns are unchanged.`
                        );
                        setRenamingList(false);
                      } catch (error) {
                        setListError(errorMessage(error, 'Could not rename this lead list.'));
                      } finally {
                        setRenameBusy(false);
                      }
                    })();
                  }}
                >
                  <label>
                    New list name
                    <input
                      value={renameName}
                      maxLength={200}
                      required
                      onChange={(event) => setRenameName(event.target.value)}
                    />
                  </label>
                  <button
                    className="primary-button"
                    type="submit"
                    disabled={renameBusy || !renameName.trim()}
                  >
                    Save name
                  </button>
                  <button
                    className="ghost-button"
                    type="button"
                    disabled={renameBusy}
                    onClick={() => setRenamingList(false)}
                  >
                    Cancel
                  </button>
                </form>
              )}
              {contactsLoading ? (
                <p className="empty-copy">Searching this list…</p>
              ) : contacts.length === 0 ? (
                <p className="empty-copy">
                  {listTotal === 0
                    ? 'Nothing in this list yet. Import a CSV above and it fills up.'
                    : `No leads match ${filter.trim() ? `“${filter.trim()}”` : 'this review filter'} in this list.`}
                </p>
              ) : (
                <>
                  <p className="li-hint" role="status">
                    {pluralGrouped(contactTotal, 'matching lead')} in “
                    {openMeta?.name ?? 'this list'}”
                    {listTotal !== contactTotal
                      ? ` (of ${pluralGrouped(listTotal, 'lead')} total)`
                      : ''}
                    .
                    {contactTotal > contacts.length &&
                      ` ${contacts.length.toLocaleString()} matching leads loaded; load later pages to review the rest.`}
                  </p>
                  {identityReviewCount > 0 && (
                    <p className="li-hint">
                      {pluralGrouped(identityReviewCount, 'profile')} need first name, last name and
                      company confirmed before campaign admission across the entire list.
                    </p>
                  )}
                  {draft && (
                    <div className="lead-editor" ref={editorRef}>
                      <h4>
                        {contacts.find(
                          (contact) => contact.id === draft.id && needsIdentity(contact)
                        )
                          ? 'Complete profile identity'
                          : 'Edit lead identity'}
                      </h4>
                      <div className="li-form-grid lead-edit-grid">
                        <label>
                          First name
                          <input
                            value={draft.firstName}
                            onChange={(event) =>
                              setDraft({ ...draft, firstName: event.target.value })
                            }
                          />
                        </label>
                        <label>
                          Last name
                          <input
                            value={draft.lastName}
                            onChange={(event) =>
                              setDraft({ ...draft, lastName: event.target.value })
                            }
                          />
                        </label>
                        <label>
                          Company
                          <input
                            value={draft.company}
                            onChange={(event) =>
                              setDraft({ ...draft, company: event.target.value })
                            }
                          />
                        </label>
                        <label>
                          Email
                          <input
                            value={draft.email}
                            onChange={(event) => setDraft({ ...draft, email: event.target.value })}
                          />
                        </label>
                        <label>
                          Phone
                          <input
                            value={draft.phone}
                            onChange={(event) => setDraft({ ...draft, phone: event.target.value })}
                          />
                        </label>
                        <label>
                          Country
                          <input
                            value={draft.country}
                            onChange={(event) =>
                              setDraft({ ...draft, country: event.target.value })
                            }
                          />
                        </label>
                        <label className="li-span-2">
                          LinkedIn profile URL
                          <input
                            value={draft.profileUrl}
                            placeholder="https://www.linkedin.com/in/…"
                            onChange={(event) =>
                              setDraft({ ...draft, profileUrl: event.target.value })
                            }
                          />
                        </label>
                        <label className="li-span-2 li-check-row">
                          <input
                            type="checkbox"
                            checked={draft.doNotContact}
                            onChange={(event) =>
                              setDraft({ ...draft, doNotContact: event.target.checked })
                            }
                          />
                          Do not contact — exclude this person from every new campaign in this
                          workspace
                        </label>
                      </div>
                      <p className="li-hint">
                        Confirm names and company from an authorized source. Trevra never infers
                        them from the LinkedIn URL. After saving, pending campaign eligibility is
                        rechecked with all workspace exclusions and policies.
                      </p>
                      <div className="mgr-actions">
                        <button
                          className="primary-button"
                          type="button"
                          disabled={!draftValid || rowBusy !== ''}
                          onClick={() => void saveContact()}
                        >
                          {rowBusy === draft.id ? (
                            <LoaderCircle className="spin" size={14} />
                          ) : (
                            <Check size={14} />
                          )}{' '}
                          Save this lead
                        </button>
                        <button
                          className="secondary-button"
                          type="button"
                          disabled={rowBusy !== ''}
                          onClick={() => setDraft(null)}
                        >
                          <X size={14} /> Cancel
                        </button>
                      </div>
                    </div>
                  )}

                  {/*
                  THE CONSEQUENCES ARE READ BEFORE THE PRESS, NOT AFTER IT.

                  The second press used to be two words in a table cell and the
                  cascade was described in a toast that had it backwards. It is
                  out of the row for the same reason the editor is: a decision
                  taken inside a sideways-scrolling table is a decision a phone
                  cannot reach, and this one is not reversible.
                */}
                  {armedContact && (
                    <div className="li-warn-block" ref={confirmRef}>
                      <CircleAlert size={15} />
                      <div>
                        <strong>
                          Remove {armedContact.firstName} {armedContact.lastName} for good?
                        </strong>
                        <p>
                          This deletes the lead, not just their line in “
                          {openMeta?.name ?? 'this list'}”. Their place in every campaign they are
                          enrolled in goes with them, and so does any message a campaign was waiting
                          on you to write for them — both hang off this record and are removed with
                          it. What Trevra has already sent them stays in the ledger; nothing is
                          unsent.
                        </p>
                        <div className="mgr-actions">
                          <button
                            className="secondary-button"
                            type="button"
                            disabled={rowBusy !== ''}
                            onClick={() => setArmed('')}
                          >
                            <X size={14} /> Keep them
                          </button>
                          <button
                            className="li-mini-button li-mini-danger"
                            type="button"
                            disabled={rowBusy !== ''}
                            onClick={() => void removeContact(armedContact)}
                          >
                            {rowBusy === armedContact.id ? (
                              <LoaderCircle className="spin" size={14} />
                            ) : (
                              <Trash2 size={14} />
                            )}{' '}
                            Remove for good
                          </button>
                        </div>
                      </div>
                    </div>
                  )}

                  {crmSync && contacts.some((contact) => contact.id === crmSync.id) && (
                    <div ref={crmSyncRef}>
                      <CrmContactSync
                        leadContactId={crmSync.id}
                        leadName={crmSync.name}
                        onClose={() => setCrmSync(null)}
                      />
                    </div>
                  )}

                  <div className="li-table-scroll">
                    <table className="li-table lead-contacts">
                      <thead>
                        <tr>
                          <th>Name</th>
                          <th>Company</th>
                          <th>Email</th>
                          <th>Phone</th>
                          <th>Country</th>
                          <th>LinkedIn</th>
                          <th>
                            <span className="mgr-sr">Actions</span>
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {shown.map((contact) => {
                          const editing = draft?.id === contact.id;
                          return (
                            <tr
                              key={contact.id}
                              className={editing ? 'lead-row-editing' : undefined}
                            >
                              <td>
                                {needsIdentity(contact) ? (
                                  <button
                                    type="button"
                                    className="secondary-button"
                                    disabled={rowBusy !== ''}
                                    onClick={() => startEdit(contact)}
                                  >
                                    Complete identity
                                  </button>
                                ) : (
                                  <strong>
                                    {contact.firstName} {contact.lastName}
                                  </strong>
                                )}
                              </td>
                              <td>{contact.company || '—'}</td>
                              <td>{contact.email || '—'}</td>
                              <td>{contact.phone || '—'}</td>
                              <td>{contact.country || '—'}</td>
                              <td>
                                {contact.profileUrl ? (
                                  <a
                                    className="li-link"
                                    href={contact.profileUrl}
                                    target="_blank"
                                    rel="noreferrer"
                                  >
                                    Profile
                                  </a>
                                ) : (
                                  '—'
                                )}
                              </td>
                              <td>
                                <div className="li-row-actions">
                                  {armed === contact.id ? (
                                    <span className="li-hint">Confirm above</span>
                                  ) : (
                                    <ActionMenu
                                      compact
                                      label={`More actions for ${contact.firstName} ${contact.lastName}`}
                                      items={[
                                        {
                                          label: 'Edit lead',
                                          icon: <Pencil size={12} />,
                                          disabled: rowBusy !== '' || editing,
                                          onSelect: () => startEdit(contact)
                                        },
                                        {
                                          label: 'Sync to CRM',
                                          icon: <RefreshCw size={12} />,
                                          disabled: rowBusy !== '',
                                          onSelect: () => {
                                            setDraft(null);
                                            setArmed('');
                                            setCrmSync({
                                              id: contact.id,
                                              name: `${contact.firstName} ${contact.lastName}`.trim()
                                            });
                                            requestAnimationFrame(() =>
                                              crmSyncRef.current?.scrollIntoView({
                                                block: 'nearest'
                                              })
                                            );
                                          }
                                        },
                                        {
                                          label: 'Remove lead permanently',
                                          icon: <Trash2 size={12} />,
                                          disabled: rowBusy !== '',
                                          danger: true,
                                          onSelect: () => {
                                            setDraft(null);
                                            setArmed(contact.id);
                                            requestAnimationFrame(() =>
                                              confirmRef.current?.scrollIntoView({
                                                block: 'nearest'
                                              })
                                            );
                                          }
                                        }
                                      ]}
                                    />
                                  )}
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  {filtered.length > shown.length && (
                    <div className="mgr-actions">
                      <button
                        className="secondary-button"
                        type="button"
                        onClick={() => setVisible(visible + PAGE)}
                      >
                        Show {Math.min(PAGE, filtered.length - shown.length)} more
                      </button>
                    </div>
                  )}
                  {nextContactOffset < contactTotal && (
                    <div className="mgr-actions">
                      <button
                        className="secondary-button"
                        type="button"
                        disabled={contactsMoreLoading}
                        onClick={() => void loadMoreContacts()}
                      >
                        {contactsMoreLoading
                          ? 'Loading next page…'
                          : `Load next page (${pluralGrouped(contactTotal - nextContactOffset, 'lead')} remain)`}
                      </button>
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </section>
      )}
    </div>
  );
}
