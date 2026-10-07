import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { ingestCanonicalRecord } from '../integration-service.js';
import { workspaceUserEmails } from '../meetings/ingest.js';
import { ProviderWebhookError, type ProviderWebhookVerifier } from './types.js';

/**
 * Cal.com booking webhooks.
 *
 * Signature: `X-Cal-Signature-256` is the hex HMAC-SHA256 of the raw body keyed
 * with the webhook's secret, or the literal `no-secret-provided` when the webhook
 * has no secret (https://cal.com/docs/developing/guides/automation/webhooks;
 * `createWebhookSignature` in
 * https://github.com/calcom/cal.com/blob/main/packages/features/webhooks/lib/sendPayload.ts).
 * Body: `{ triggerEvent, createdAt, payload }`. A custom payload template
 * replaces that body, so it is refused rather than guessed at.
 *
 * NO TIMESTAMP HEADER EXISTS, so there is no freshness window. A replayed body
 * dedupes on its event id in `webhook_events`, and a replayed booking state is a
 * no-op in `recordMeeting`. MEETING_STARTED / MEETING_ENDED use a flat body with
 * no `payload` wrapper; they are accepted and ignored.
 */

export const CALCOM_HANDLED_TRIGGERS = [
  'BOOKING_CREATED',
  'BOOKING_RESCHEDULED',
  'BOOKING_CANCELLED'
] as const;

const envelopeSchema = z.object({
  triggerEvent: z.string().min(1),
  createdAt: z.string().optional(),
  payload: z.record(z.unknown()).optional()
});

const bookingSchema = z.object({
  uid: z.string().min(1).max(1024),
  rescheduleUid: z.string().min(1).max(1024).nullish(),
  startTime: z.string().datetime({ offset: true }),
  endTime: z.string().datetime({ offset: true }),
  organizer: z.object({ email: z.string().optional() }).optional(),
  attendees: z
    .array(z.object({ email: z.string().optional(), name: z.string().optional() }))
    .default([])
});

const emailSchema = z.string().email();

function header(headers: Record<string, string | string[] | undefined>, name: string): string {
  const found =
    headers[name] ?? Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1];
  const value = Array.isArray(found) ? found[0] : found;
  return (value ?? '').trim();
}

export const calcomVerifier: ProviderWebhookVerifier = {
  provider: 'calcom',

  verify(rawBody, headers, secret) {
    const signature = header(headers, 'x-cal-signature-256');
    if (!signature || signature === 'no-secret-provided') {
      return {
        ok: false,
        status: 401,
        error:
          'Cal.com sent this webhook without a signature. Paste the signing secret Trevra showed you into the Secret field of the Cal.com webhook.'
      };
    }
    if (!/^[0-9a-f]{64}$/i.test(signature)) {
      return {
        ok: false,
        status: 401,
        error: 'The Cal.com signature is not a SHA-256 hex digest.'
      };
    }
    const expected = createHmac('sha256', secret).update(rawBody).digest();
    if (!timingSafeEqual(Buffer.from(signature, 'hex'), expected)) {
      return {
        ok: false,
        status: 401,
        error: "The Cal.com signature does not match this endpoint's signing secret."
      };
    }
    let body: unknown;
    try {
      body = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return { ok: false, status: 400, error: 'Cal.com sent a body that is not JSON.' };
    }
    const envelope = envelopeSchema.safeParse(body);
    if (!envelope.success) {
      return {
        ok: false,
        status: 400,
        error:
          'Cal.com sent a body without triggerEvent. Clear the custom payload template on this Cal.com webhook so Trevra receives the default body.'
      };
    }
    const trigger = envelope.data.triggerEvent;
    const payload = envelope.data.payload ?? {};
    const uid = typeof payload.uid === 'string' ? payload.uid : '';
    // Hashed so any uid (up to 1024 chars, any characters) satisfies the route's
    // event-id grammar and the id stays deterministic across redeliveries.
    const eventId = createHash('sha256')
      .update(`${trigger}\n${uid}\n${envelope.data.createdAt ?? ''}`)
      .digest('hex');
    return { ok: true, eventId, eventType: trigger, payload };
  },

  async handle(db, endpoint, event) {
    if (!(CALCOM_HANDLED_TRIGGERS as readonly string[]).includes(event.eventType)) {
      return { handled: false };
    }
    const parsed = bookingSchema.safeParse(event.payload);
    // A signed but malformed booking will never parse on retry: ignore it (200).
    if (!parsed.success) {
      throw new ProviderWebhookError('Cal.com sent a booking Trevra cannot read.', 422);
    }
    const booking = parsed.data;
    const organizer = booking.organizer?.email?.trim().toLowerCase() ?? '';
    const own = await workspaceUserEmails(db, endpoint.workspaceId);
    // Cal.com lists the booker first; skip the host and anyone who is "us".
    const attendee = booking.attendees.find((candidate) => {
      const email = candidate.email?.trim().toLowerCase() ?? '';
      return (
        email !== '' &&
        email !== organizer &&
        !own.has(email) &&
        emailSchema.safeParse(email).success
      );
    });
    if (!attendee?.email) return { handled: false };
    const rescheduled = event.eventType === 'BOOKING_RESCHEDULED';
    const outcome = await ingestCanonicalRecord(
      db,
      endpoint.workspaceId,
      'calcom',
      null,
      {
        kind: 'meeting',
        id: booking.uid,
        ...(rescheduled && booking.rescheduleUid ? { previousId: booking.rescheduleUid } : {}),
        personEmail: attendee.email.trim().toLowerCase(),
        ...(attendee.name?.trim() ? { personName: attendee.name.trim() } : {}),
        status:
          event.eventType === 'BOOKING_CANCELLED'
            ? 'cancelled'
            : rescheduled
              ? 'rescheduled'
              : 'scheduled',
        origin: 'booking',
        startAt: booking.startTime,
        endAt: booking.endTime
      },
      { meetingOrigin: 'booking' }
    );
    return { handled: outcome.stored };
  }
};
