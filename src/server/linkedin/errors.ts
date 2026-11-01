import type { RichContentViolation } from '../../shared/rich-content.js';

/**
 * A 4xx an operator caused. Routes map `status` straight onto the response;
 * `code` and `details`, when present, are serialized beside the message so a
 * client can branch on a stable value instead of parsing prose.
 */
export class LinkedInApiError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
    public readonly code: string | null = null,
    public readonly details: Readonly<Record<string, unknown>> | null = null
  ) {
    super(message);
    this.name = 'LinkedInApiError';
  }
}

/** The response fields a rich-content refusal carries beside its message. */
export function richContentRefusalDetails(
  violation: RichContentViolation
): Record<string, unknown> {
  return {
    reason: violation.reason,
    channel: violation.channel,
    contentType: violation.contentType,
    index: violation.index
  };
}

/**
 * TRV-040: a matrix refusal as an API error. 413 for size, 422 otherwise; an
 * upload route whose request body IS the wrong media type passes 415.
 */
export function richContentError(
  violation: RichContentViolation,
  status?: number
): LinkedInApiError {
  return new LinkedInApiError(
    violation.reason,
    status ?? (violation.code === 'attachment_too_large' ? 413 : 422),
    violation.code,
    richContentRefusalDetails(violation)
  );
}
