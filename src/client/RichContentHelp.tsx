import { useId } from 'react';
import { Paperclip } from 'lucide-react';
import {
  RICH_CONTENT_CHANNELS,
  RICH_CONTENT_MATRIX,
  RICH_CONTENT_SUPPORT_LABELS,
  RICH_CONTENT_TYPE_LABELS,
  RICH_CONTENT_TYPES,
  richContentLimitsSummary,
  type RichContentChannel
} from '../shared/rich-content';
import { Button } from './ui/primitives';

/**
 * TRV-040: the rich-content matrix as a compact help table.
 *
 * Generated from `src/shared/rich-content.ts`, the same table the server
 * enforces, so what this says is supported is exactly what a save accepts.
 * Closed by default (progressive disclosure); the row for the channel being
 * edited is marked current and its refusals are spelled out under the table.
 */
export function RichContentHelp({
  current,
  channels = RICH_CONTENT_CHANNELS,
  summary = 'What each channel can carry'
}: {
  current?: RichContentChannel;
  channels?: readonly RichContentChannel[];
  summary?: string;
}) {
  const spec = current ? RICH_CONTENT_MATRIX[current] : null;
  const refused = spec
    ? RICH_CONTENT_TYPES.filter((type) => spec.cells[type].support !== 'supported')
    : [];
  return (
    <details className="li-table-view rich-content-help">
      <summary>{summary}</summary>
      <div className="li-table-scroll">
        <table className="li-table">
          <thead>
            <tr>
              <th scope="col">Channel</th>
              {RICH_CONTENT_TYPES.map((type) => (
                <th scope="col" key={type}>
                  {RICH_CONTENT_TYPE_LABELS[type]}
                </th>
              ))}
              <th scope="col">Limits</th>
            </tr>
          </thead>
          <tbody>
            {channels.map((channel) => {
              const row = RICH_CONTENT_MATRIX[channel];
              const isCurrent = channel === current;
              return (
                <tr
                  key={channel}
                  className={isCurrent ? 'is-current' : undefined}
                  aria-current={isCurrent ? 'true' : undefined}
                >
                  <th scope="row">{row.label}</th>
                  {RICH_CONTENT_TYPES.map((type) => (
                    <td key={type} data-support={row.cells[type].support}>
                      {RICH_CONTENT_SUPPORT_LABELS[row.cells[type].support]}
                    </td>
                  ))}
                  <td>{richContentLimitsSummary(channel)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {spec && refused.length > 0 && (
        <ul className="rich-content-reasons">
          {refused.map((type) => (
            <li key={type}>
              <b>
                {RICH_CONTENT_TYPE_LABELS[type]} on {spec.label}:
              </b>{' '}
              {spec.cells[type].reason}
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}

/**
 * The attach control for a channel that takes no attachments: present so the
 * operator can see the option exists elsewhere, disabled, and explained in
 * the matrix's own words (link-only reason first, then voice).
 */
export function RichContentAttachNote({ channel }: { channel: RichContentChannel }) {
  const id = useId();
  const spec = RICH_CONTENT_MATRIX[channel];
  const linkOnly = RICH_CONTENT_TYPES.find((type) => spec.cells[type].support === 'link_only');
  const explanation = [
    linkOnly ? spec.cells[linkOnly].reason : spec.cells.image.reason,
    spec.cells.voice.support === 'unsupported' && linkOnly
      ? `Voice: ${spec.cells.voice.reason}`
      : ''
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <div className="rich-content-attach">
      <Button disabled aria-describedby={id}>
        <Paperclip size={14} aria-hidden="true" /> Attach file
      </Button>
      <p className="li-hint" id={id}>
        <b>No attachments on {spec.label}.</b> {explanation}
      </p>
    </div>
  );
}
