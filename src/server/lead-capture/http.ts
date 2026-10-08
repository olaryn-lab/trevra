import express, { type Express, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import type { Db } from '../db.js';
import { CITATION_SOURCE_KIND, inboundSubmissionSchema, LeadCaptureError } from './types.js';
import {
  getCaptureSourceById,
  readCaptureSourceSigningSecrets,
  recordCaptureSourceAccepted,
  recordCaptureSourceRejected
} from './sources.js';
import { acceptInboundSubmission, payloadHash } from './submissions.js';
import { accountForPerson } from '../person-identities.js';
import { isMilestoneKind } from './milestones.js';
import { recordProductMilestone } from './milestone-recorder.js';
import {
  captureHeaderProblem,
  captureSignatureMatches,
  MAX_CAPTURE_BODY_BYTES,
  rawCaptureBody,
  readCaptureHeaders
} from './signature.js';

async function handleIntake(db: Db, req: Request, res: Response): Promise<void> {
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
  // Checked after the signature, so an unsigned probe cannot learn a source's
  // kind. A citation secret proves who signed; it does not make this the
  // endpoint the secret was issued for.
  if (source.kind === CITATION_SOURCE_KIND)
    return void (await reject(403, 'This capture source only accepts AI-answer citation samples'));

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return void (await reject(400, 'Invalid JSON body'));
  }
  const validated = inboundSubmissionSchema.safeParse(parsed);
  if (!validated.success)
    return void (await reject(
      400,
      validated.error.issues.map((issue) => issue.message).join('; ')
    ));

  try {
    const result = await acceptInboundSubmission(db, {
      source,
      idempotencyKey: headers.idempotencyKey,
      body: validated.data,
      payloadHash: payloadHash(rawBody)
    });
    await recordCaptureSourceAccepted(db, source.id);
    const kind = result.submission.kind;
    if (isMilestoneKind(kind)) {
      // A milestone is an outcome, not inbound to qualify. The submission row stays as
      // provenance and the milestone is recorded against it. This also runs on a duplicate,
      // so a retry heals a crash between the two writes. The submission is already accepted,
      // so a recorder failure is a server fault (5xx, sender retries), never a rejection.
      try {
        await recordProductMilestone(db, {
          workspaceId: source.workspaceId,
          kind,
          contactId: result.contactId,
          accountId:
            result.accountId ?? (await accountForPerson(db, source.workspaceId, result.contactId)),
          sourceType: 'inbound_submission',
          sourceId: result.submission.id,
          occurredAt: new Date(result.submission.occurredAt ?? result.submission.receivedAt)
        });
      } catch (error) {
        console.error('milestone recording failed', error);
        res
          .status(503)
          .json({ error: 'Milestone recording failed. Retry with the same idempotency key.' });
        return;
      }
    }
    res.status(result.duplicate ? 200 : 202).json({
      submissionId: result.submission.id,
      personId: result.contactId,
      accountId: result.accountId,
      duplicate: result.duplicate
    });
  } catch (error) {
    if (error instanceof LeadCaptureError) {
      await recordCaptureSourceRejected(db, source.id);
      res.status(error.status).json({ error: error.message });
      return;
    }
    throw error;
  }
}

export function createCaptureSourceLimiter() {
  return rateLimit({
    windowMs: 60_000,
    limit: 120,
    standardHeaders: true,
    legacyHeaders: false,
    // Unknown/missing sources intentionally share one bucket. Once a source ID
    // is present it becomes the quota key, so IPv6 address normalisation never
    // enters this limiter and one source cannot spend another source's quota.
    keyGenerator: (req) => String(req.headers['x-trevra-source'] ?? 'unknown'),
    message: {
      error: 'Capture source has made too many requests. Retry with the same idempotency key.'
    }
  });
}

export function isEntityTooLarge(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'type' in error &&
    (error as { type?: string }).type === 'entity.too.large'
  );
}

export function registerLeadCaptureIntake(app: Express, db: Db): void {
  app.post(
    '/api/intake/v1/submissions',
    createCaptureSourceLimiter(),
    express.raw({ type: 'application/json', limit: MAX_CAPTURE_BODY_BYTES }),
    async (req, res, next) => {
      try {
        await handleIntake(db, req, res);
      } catch (error) {
        if (isEntityTooLarge(error)) {
          res.status(413).json({ error: 'Capture payload is too large' });
          return;
        }
        next(error);
      }
    }
  );
}
