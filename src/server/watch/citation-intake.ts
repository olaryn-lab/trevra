import express, { type Express, type Request, type Response } from 'express';
import type { Db } from '../db.js';
import { createCaptureSourceLimiter } from '../lead-capture/http.js';
import {
  captureHeaderProblem,
  captureSignatureMatches,
  MAX_CAPTURE_BODY_BYTES,
  rawCaptureBody,
  readCaptureHeaders
} from '../lead-capture/signature.js';
import {
  getCaptureSourceById,
  readCaptureSourceSigningSecrets,
  recordCaptureSourceAccepted,
  recordCaptureSourceRejected
} from '../lead-capture/sources.js';
import { payloadHash } from '../lead-capture/submissions.js';
import { CITATION_SOURCE_KIND, LeadCaptureError } from '../lead-capture/types.js';
import {
  citationSampleSchema,
  getCitationLinkForSource,
  recordCitationSample
} from './citations.js';

export const CITATION_INTAKE_PATH = '/api/intake/v1/citations';

/**
 * The AI-answer twin of lead intake. Same headers, same signing recipe, same
 * check order up to the signature; then the source must be a citation source
 * linked to a brand watch. The workspace and the watch both come from the
 * authenticated source, never from the body.
 */
async function handleCitation(db: Db, req: Request, res: Response): Promise<void> {
  const headers = readCaptureHeaders(req.headers);
  const source = headers.sourceId ? await getCaptureSourceById(db, headers.sourceId) : null;
  if (!source) {
    res.status(404).json({ error: 'Capture source not found' });
    return;
  }
  const reject = async (status: number, message: string) => {
    await recordCaptureSourceRejected(db, source.id);
    res.status(status).json({ error: message });
  };
  if (source.status !== 'active') return void (await reject(401, 'Capture source is disabled'));
  const problem = captureHeaderProblem(headers, Math.floor(Date.now() / 1000));
  if (problem) return void (await reject(problem.status, problem.error));

  const rawBody = rawCaptureBody(req.body);
  const secrets = await readCaptureSourceSigningSecrets(db, source);
  if (secrets.length === 0) return void (await reject(401, 'Capture source has no usable secret'));
  if (!captureSignatureMatches(secrets, headers, rawBody))
    return void (await reject(401, 'Invalid capture signature'));
  if (source.kind !== CITATION_SOURCE_KIND)
    return void (await reject(
      403,
      'This capture source does not accept AI-answer citation samples'
    ));
  const link = await getCitationLinkForSource(db, source);
  if (!link)
    return void (await reject(409, 'This citation source is not connected to a brand watch'));

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return void (await reject(400, 'Invalid JSON body'));
  }
  const validated = citationSampleSchema.safeParse(parsed);
  if (!validated.success)
    return void (await reject(
      400,
      validated.error.issues
        .map((issue) =>
          issue.code === 'unrecognized_keys'
            ? `Unknown fields: ${issue.keys.join(', ')}`
            : `${issue.path.join('.') || 'body'}: ${issue.message}`
        )
        .join('; ')
    ));

  try {
    const result = await recordCitationSample(db, {
      link,
      idempotencyKey: headers.idempotencyKey,
      payloadHash: payloadHash(rawBody),
      sample: validated.data
    });
    await recordCaptureSourceAccepted(db, source.id);
    res.status(result.duplicate ? 200 : 202).json({
      sampleId: validated.data.sampleId,
      change: result.change,
      mentionId: result.mention?.id ?? null,
      duplicate: result.duplicate
    });
  } catch (error) {
    if (error instanceof LeadCaptureError) return void (await reject(error.status, error.message));
    throw error;
  }
}

export function registerCitationIntake(app: Express, db: Db): void {
  app.post(
    CITATION_INTAKE_PATH,
    createCaptureSourceLimiter(),
    express.raw({ type: 'application/json', limit: MAX_CAPTURE_BODY_BYTES }),
    // An oversize body fails inside express.raw (before this handler) and goes
    // to the global error handler, which answers 413.
    (req, res, next) => {
      handleCitation(db, req, res).catch(next);
    }
  );
}
