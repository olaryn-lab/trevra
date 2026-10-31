import { BarChart3, Download, LoaderCircle, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ManagedCampaign } from '../server/linkedin/managed-campaigns';
import { NOT_ENOUGH_DATA, RATE_MIN_SAMPLE, ratePercent } from './analytics';
import {
  downloadLinkedInCampaignStatsCsv,
  downloadLinkedInDailyStatsCsv,
  downloadLinkedInTeamStatsCsv,
  getLinkedInManagedCampaigns,
  getLinkedInManagerSeats,
  getLinkedInReport,
  type CsvDownload,
  type LinkedInReportQuery,
  type LinkedInSeat,
  type RepMetrics,
  type RepReport,
  type ReportPreset
} from './api';
import { errorMessage } from './LinkedInSafety';
import { LiStat } from './LinkedInViz';
import { Button, Field, Input, Select } from './ui/primitives';
import './linkedin-reports.css';

/**
 * `/outreach/analytics`: per-campaign, daily and per-rep outreach numbers for
 * one date range (TRV-046), and the CSV exports of each (TRV-049).
 *
 * Every table here is a cut of ONE server read (`GET /api/linkedin/manager/
 * reports`), and every export is the same query with a different grouping, so
 * a downloaded file cannot disagree with the table it was downloaded from.
 * Exports are asked for with the range the server RESOLVED (`report.range`),
 * not the preset, so a file pulled just after midnight still covers the days on
 * screen. Who a number belongs to is decided on the server -- the rule is in
 * `src/server/linkedin/rep-reporting.ts` and repeated in the help text below.
 */

type RangeChoice = ReportPreset | 'custom';
type View = 'campaigns' | 'daily' | 'team';

const RANGE_CHOICES: ReadonlyArray<{ value: RangeChoice; label: string }> = [
  { value: 'today', label: 'Today' },
  { value: 'yesterday', label: 'Yesterday' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: '90d', label: '90 days' },
  { value: 'custom', label: 'Custom' }
];

const VIEWS: ReadonlyArray<{ value: View; label: string }> = [
  { value: 'campaigns', label: 'Campaigns' },
  { value: 'daily', label: 'Daily' },
  { value: 'team', label: 'Team' }
];

const count = (value: number) => value.toLocaleString('en-US');

/** The metric columns every breakdown shares, in the order the CSV writes them. */
const COLUMNS: ReadonlyArray<{ label: string; cell: (metrics: RepMetrics) => string }> = [
  { label: 'Invites', cell: (m) => count(m.invitesSent) },
  { label: 'Accepted', cell: (m) => count(m.invitesAccepted) },
  { label: 'Acceptance', cell: (m) => ratePercent(m.invitesAccepted, m.invitesSent) },
  { label: 'Messages', cell: (m) => count(m.messagesSent) },
  { label: 'InMails', cell: (m) => count(m.inmailsSent) },
  { label: 'Emails', cell: (m) => count(m.emailsSent) },
  { label: 'Bounces', cell: (m) => count(m.emailsBounced) },
  { label: 'Replies', cell: (m) => count(m.replies) },
  { label: 'Reply rate', cell: (m) => ratePercent(m.repliedAfterMessage, m.messagedLeads) },
  { label: 'Follows', cell: (m) => count(m.follows) },
  { label: 'Likes', cell: (m) => count(m.likes) },
  { label: 'Endorsements', cell: (m) => count(m.endorsements) },
  { label: 'Profile views', cell: (m) => count(m.profileViews) }
];

/** A local calendar date moved by whole days, or null when it is not one. */
function shiftDate(date: string, days: number): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return null;
  const at = new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) + days * 86_400_000
  );
  return Number.isNaN(at.getTime()) ? null : at.toISOString().slice(0, 10);
}

function longDate(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString('en-US', {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  });
}

/** The range the numbers were counted over, read from the response rather than from the request. */
function rangeSentence(report: RepReport): string {
  const last = shiftDate(report.range.to, -1) ?? report.range.to;
  const span =
    report.range.days === 1
      ? longDate(report.range.from)
      : `${longDate(report.range.from)} through ${longDate(last)}`;
  return `${span} (${report.range.days} ${report.range.days === 1 ? 'day' : 'days'}), cut at midnight ${report.range.timezone}.`;
}

function saveFile(file: CsvDownload): void {
  const href = URL.createObjectURL(file.blob);
  const link = document.createElement('a');
  link.href = href;
  link.download = file.filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(href);
}

function MetricHead({ first, trailing }: { first: string; trailing?: string }) {
  return (
    <thead>
      <tr>
        <th scope="col">{first}</th>
        {COLUMNS.map((column) => (
          <th key={column.label} scope="col" className="li-num">
            {column.label}
          </th>
        ))}
        {trailing !== undefined && (
          <th scope="col">
            <span className="mgr-sr">{trailing}</span>
          </th>
        )}
      </tr>
    </thead>
  );
}

function MetricCells({ metrics }: { metrics: RepMetrics }) {
  return (
    <>
      {COLUMNS.map((column) => (
        <td key={column.label} className="li-num">
          {column.cell(metrics)}
        </td>
      ))}
    </>
  );
}

export function OutreachAnalytics({ setToast }: { setToast: (message: string) => void }) {
  const [choice, setChoice] = useState<RangeChoice>('30d');
  const [customFrom, setCustomFrom] = useState('');
  const [customThrough, setCustomThrough] = useState('');
  const [seatKey, setSeatKey] = useState('');
  const [campaignId, setCampaignId] = useState('');
  const [view, setView] = useState<View>('campaigns');
  const [report, setReport] = useState<RepReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [seats, setSeats] = useState<LinkedInSeat[]>([]);
  const [campaigns, setCampaigns] = useState<ManagedCampaign[]>([]);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [downloading, setDownloading] = useState<string | null>(null);
  const ticket = useRef(0);

  // Filter choices. A failure here leaves the filters at "All", which is still a correct report.
  useEffect(() => {
    void getLinkedInManagerSeats()
      .then(setSeats)
      .catch(() => undefined);
    void getLinkedInManagedCampaigns()
      .then(setCampaigns)
      .catch(() => undefined);
  }, []);

  const { query, problem } = useMemo<{ query: LinkedInReportQuery | null; problem: string }>(() => {
    const filters = { seatKey: seatKey || undefined, campaignId: campaignId || undefined };
    if (choice !== 'custom') return { query: { range: choice, ...filters }, problem: '' };
    if (!customFrom || !customThrough)
      return { query: null, problem: 'Pick the first and the last day to count.' };
    if (customThrough < customFrom)
      return { query: null, problem: 'The last day is before the first day.' };
    const to = shiftDate(customThrough, 1);
    if (!to) return { query: null, problem: 'Use real calendar dates.' };
    return { query: { from: customFrom, to, ...filters }, problem: '' };
  }, [choice, customFrom, customThrough, seatKey, campaignId]);

  const load = useCallback(async () => {
    if (!query) return;
    const mine = ++ticket.current;
    setLoading(true);
    try {
      const next = await getLinkedInReport(query);
      if (mine !== ticket.current) return;
      setReport(next);
      setError('');
    } catch (err) {
      if (mine === ticket.current)
        setError(errorMessage(err, 'Unable to read outreach analytics.'));
    } finally {
      if (mine === ticket.current) setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    void load();
  }, [load]);

  const chooseRange = (next: RangeChoice) => {
    if (next === 'custom' && report && !customFrom && !customThrough) {
      // Start from the window already on screen rather than from two empty boxes.
      setCustomFrom(report.range.from);
      setCustomThrough(shiftDate(report.range.to, -1) ?? report.range.from);
    }
    setChoice(next);
  };

  /** The range and filters the server resolved: what every export is asked for. */
  const exportQuery: LinkedInReportQuery | null = report
    ? {
        from: report.range.from,
        to: report.range.to,
        seatKey: report.filters.seatKey ?? undefined,
        campaignId: report.filters.campaignId ?? undefined
      }
    : null;

  const download = async (key: string, run: () => Promise<CsvDownload>) => {
    setDownloading(key);
    try {
      const file = await run();
      saveFile(file);
      setToast(`Downloaded ${file.filename}.`);
    } catch (err) {
      setToast(errorMessage(err, 'Unable to export these stats.'));
    } finally {
      setDownloading(null);
    }
  };

  const selectable = (report?.members ?? []).filter(
    (row): row is typeof row & { userId: string } => row.userId !== null
  );
  const chosenIds = selectable.filter((row) => selected.has(row.userId)).map((row) => row.userId);
  const teamRows = report ? chosenIds.length * report.range.days : 0;
  const overCap = report ? teamRows > report.limits.maxTeamExportRows : false;
  const allChosen = selectable.length > 0 && chosenIds.length === selectable.length;

  const toggle = (userId: string, on: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      if (on) next.add(userId);
      else next.delete(userId);
      return next;
    });

  const total = report?.total;

  return (
    <section className="page-panel li-viz li-reports" aria-labelledby="li-reports-title">
      <div className="section-heading">
        <div>
          <h3 id="li-reports-title" aria-level={2}>
            Outreach analytics
          </h3>
          <p>{report ? rangeSentence(report) : 'Reading the outreach ledger…'}</p>
        </div>
        <BarChart3 size={20} className="li-heading-icon" aria-hidden="true" />
      </div>

      <div className="li-filter-row" role="group" aria-label="Date range">
        <span className="li-filter-label">Range</span>
        {RANGE_CHOICES.map((option) => (
          <button
            key={option.value}
            type="button"
            className={`li-range ${choice === option.value ? 'is-active' : ''}`}
            aria-pressed={choice === option.value}
            onClick={() => chooseRange(option.value)}
          >
            {option.label}
          </button>
        ))}
        {loading && <LoaderCircle className="spin" size={14} aria-label="Recounting" />}
      </div>

      <div className="li-reports-filters ui-field-row">
        {choice === 'custom' && (
          <>
            <Field label="First day">
              <Input
                type="date"
                value={customFrom}
                max={customThrough || undefined}
                onChange={(event) => setCustomFrom(event.target.value)}
              />
            </Field>
            <Field label="Last day" hint="Counted in full, up to midnight after it.">
              <Input
                type="date"
                value={customThrough}
                min={customFrom || undefined}
                onChange={(event) => setCustomThrough(event.target.value)}
              />
            </Field>
          </>
        )}
        <Field label="LinkedIn account">
          <Select value={seatKey} onChange={(event) => setSeatKey(event.target.value)}>
            <option value="">All accounts</option>
            {seats.map((seat) => (
              <option key={seat.seatKey} value={seat.seatKey}>
                {seat.label || seat.seatKey}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Campaign">
          <Select value={campaignId} onChange={(event) => setCampaignId(event.target.value)}>
            <option value="">All campaigns</option>
            {campaigns.map((campaign) => (
              <option key={campaign.id} value={campaign.id}>
                {campaign.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      {problem && (
        <p className="li-hint" role="status">
          {problem}
        </p>
      )}
      {report && !report.filters.emailIncluded && (
        <p className="li-hint">
          Email is left out while a LinkedIn account is selected: no LinkedIn account sends email.
        </p>
      )}

      {error && (
        <div className="error-banner" role="alert">
          <strong>{error}</strong>{' '}
          <Button disabled={loading} onClick={() => void load()}>
            {loading ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />} Read
            it again
          </Button>
        </div>
      )}

      {!report || !total ? (
        <p className="empty-copy">
          {loading ? 'Reading the outreach ledger…' : 'No count to show.'}
        </p>
      ) : (
        <>
          <div className="li-stat-row">
            <LiStat
              label="Invite acceptance"
              value={ratePercent(total.invitesAccepted, total.invitesSent)}
              detail={`${count(total.invitesAccepted)} accepted of ${count(total.invitesSent)} invites sent`}
            />
            <LiStat
              label="Reply rate"
              value={ratePercent(total.repliedAfterMessage, total.messagedLeads)}
              detail={`${count(total.repliedAfterMessage)} of ${count(total.messagedLeads)} people messaged or emailed`}
            />
            <LiStat
              label="Messages and InMails"
              value={count(total.messagesSent + total.inmailsSent)}
              detail={`${count(total.inmailsSent)} InMails`}
            />
            <LiStat
              label="Emails"
              value={report.filters.emailIncluded ? count(total.emailsSent) : 'not counted'}
              tone={
                !report.filters.emailIncluded
                  ? 'mute'
                  : total.emailsBounced > 0
                    ? 'warn'
                    : undefined
              }
              detail={
                report.filters.emailIncluded
                  ? `${count(total.emailsBounced)} bounced`
                  : 'a LinkedIn account sends none'
              }
            />
          </div>

          <div className="li-filter-row li-reports-views" role="group" aria-label="Breakdown">
            <span className="li-filter-label">By</span>
            {VIEWS.map((option) => (
              <button
                key={option.value}
                type="button"
                className={`li-range ${view === option.value ? 'is-active' : ''}`}
                aria-pressed={view === option.value}
                onClick={() => setView(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>

          {view === 'campaigns' && (
            <div className="li-table-scroll">
              <table className="li-table" aria-label="Outreach by campaign">
                <MetricHead first="Campaign" trailing="Export" />
                <tbody>
                  {report.campaigns.length === 0 && (
                    <tr>
                      <td colSpan={COLUMNS.length + 2} className="empty-copy">
                        Nothing went out in this range.
                      </td>
                    </tr>
                  )}
                  {report.campaigns.map((row) => {
                    const name = row.campaignId
                      ? (row.name ?? row.campaignId)
                      : 'Outside any campaign';
                    return (
                      <tr key={row.campaignId ?? 'none'}>
                        <th scope="row">{name}</th>
                        <MetricCells metrics={row} />
                        <td>
                          {row.campaignId && exportQuery && (
                            <Button
                              variant="ghost"
                              aria-label={`Download daily CSV for ${name}`}
                              disabled={downloading !== null}
                              onClick={() => {
                                const id = row.campaignId as string;
                                void download(`campaign:${id}`, () =>
                                  downloadLinkedInCampaignStatsCsv(id, {
                                    from: exportQuery.from,
                                    to: exportQuery.to,
                                    seatKey: exportQuery.seatKey
                                  })
                                );
                              }}
                            >
                              {downloading === `campaign:${row.campaignId}` ? (
                                <LoaderCircle className="spin" size={14} aria-hidden="true" />
                              ) : (
                                <Download size={14} aria-hidden="true" />
                              )}{' '}
                              CSV
                            </Button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {view === 'daily' && (
            <>
              <div className="li-table-scroll">
                <table className="li-table" aria-label="Outreach by day">
                  <MetricHead first="Day" />
                  <tbody>
                    {report.days.map((day) => (
                      <tr key={day.date}>
                        <th scope="row">{longDate(day.date)}</th>
                        <MetricCells metrics={day} />
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <th scope="row">Whole range</th>
                      <MetricCells metrics={total} />
                    </tr>
                  </tfoot>
                </table>
              </div>
              <div className="panel-footer">
                <span>One row per day in the range above.</span>
                <Button
                  disabled={downloading !== null || !exportQuery}
                  onClick={() =>
                    exportQuery &&
                    void download('daily', () => downloadLinkedInDailyStatsCsv(exportQuery))
                  }
                >
                  <Download size={14} aria-hidden="true" /> Download daily CSV
                </Button>
              </div>
            </>
          )}

          {view === 'team' && (
            <>
              <div className="li-table-scroll">
                <table className="li-table" aria-label="Outreach by team member">
                  <thead>
                    <tr>
                      <th scope="col" className="li-reports-pick">
                        <label className="li-reports-check">
                          <input
                            type="checkbox"
                            checked={allChosen}
                            disabled={selectable.length === 0}
                            onChange={(event) =>
                              setSelected(
                                event.target.checked
                                  ? new Set(selectable.map((row) => row.userId))
                                  : new Set()
                              )
                            }
                          />
                          <span className="mgr-sr">Include everyone in the team export</span>
                        </label>
                      </th>
                      <th scope="col">Member</th>
                      {COLUMNS.map((column) => (
                        <th key={column.label} scope="col" className="li-num">
                          {column.label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {report.members.map((row) => (
                      <tr key={row.userId ?? 'unattributed'}>
                        <td className="li-reports-pick">
                          {row.userId !== null && (
                            <label className="li-reports-check">
                              <input
                                type="checkbox"
                                checked={selected.has(row.userId)}
                                onChange={(event) =>
                                  toggle(row.userId as string, event.target.checked)
                                }
                              />
                              <span className="mgr-sr">Include {row.name} in the team export</span>
                            </label>
                          )}
                        </td>
                        <th scope="row">
                          <span className="li-reports-member">
                            {row.name}
                            {row.status === 'former' && (
                              <span className="status-pill muted">Former member</span>
                            )}
                          </span>
                        </th>
                        <MetricCells metrics={row} />
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="panel-footer li-reports-team-footer">
                <span role="status">
                  {chosenIds.length === 0
                    ? 'Select people to export, one row per person per day.'
                    : overCap
                      ? `${count(teamRows)} rows is over the ${count(report.limits.maxTeamExportRows)}-row limit. Narrow the range or select fewer people.`
                      : `${chosenIds.length} selected: ${count(teamRows)} rows of at most ${count(report.limits.maxTeamExportRows)}.`}
                </span>
                <Button
                  variant="primary"
                  disabled={
                    downloading !== null || chosenIds.length === 0 || overCap || !exportQuery
                  }
                  onClick={() =>
                    exportQuery &&
                    void download('team', () =>
                      downloadLinkedInTeamStatsCsv(exportQuery, chosenIds)
                    )
                  }
                >
                  <Download size={14} aria-hidden="true" /> Download team CSV
                </Button>
              </div>
            </>
          )}

          <details className="li-method-note">
            <summary className="ui-disclosure-summary">How these numbers are counted</summary>
            <div>
              <p>
                <b>Whose number it is.</b> Each action counts for one person: the first of (1) the
                member who queued it themselves, (2) the member assigned to the LinkedIn account
                that sent it (email skips this), (3) the campaign owner, (4) the owner who approved
                that exact message, (5) the workspace owner. People removed from the workspace keep
                their history and show as former members. Reassigning a LinkedIn account or a
                campaign moves its history that nobody queued by hand to the new owner.
              </p>
              <p>
                <b>Which day.</b> LinkedIn actions count on the day they were recorded, emails on
                the day they were sent, in the workspace time zone ({report.range.timezone}). An
                acceptance, reply or bounce counts on the day of the invite, message or email it
                answers. A range starts at midnight on its first day and stops at, not including,
                midnight after its last.
              </p>
              <p>
                <b>Rates.</b> Acceptance is accepted invites out of invites sent. Reply rate is
                people who replied to a message or email out of the people messaged or emailed — the
                same people on both sides, so it cannot pass 100%. <b>Replies</b> counts everyone
                who replied to anything, invite notes included, and counts a person once per row.
                Rates stay “{NOT_ENOUGH_DATA}” until the denominator reaches {RATE_MIN_SAMPLE}.
              </p>
              <p>
                <b>Exports.</b> Each CSV covers the range on screen, one row per day, and its file
                name carries that range. The team file has one row per selected person per day, up
                to {count(report.limits.maxTeamExportRows)} rows; a range covers at most{' '}
                {report.limits.maxDays} days.
              </p>
            </div>
          </details>
        </>
      )}
    </section>
  );
}
