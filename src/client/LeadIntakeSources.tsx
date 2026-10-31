import { ExternalLink, FileUp, Link2, ShieldCheck } from 'lucide-react';
import {
  UNSUPPORTED_INTAKE_COPY,
  UNSUPPORTED_INTAKE_SOURCE_ORDER,
  type UnsupportedIntakeSource
} from '../shared/lead-intake';
import { Button } from './ui/primitives';

/**
 * The explicit "not supported" state for LinkedIn search, Sales Navigator and
 * post engagers (TRV-021/022/023).
 *
 * NOT AN ERROR AND NOT A SWITCH. Trevra does not scrape LinkedIn, so these are
 * not "unavailable right now" -- there is nothing to enable. The copy is the
 * same sentence the server returns with `intake_source_unsupported`, and the
 * only controls are the supported ways to bring the same people in.
 */
export function UnsupportedIntakeSources({
  requested = null,
  requestedUrl = '',
  onImportCsv,
  onPasteUrls
}: {
  /** The source a deep link asked for, marked so the operator finds their answer first. */
  requested?: UnsupportedIntakeSource | null;
  /** A LinkedIn page a deep link carried, offered for the operator to browse themselves. */
  requestedUrl?: string;
  onImportCsv: () => void;
  onPasteUrls: () => void;
}) {
  const order = requested
    ? [requested, ...UNSUPPORTED_INTAKE_SOURCE_ORDER.filter((source) => source !== requested)]
    : UNSUPPORTED_INTAKE_SOURCE_ORDER;
  return (
    <section
      className="page-panel lead-intake-unsupported"
      aria-labelledby="lead-intake-unsupported"
    >
      <div className="section-heading">
        <div>
          <h3 aria-level={2} id="lead-intake-unsupported">
            LinkedIn search, Sales Navigator and post engagers are not supported
          </h3>
          <p>
            Trevra does not scrape LinkedIn. Collecting people automatically from search results,
            Sales Navigator, or a post’s likers and commenters violates LinkedIn’s terms and puts
            your LinkedIn account at risk of restriction. Bring in the people you chose instead: a
            CSV you are allowed to use, or their profile URLs.
          </p>
        </div>
        <ShieldCheck size={20} className="li-heading-icon" aria-hidden="true" />
      </div>

      <div className="lead-kinds">
        <dl>
          {order.map((source) => {
            const copy = UNSUPPORTED_INTAKE_COPY[source];
            return (
              <div key={source} className={source === requested ? 'is-requested' : undefined}>
                <dt>
                  {copy.label} <span className="li-chip">Not supported</span>
                </dt>
                <dd>
                  <p>{copy.reason}</p>
                  <p>
                    <strong>Instead:</strong> {copy.instead}
                  </p>
                </dd>
              </div>
            );
          })}
        </dl>
      </div>

      {requestedUrl && (
        <p className="li-hint">
          The link that brought you here points at a LinkedIn page Trevra will not read for you.{' '}
          <a className="li-link" href={requestedUrl} target="_blank" rel="noopener noreferrer">
            Open it on LinkedIn <ExternalLink size={12} aria-hidden="true" />
          </a>{' '}
          and paste the profile URLs of the people you choose.
        </p>
      )}

      <div className="mgr-actions">
        <Button variant="primary" onClick={onImportCsv}>
          <FileUp size={14} aria-hidden="true" /> Import a CSV
        </Button>
        <Button onClick={onPasteUrls}>
          <Link2 size={14} aria-hidden="true" /> Paste profile URLs
        </Button>
      </div>
    </section>
  );
}
