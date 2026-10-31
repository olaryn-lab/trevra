import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { z } from 'zod/v3';
import { PlaybookError } from '../playbooks/engine.js';
import { SkillApiError } from '../skill-api.js';

/**
 * The one error shape of the supported public API (TRV-053):
 *
 *   { "error": { "code": "<stable_snake_case>", "message": "...", "requestId": "..." } }
 *
 * plus `details` on a 400 validation failure. It applies ONLY to routes in
 * `PUBLIC_API_ROUTES`; every internal route the React client calls keeps its
 * historical `{ error: string }` body.
 */

/** Accepted inbound X-Request-Id values. Anything else is replaced, never echoed. */
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export type PublicApiErrorLocation = 'path' | 'query' | 'body';

export interface PublicApiErrorDetail {
  location: PublicApiErrorLocation;
  /** Dotted path inside `location`; empty when the whole value is wrong. */
  field: string;
  code: string;
  message: string;
}

export class PublicApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: PublicApiErrorDetail[],
    readonly headers: Readonly<Record<string, string>> = {}
  ) {
    super(message);
  }
}

const CODE_BY_STATUS: Readonly<Record<number, string>> = {
  400: 'invalid_request',
  401: 'unauthenticated',
  403: 'forbidden',
  404: 'not_found',
  405: 'method_not_allowed',
  409: 'conflict',
  413: 'payload_too_large',
  415: 'unsupported_media_type',
  422: 'unprocessable_entity',
  429: 'rate_limited',
  503: 'service_unavailable'
};

export function errorCodeForStatus(status: number): string {
  return CODE_BY_STATUS[status] ?? (status >= 500 ? 'internal_error' : 'invalid_request');
}

export function validationError(
  location: PublicApiErrorLocation,
  error: z.ZodError,
  prefix: ReadonlyArray<string | number> = []
): PublicApiError {
  return new PublicApiError(
    400,
    'validation_failed',
    'Request validation failed',
    error.issues.map((issue) => ({
      location,
      field: [...prefix, ...issue.path].join('.'),
      code: issue.code,
      message: issue.message
    }))
  );
}

/**
 * Map anything a public route can throw onto the envelope.
 *
 * Only errors whose message is written for the caller keep it: the service
 * errors the old agent routes already answered with (`SkillApiError`,
 * `PlaybookError`), body-parser rejections, and Zod. Everything else is a
 * 500 whose message is fixed, so a stack, SQL text or provider detail can never
 * reach a token holder. The real error is logged against the request id.
 */
export function toPublicApiError(error: unknown): PublicApiError {
  if (error instanceof PublicApiError) return error;
  if (error instanceof z.ZodError) return validationError('body', error);
  if (error instanceof SkillApiError || error instanceof PlaybookError) {
    if (error.status >= 400 && error.status < 500)
      return new PublicApiError(error.status, errorCodeForStatus(error.status), error.message);
    return internalError(error.status >= 500 && error.status < 600 ? error.status : 500);
  }
  const bodyParserType =
    error && typeof error === 'object' && 'type' in error
      ? String((error as { type?: unknown }).type)
      : '';
  if (bodyParserType === 'entity.parse.failed')
    return new PublicApiError(400, 'invalid_json', 'Request body is not valid JSON');
  if (bodyParserType === 'entity.too.large')
    return new PublicApiError(413, 'payload_too_large', 'Request body is too large');
  if (bodyParserType === 'encoding.unsupported' || bodyParserType === 'charset.unsupported')
    return new PublicApiError(415, 'unsupported_media_type', 'Unsupported request body encoding');
  return internalError(500);
}

function internalError(status: number): PublicApiError {
  return status === 503
    ? new PublicApiError(503, 'service_unavailable', 'Service temporarily unavailable')
    : new PublicApiError(status, 'internal_error', 'Internal server error');
}

/** The id pino-http assigned (and already wrote to X-Request-Id). */
export function requestIdOf(req: Request, res: Response): string {
  const assigned = (req as Request & { id?: unknown }).id;
  if (typeof assigned === 'string' || typeof assigned === 'number') return String(assigned);
  const header = res.getHeader('x-request-id');
  if (typeof header === 'string' && header) return header;
  const generated = randomUUID();
  res.setHeader('X-Request-Id', generated);
  return generated;
}

export function sendPublicApiError(req: Request, res: Response, error: PublicApiError): void {
  const requestId = requestIdOf(req, res);
  res.setHeader('X-Request-Id', requestId);
  res.setHeader('Cache-Control', 'no-store');
  for (const [name, value] of Object.entries(error.headers)) res.setHeader(name, value);
  res.status(error.status).json({
    error: {
      code: error.code,
      message: error.message,
      requestId,
      ...(error.details ? { details: error.details } : {})
    }
  });
}
