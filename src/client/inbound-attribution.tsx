import { heardAboutLabel } from '../shared/attribution';
import type { OpportunityRecord } from '../shared/types';
import type { InboundAttributionCount, InboundAttributionSummary } from './api';

/** The self-reported channel as its own chip; UTM keys as `key=value` chips. */
export function attributionChips(attribution: Record<string, unknown>): {
  heardAbout: string | null;
  utm: Array<[string, string]>;
} {
  const heard = attribution.heard_about;
  const heardAbout = typeof heard === 'string' ? heardAboutLabel(heard) : null;
  const utm = Object.entries(attribution)
    .filter(
      ([key, value]) =>
        key !== 'heard_about' && value !== undefined && value !== null && String(value).trim()
    )
    .map(([key, value]) => [key, String(value)] as [string, string]);
  return { heardAbout, utm };
}

export function opportunitySourceLine(
  opportunity: Pick<OpportunityRecord, 'sourceHeardAbout' | 'sourceUtmSource'>
): string | null {
  const heard = heardAboutLabel(opportunity.sourceHeardAbout);
  const parts = [
    heard ? `heard about us via ${heard}` : null,
    opportunity.sourceUtmSource ? `utm_source=${opportunity.sourceUtmSource}` : null
  ].filter(Boolean);
  return parts.length > 0 ? `Source: ${parts.join(' · ')}` : null;
}

function AttributionTable({
  caption,
  rows,
  label
}: {
  caption: string;
  rows: InboundAttributionCount[];
  label: (value: string) => string;
}) {
  return (
    <div className="li-table-scroll">
      <table className="li-table">
        <caption>{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Channel</th>
            <th scope="col" className="li-num">
              People
            </th>
            <th scope="col" className="li-num">
              Submissions
            </th>
            <th scope="col" className="li-num">
              With opportunity
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={4} className="li-hint">
                Nothing reported yet.
              </td>
            </tr>
          ) : (
            rows.map((row) => (
              <tr key={row.value}>
                <td>{label(row.value)}</td>
                <td className="li-num">{row.people}</td>
                <td className="li-num">{row.submissions}</td>
                <td className="li-num">{row.peopleWithOpportunity}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

export function AttributionTables({ summary }: { summary: InboundAttributionSummary }) {
  return (
    <section className="page-panel" aria-labelledby="inbound-attribution-title">
      <div className="section-heading">
        <div>
          <h3 id="inbound-attribution-title">Where inbound came from ({summary.days} days)</h3>
          <p>UTM source and the channel people said they heard about you from.</p>
        </div>
      </div>
      <div className="capture-attribution">
        <AttributionTable
          caption="Heard about us"
          rows={summary.byHeardAbout}
          label={(value) => heardAboutLabel(value) ?? value}
        />
        <AttributionTable
          caption="utm_source"
          rows={summary.byUtmSource}
          label={(value) => value}
        />
      </div>
    </section>
  );
}
