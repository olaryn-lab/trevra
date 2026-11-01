import { useCallback, useEffect, useState } from 'react';
import {
  ArrowLeft,
  CircleAlert,
  ExternalLink,
  LoaderCircle,
  RefreshCw,
  Gauge,
  ListPlus,
  Users
} from 'lucide-react';
import {
  getLinkedInLeadAllowance,
  getLinkedInLeadSources,
  getLinkedInLeads,
  getLinkedInManagerLeadLists,
  importLinkedInLeadSource,
  setLinkedInLeadAllowance,
  type DailyLeadAllowance,
  type LeadSourceKind,
  type LeadSourceStatus,
  type LinkedInLead,
  type LinkedInLeadSource
} from './api';
import { useActiveSeatKey } from './LinkedInActiveAccount';
import { LinkedInManagerLeadConfig, type LeadIntakeRequest } from './LinkedInManagerLeadConfig';
import { UnsupportedIntakeSources } from './LeadIntakeSources';
import { errorMessage, reloadOutreach, stageTargets, useOutreachRefresh } from './LinkedInSafety';
import { relativeTime } from './LinkedInScreen';
import { formatVisitWindow, queueWaitCopy } from './LinkedInTiming';
import { unsupportedIntakeSourceFor } from '../shared/lead-intake';
import { navigate } from './ui/route';
import { plural } from './ui/plural';

/**
 * A fold on `/outreach` ("Find people").
 *
 * TREVRA DOES NOT SCRAPE LINKEDIN SEARCH, SALES NAVIGATOR OR POST ENGAGERS
 * (TRV-021/022/023). Reading other people's profiles out of a search page or
 * a post's reactions is scraping under LinkedIn's User Agreement, and it puts
 * the operator's account at risk. So this screen no longer offers to queue a
 * walk at all: it says plainly that those sources are not supported and why,
 * and puts the two honest ways in right underneath -- a CSV import (with
 * presets for LinkedIn's own connections export and generic list exports) and
 * a paste of profile URLs the operator already has. The server refuses the
 * old queue route with the stable code `intake_source_unsupported` either way.
 *
 * `?kind=` and `?url=` deep links (from Today's suggestions) still land here:
 * the requested source is named first in the explanation, and the URL is
 * offered as a plain link to open on LinkedIn -- never queued.
 *
 * THE SOURCES LIST STILL READS. A workspace with sources from before this
 * change must still be able to see what they found and save it to a list.
 */
const KIND_LABELS: Record<LeadSourceKind, string> = {
  search: 'People search',
  sales_navigator: 'Sales Navigator search',
  content: 'Post & comment keywords',
  post: 'One post’s engagement',
  recruiter: 'Recruiter candidates',
  group_members: 'Group members',
  event_attendees: 'Event attendees',
  company_employees: 'Company employees'
};

const INTERACTION_LABELS: Record<'post' | 'comment', string> = {
  post: 'Wrote the post',
  comment: 'Commented'
};

const STATUS_LABELS: Record<LeadSourceStatus, string> = {
  pending: 'Queued',
  running: 'Walking',
  completed: 'Done',
  failed: 'Failed'
};

/** `https://www.linkedin.com/in/pankaj-x/` -> `in/pankaj-x`. The URL still links. */
const shortUrl = (url: string) => {
  try {
    const parsed = new URL(url);
    const path = `${parsed.pathname}${parsed.search}`.replace(/\/+$/, '');
    return `${parsed.host}${path}`.slice(0, 90);
  } catch {
    return url.slice(0, 90);
  }
};

/**
 * HOW MANY OF A WALK'S PEOPLE ONE READ CAN SHOW, and it is not how many it
 * stored.
 *
 * `/lead-sources/:id/leads` clamps `limit` to 500 and takes no offset, so 500
 * rows is the whole of what this screen can put on a page. The number beside a
 * source is `result_count`, which the walk itself wrote -- a different fact,
 * and the true one. They were printed as though they were the same fact, so an
 * 800-person walk read "800 stored" over 500 rows, "select all" quietly meant
 * 500, and Save wrote all 800. Each of those three is now said in its own
 * words rather than left to be discovered.
 */
const LEAD_PAGE = 500;

/**
 * Is this lead list the one a previous save of this source created?
 *
 * The import stores the source's URL on the list as `source_ref`, so that is
 * what identifies it -- but the two strings travel through different
 * validators (`assertLeadSourceUrl` normalises through `URL`), and a trailing
 * slash is not a different search. Compared on the part that identifies the
 * page rather than byte for byte.
 */
const sameSourceUrl = (sourceRef: string | null, sourceUrl: string): boolean => {
  if (!sourceRef) return false;
  const normalize = (value: string) => {
    try {
      const parsed = new URL(value);
      return `${parsed.host.toLowerCase()}${parsed.pathname.replace(/\/+$/, '')}${parsed.search}`;
    } catch {
      return value.trim();
    }
  };
  return normalize(sourceRef) === normalize(sourceUrl);
};

interface LeadSourcePrefill {
  /** The source a deep link asked for, or null when the screen was opened plainly. */
  kind: LeadSourceKind | null;
  url: string;
}

function readLeadSourcePrefill(): LeadSourcePrefill {
  const fallback: LeadSourcePrefill = { kind: null, url: '' };
  if (typeof window === 'undefined') return fallback;
  const params = new URLSearchParams(window.location.search);
  const rawKind = params.get('kind') ?? '';
  if (!Object.prototype.hasOwnProperty.call(KIND_LABELS, rawKind)) return fallback;
  const kind = rawKind as LeadSourceKind;
  const rawUrl = params.get('url')?.trim() ?? '';
  if (!rawUrl) return { kind, url: '' };
  try {
    const parsed = new URL(rawUrl);
    if (
      parsed.protocol !== 'https:' ||
      !['linkedin.com', 'www.linkedin.com'].includes(parsed.hostname.toLowerCase())
    )
      return { kind, url: '' };
    return { kind, url: parsed.toString() };
  } catch {
    return { kind, url: '' };
  }
}

export function OutreachLeads({ setToast }: { setToast: (message: string) => void }) {
  const [activeSeatKey] = useActiveSeatKey();
  const [sources, setSources] = useState<LinkedInLeadSource[]>([]);
  const [enabled, setEnabled] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [prefill] = useState(readLeadSourcePrefill);
  /** Which import the explanation's buttons last asked the importer to bring forward. */
  const [intakeRequest, setIntakeRequest] = useState<LeadIntakeRequest | null>(null);
  const requestIntake = (mode: LeadIntakeRequest['mode']) =>
    setIntakeRequest((current) => ({ mode, seq: (current?.seq ?? 0) + 1 }));

  /** The source being drilled into. Null on the list. */
  const [openSource, setOpenSource] = useState<LinkedInLeadSource | null>(null);
  const [leads, setLeads] = useState<LinkedInLead[]>([]);
  const [leadsLoading, setLeadsLoading] = useState(false);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  /**
   * The lead list a previous save of THIS source went into, if there is one.
   *
   * The import route creates a list whenever it is handed no `listId`, so a
   * second press of Save built a SECOND list with the same auto-generated name
   * and nothing in it -- every person was already a contact, so every row
   * deduped away and the operator was left with two lists, one of them empty.
   * Matched on the URL the import stored as the list's `source_ref`, so a save
   * made last week is found as surely as one made a minute ago.
   */
  const [savedList, setSavedList] = useState<{ id: string; name: string } | null>(null);

  /** The daily ceiling on how many people this workspace will collect at all. */
  const [allowance, setAllowance] = useState<DailyLeadAllowance | null>(null);
  const [capDraft, setCapDraft] = useState('');
  const [savingCap, setSavingCap] = useState(false);
  const [importing, setImporting] = useState(false);
  /**
   * Is the daily-limit panel open, and is its own read in flight.
   *
   * Most operators never touch this setting, so `getLinkedInLeadAllowance` no
   * longer rides along with every load of this screen -- it fires the first
   * time the panel is opened (see the effect below), the same "collapsed,
   * fetched on demand" idiom as Campaign inputs on the manager read screen.
   */
  const [allowanceOpen, setAllowanceOpen] = useState(false);
  const [allowanceLoading, setAllowanceLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await getLinkedInLeadSources(200, activeSeatKey);
      setSources(result.sources);
      setEnabled(result.enabled);
      setError('');
    } catch (err) {
      setError(
        errorMessage(err, 'Unable to read the lead sources. Nothing was changed — try again.')
      );
    } finally {
      setLoading(false);
    }
  }, [activeSeatKey]);

  const loadAllowance = useCallback(async () => {
    setAllowanceLoading(true);
    try {
      const next = await getLinkedInLeadAllowance(activeSeatKey);
      setAllowance(next);
      setCapDraft(String(next.limit));
      setError('');
    } catch (err) {
      setError(errorMessage(err, 'Unable to read the daily lead limit.'));
    } finally {
      setAllowanceLoading(false);
    }
  }, [activeSeatKey]);

  useEffect(() => {
    setOpenSource(null);
    setLeads([]);
    setPicked(new Set());
    setSavedList(null);
    setAllowance(null);
    setCapDraft('');
    void load();
  }, [load]);
  useOutreachRefresh(load);

  // Fires on the panel's first open, and again if the seat changes while it
  // stays open -- `loadAllowance` is a fresh function identity either way.
  // While the panel is closed this effect does nothing, so switching seats
  // with it closed costs no read at all.
  useEffect(() => {
    if (!allowanceOpen) return;
    void loadAllowance();
  }, [allowanceOpen, loadAllowance]);

  // Pending/running sources are live queue rows. Refresh them quietly so an
  // ETA that was missed while the laptop slept advances on its own after wake,
  // and a completed walk appears without making the operator press Refresh.
  const hasLiveSources = sources.some(
    (source) => source.status === 'pending' || source.status === 'running'
  );
  useEffect(() => {
    if (!hasLiveSources) return;
    const timer = window.setInterval(() => {
      void getLinkedInLeadSources(200, activeSeatKey)
        .then((result) => {
          setSources(result.sources);
          setEnabled(result.enabled);
        })
        .catch(() => undefined);
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [hasLiveSources, activeSeatKey]);
  useOutreachRefresh(load);
  const openLeads = async (source: LinkedInLeadSource) => {
    setOpenSource(source);
    setLeads([]);
    setPicked(new Set());
    setSavedList(null);
    setLeadsLoading(true);
    try {
      const result = await getLinkedInLeads(source.id, LEAD_PAGE, activeSeatKey);
      setLeads(result.leads);
      if (result.source) setOpenSource(result.source);
      setError('');
    } catch (err) {
      setError(errorMessage(err, 'Unable to read the people this source found'));
    } finally {
      setLeadsLoading(false);
    }
    // Afterwards and on its own: which list a previous save went into is worth
    // knowing and is never worth failing the read of the people over. Without
    // it the button below says it will create a list -- which is then exactly
    // what it does, so a failure here costs honesty nothing.
    try {
      const existing = await getLinkedInManagerLeadLists(activeSeatKey);
      const match = existing.find((list) => sameSourceUrl(list.sourceRef, source.url));
      setSavedList(match ? { id: match.id, name: match.name } : null);
    } catch {
      /* the copy falls back to "a new list", which is what will then happen */
    }
  };

  const saveCap = async () => {
    const cap = Number(capDraft);
    if (!Number.isInteger(cap) || cap < 0 || cap > 100) {
      setError('The daily lead limit is a whole number between 0 and 100.');
      return;
    }
    setSavingCap(true);
    try {
      const next = await setLinkedInLeadAllowance(cap, activeSeatKey);
      setAllowance(next);
      setCapDraft(String(next.limit));
      setToast(
        cap === 0
          ? 'Daily lead limit set to 0. No walk will store anybody until you raise it.'
          : `Daily lead limit set to ${cap} new leads a day, counted over a rolling 24 hours.`
      );
      setError('');
    } catch (err) {
      setError(errorMessage(err, 'Unable to change the daily lead limit.'));
    } finally {
      setSavingCap(false);
    }
  };

  /**
   * Harvested rows become leads a campaign can actually enrol.
   *
   * Two different tables with two different jobs: a walk stores what it SAW,
   * and a lead list holds people a workflow may act on. This is the one step
   * between them, and it is explicit rather than automatic -- collecting is not
   * the same decision as contacting.
   */
  const importToList = async (source: LinkedInLeadSource) => {
    setImporting(true);
    try {
      // THE TICKED ROWS TRAVEL. A screen that offers checkboxes, counts them
      // beside the button and then imports the whole walk is worse than one
      // that offers no checkboxes at all -- five of five hundred meant five
      // hundred. Absent `leadIds` still means everybody, which is what the
      // button says when nothing is ticked.
      const chosen = leads.filter((lead) => picked.has(lead.profileUrl)).map((lead) => lead.id);
      const result = await importLinkedInLeadSource(source.id, {
        seatKey: activeSeatKey,
        // Naming the list a previous save created is what stops a second press
        // building a second one; without it the route creates.
        ...(savedList ? { listId: savedList.id } : {}),
        ...(chosen.length > 0 ? { leadIds: chosen } : {})
      });
      setSavedList({ id: result.list.id, name: result.list.name });
      // `skipped` is the importer's own count, and it skips on exactly two
      // things: a profile URL it cannot address, or no first name to open a
      // message with. It has never skipped anybody for a missing company --
      // post engagers rarely have one, and rejecting those would leave keyword
      // discovery unable to feed a campaign at all.
      setToast(
        `${plural(result.inserted, 'lead')} added to “${result.list.name}”${result.reused ? `, ${result.reused} already known` : ''}${result.skipped ? `, ${result.skipped} skipped for an unusable profile URL or no first name` : ''}. They can be enrolled in a campaign now.`
      );
      setError('');
    } catch (err) {
      setError(errorMessage(err, 'Unable to turn this source into a lead list.'));
    } finally {
      setImporting(false);
    }
  };

  const toggle = (profileUrl: string) =>
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(profileUrl)) next.delete(profileUrl);
      else next.add(profileUrl);
      return next;
    });

  const allPicked = leads.length > 0 && picked.size === leads.length;

  /**
   * Hand the picked people to the campaign builder.
   *
   * It STAGES them; it creates nothing. A campaign's targets are fixed when the
   * campaign is created, so this fills the field the operator is about to read
   * before they name the campaign — and they can still cut the list there.
   */
  const sendToBuilder = () => {
    const list = leads.filter((lead) => picked.has(lead.profileUrl)).map((lead) => lead.profileUrl);
    if (list.length === 0) return;
    stageTargets(list);
    setToast(
      `${plural(list.length, 'profile URL')} staged for the campaign builder. Nothing was created — they land in the targets field.`
    );
    navigate('/outreach/new');
  };

  return (
    <div className="page-stack">
      {error && <div className="error-banner">{error}</div>}

      {openSource ? (
        <LeadList
          source={openSource}
          leads={leads}
          loading={leadsLoading}
          picked={picked}
          allPicked={allPicked}
          savedList={savedList}
          onBack={() => {
            setOpenSource(null);
            setLeads([]);
            setPicked(new Set());
            setSavedList(null);
          }}
          onToggle={toggle}
          onToggleAll={() =>
            setPicked(allPicked ? new Set() : new Set(leads.map((lead) => lead.profileUrl)))
          }
          onSend={sendToBuilder}
          importing={importing}
          onImport={() => void importToList(openSource)}
        />
      ) : (
        <>
          {/* Not an error, and not styled as one: a deliberate posture, said in
            plain words, with the supported ways in directly underneath. */}
          <UnsupportedIntakeSources
            requested={prefill.kind ? unsupportedIntakeSourceFor(prefill.kind) : null}
            requestedUrl={prefill.url || undefined}
            onImportCsv={() => requestIntake('csv')}
            onPasteUrls={() => requestIntake('paste')}
          />

          <LinkedInManagerLeadConfig
            onChanged={reloadOutreach}
            setToast={setToast}
            showSourceGuide={false}
            intakeRequest={intakeRequest}
          />

          {/* The ceiling on collection itself, which is a different question from
            how deep any one walk goes: six walks in a morning each stopping at
            100 is 600 people nobody set out to collect.

            COLLAPSED BY DEFAULT, AND THE READ WAITS FOR THE OPEN. This used to
            render fully expanded with `getLinkedInLeadAllowance` fetched on
            every load of the screen, whether or not the operator ever touches
            a daily cap -- most don't. It is now a `<details>` behind a
            summary, reusing the manager read screen's "Campaign inputs" box
            styling, and the fetch (see `loadAllowance` above) only fires the
            first time it opens. */}
          <details
            className="mgr-inputs"
            open={allowanceOpen}
            onToggle={(event) => setAllowanceOpen(event.currentTarget.open)}
          >
            <summary>
              <Gauge size={14} /> Daily lead limit
            </summary>
            <div className="mgr-inputs-body">
              <section className="page-panel">
                <div className="section-heading">
                  <div>
                    <h3 aria-level={2}>How many new leads a day</h3>
                    <p>
                      Counted over a rolling 24 hours across every source. A walk that would pass
                      this limit stops early and says so instead of collecting anyway.
                    </p>
                  </div>
                  <Gauge size={20} className="li-heading-icon" />
                </div>
                {allowanceLoading && !allowance ? (
                  <p className="empty-copy">Reading today’s count…</p>
                ) : (
                  <>
                    <div className="li-form-grid">
                      <label>
                        Daily limit
                        <input
                          type="number"
                          min={0}
                          max={100}
                          value={capDraft}
                          // Off with everything else on this screen. A ceiling on
                          // collection is only a ceiling on something that can run, and
                          // an editable one where no walk is permitted implies a walk is.
                          disabled={!enabled}
                          onChange={(event) => setCapDraft(event.target.value)}
                        />
                        <small className="li-hint">0–100. Set 0 to collect nobody at all.</small>
                      </label>
                      {/* NOT ZERO WHEN IT IS UNKNOWN. A failed read of the allowance used
                        to print "Still allowed 0", which reads as a hard block that
                        does not exist and sends an operator looking for a limit to
                        raise. A number nobody read is not a number this screen has. */}
                      <div className="li-lead-cap-stats">
                        <div className="li-stat">
                          <p>Collected today</p>
                          <strong>
                            {allowance ? allowance.used : <span className="li-unknown">—</span>}
                          </strong>
                          <span>Rolling 24 hours</span>
                        </div>
                        <div className="li-stat li-stat-ok">
                          <p>Still allowed</p>
                          <strong>
                            {allowance ? (
                              allowance.remaining
                            ) : (
                              <span className="li-unknown">—</span>
                            )}
                          </strong>
                          <span>Before this daily cap</span>
                        </div>
                      </div>
                    </div>
                    {!allowance && !allowanceLoading && (
                      <p className="li-hint">
                        Today’s count could not be read, so neither number is shown. The limit
                        itself is unchanged and is still applied by the walk — Refresh below reads
                        it again.
                      </p>
                    )}
                    <div className="panel-footer">
                      {/* DISABLED CONTROLS EXPLAIN THEMSELVES. Each reason the Save button
                        below can be greyed out is named here, in order -- the same idiom
                        as the workflow builder's Save footer -- instead of a button that
                        just sits there. */}
                      <span>
                        {!enabled
                          ? 'Lead sourcing is switched off for this deployment, so the limit can’t be changed.'
                          : savingCap
                            ? 'Saving…'
                            : capDraft.trim() === ''
                              ? 'Type a number to set a new daily limit.'
                              : allowance !== null && capDraft === String(allowance.limit)
                                ? 'This is already the daily limit — change the number to save a different one.'
                                : 'Changing this affects the next walk. It never deletes anybody already collected.'}
                      </span>
                      {/* The old test compared the draft against `allowance?.limit ?? ''`,
                        so a failed read made it `'' === ''` and the button could never
                        be pressed again without a reload -- the one state in which the
                        operator most wants to set a number. Empty is the only draft
                        there is nothing to save from; a known limit still guards
                        against saving what is already stored. */}
                      <button
                        className="secondary-button"
                        type="button"
                        disabled={
                          !enabled ||
                          savingCap ||
                          capDraft.trim() === '' ||
                          (allowance !== null && capDraft === String(allowance.limit))
                        }
                        onClick={() => void saveCap()}
                      >
                        {savingCap ? (
                          <LoaderCircle className="spin" size={14} />
                        ) : (
                          <Gauge size={14} />
                        )}{' '}
                        Save limit
                      </button>
                    </div>
                  </>
                )}
              </section>
            </div>
          </details>

          <section className="page-panel">
            <div className="section-heading">
              <div>
                <h3 aria-level={2}>Sources</h3>
                <p>
                  Result counts are people <em>stored</em>, not people seen. Queued rows show the
                  next expected LinkedIn visit. If your computer or Trevra tab misses that window,
                  Trevra moves the work to the next normal visit — missed visits are never replayed
                  as a catch-up burst.
                </p>
              </div>
              <button
                className="secondary-button"
                type="button"
                disabled={loading}
                onClick={() => void load()}
              >
                {loading ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}{' '}
                Refresh
              </button>
            </div>

            {sources.length === 0 ? (
              <p className="empty-copy">
                No lead source has been recorded on this workspace. Import a CSV or paste profile
                URLs above to build a lead list.
              </p>
            ) : (
              <div className="li-source-list">
                {sources.map((source) => (
                  <button
                    key={source.id}
                    type="button"
                    className="li-source-row"
                    onClick={() => void openLeads(source)}
                  >
                    <span className="li-source-top">
                      <span className="li-chip">{KIND_LABELS[source.kind]}</span>
                      <span className={`li-chip li-lead-${source.status}`}>
                        {STATUS_LABELS[source.status] ?? source.status}
                      </span>
                      <span className="li-source-count">{source.resultCount ?? 0} stored</span>
                    </span>
                    <span className="li-source-url">{shortUrl(source.url)}</span>
                    <span className="li-source-meta">
                      Queued {relativeTime(source.requestedAt)}
                      {source.finishedAt && ` · finished ${relativeTime(source.finishedAt)}`}
                    </span>
                    {source.status === 'pending' && (
                      <span className="li-source-next-run">
                        {queueWaitCopy(source.waitingFor) ? (
                          <>
                            <strong>{queueWaitCopy(source.waitingFor)}</strong>
                            {formatVisitWindow(
                              source.nextRunAt,
                              source.nextRunWindowEndAt,
                              source.nextRunTimezone
                            )
                              ? ` · next normal visit ${formatVisitWindow(source.nextRunAt, source.nextRunWindowEndAt, source.nextRunTimezone)}`
                              : ''}
                          </>
                        ) : formatVisitWindow(
                            source.nextRunAt,
                            source.nextRunWindowEndAt,
                            source.nextRunTimezone
                          ) ? (
                          <>
                            Expected in LinkedIn visit ·{' '}
                            {formatVisitWindow(
                              source.nextRunAt,
                              source.nextRunWindowEndAt,
                              source.nextRunTimezone
                            )}
                          </>
                        ) : (
                          <>Waiting for the next eligible LinkedIn visit</>
                        )}
                      </span>
                    )}
                    {source.failureReason && (
                      <span className="li-source-failure">
                        <CircleAlert size={12} /> {source.failureReason}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}

/** The people one walk stored, and the one thing to do with them. */
function LeadList({
  source,
  leads,
  loading,
  picked,
  allPicked,
  importing,
  savedList,
  onBack,
  onToggle,
  onToggleAll,
  onSend,
  onImport
}: {
  source: LinkedInLeadSource;
  leads: LinkedInLead[];
  loading: boolean;
  picked: ReadonlySet<string>;
  allPicked: boolean;
  importing: boolean;
  /** The list a previous save of this source went into, so a repeat can name it. */
  savedList: { id: string; name: string } | null;
  onBack: () => void;
  onToggle: (profileUrl: string) => void;
  onToggleAll: () => void;
  onSend: () => void;
  onImport: () => void;
}) {
  const showsPosts = leads.some((lead) => lead.postUrl !== null || lead.interactionKind !== null);
  /**
   * TWO NUMBERS, AND THEY ARE NOT THE SAME NUMBER. `stored` is what the walk
   * wrote against the source; `leads.length` is what one read of it can put on
   * a page. Printing the first over rows that are the second is how "800
   * stored" came to sit above 500 rows, and every control below now names
   * whichever of the two it actually operates on.
   */
  const stored = source.resultCount ?? 0;
  const capped = leads.length >= LEAD_PAGE;
  const beyondPage = capped && stored > leads.length;
  return (
    <section className="page-panel">
      <div className="section-heading">
        <div>
          <h3 aria-level={2}>{plural(stored, 'person', 'people')} stored</h3>
          <p>
            <span className="li-chip">{KIND_LABELS[source.kind]}</span>{' '}
            <a className="li-link" href={source.url} target="_blank" rel="noreferrer">
              {shortUrl(source.url)} <ExternalLink size={11} />
            </a>
          </p>
        </div>
        <button className="ghost-button" type="button" onClick={onBack}>
          <ArrowLeft size={14} /> All sources
        </button>
      </div>

      {source.failureReason && (
        <div className="li-degraded">
          <strong>This walk stopped early.</strong>
          <p>{source.failureReason}</p>
        </div>
      )}

      {loading ? (
        <p className="empty-copy">
          <LoaderCircle className="spin" size={14} /> Reading the people this source found…
        </p>
      ) : leads.length === 0 ? (
        <div className="empty-state">
          <Users size={26} />
          <h4 aria-level={3}>Nobody was stored from this source</h4>
          <p>
            Either the walk has not run yet, or the page rendered nothing this worker could read.
            Nothing is invented to fill the gap.
          </p>
        </div>
      ) : (
        <>
          <div className="li-filter-row">
            <label className="li-inline-check">
              <input
                type="checkbox"
                checked={allPicked}
                onChange={onToggleAll}
                aria-label="Select every person listed here"
              />
              <span>
                {picked.size} of {leads.length} listed selected
                {beyondPage && ` · ${stored} stored in all`}
              </span>
            </label>
            <button
              className="secondary-button"
              type="button"
              disabled={picked.size === 0}
              onClick={onSend}
            >
              <Users size={14} /> Add {picked.size} to the campaign builder
            </button>
            {/* The button says what it will write, because it can now write two
                different things: the ticked rows, or the whole walk. */}
            <button
              className="primary-button"
              type="button"
              disabled={importing || leads.length === 0}
              onClick={onImport}
            >
              {importing ? <LoaderCircle className="spin" size={14} /> : <ListPlus size={14} />}
              {picked.size > 0
                ? ` Save the ${picked.size} selected as leads`
                : savedList
                  ? ` Add all ${stored || leads.length} to “${savedList.name}”`
                  : ` Save all ${stored || leads.length} as a lead list`}
            </button>
          </div>

          {beyondPage && (
            <p className="li-hint">
              This walk stored {stored} people and one read of the list returns at most {LEAD_PAGE},
              so {leads.length} are listed below. Ticking rows reaches those {leads.length}; saving
              with nothing ticked writes all {stored}.
            </p>
          )}

          <div className="li-table-scroll">
            <table className="li-table">
              <thead>
                <tr>
                  <th />
                  <th>Name</th>
                  <th>Headline</th>
                  <th>Company</th>
                  {showsPosts && (
                    <>
                      <th>Found on</th>
                      <th>How</th>
                    </>
                  )}
                  <th>Profile</th>
                </tr>
              </thead>
              <tbody>
                {leads.map((lead) => (
                  <tr key={lead.id}>
                    <td>
                      <input
                        type="checkbox"
                        checked={picked.has(lead.profileUrl)}
                        onChange={() => onToggle(lead.profileUrl)}
                        aria-label={`Select ${lead.name ?? lead.profileUrl}`}
                      />
                    </td>
                    <td>{lead.name ?? <span className="li-unknown">Unknown</span>}</td>
                    <td>{lead.headline ?? <span className="li-unknown">Unknown</span>}</td>
                    {/* NOT "Unknown", WHICH READS AS "WE LOOKED AND COULD NOT TELL".
                    A post or comment card carries no company field at all, so
                    for everybody found that way this was never read rather than
                    read and missing. An empty cell says the true thing; the
                    note under the table says which. */}
                    <td>{lead.company ?? <span className="li-unknown">—</span>}</td>
                    {showsPosts && (
                      <>
                        <td>
                          {lead.postUrl ? (
                            <a
                              className="li-link"
                              href={lead.postUrl}
                              target="_blank"
                              rel="noreferrer"
                            >
                              the post <ExternalLink size={11} />
                            </a>
                          ) : (
                            <span className="li-unknown">—</span>
                          )}
                        </td>
                        <td>
                          {lead.interactionKind ? (
                            <span className="li-chip">
                              {INTERACTION_LABELS[lead.interactionKind]}
                            </span>
                          ) : (
                            <span className="li-unknown">—</span>
                          )}
                        </td>
                      </>
                    )}
                    <td className="li-target">
                      <a
                        className="li-link"
                        href={lead.profileUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {lead.profileUrl}
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="li-hint">
            A dash is a field the page did not render for that person — left empty rather than
            filled in. A company is the usual one: a post or a comment card does not carry one, so
            people found that way have none to read.
          </p>

          <div className="panel-footer">
            <span>
              Adding stages the selected profile URLs in the campaign builder’s targets field. It
              creates no campaign and schedules nothing; the exclusion list is applied where the
              plan is produced, so anyone who asked to be left alone is dropped before a payload
              exists.{' '}
              {picked.size > 0 ? (
                <>
                  Saving writes <b>the {picked.size} you ticked</b> and nobody else.
                </>
              ) : (
                <>
                  With nothing ticked, saving writes <b>everybody this walk stored</b>.
                </>
              )}{' '}
              {savedList ? (
                <>
                  They go into <b>“{savedList.name}”</b>, the list this source was saved to before —
                  somebody already in it is not added a second time.
                </>
              ) : (
                <>
                  They go into a new list for this source. Saving again afterwards adds to that same
                  list rather than building another.
                </>
              )}
            </span>
          </div>
        </>
      )}
    </section>
  );
}
