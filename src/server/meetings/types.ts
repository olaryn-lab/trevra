import { z } from 'zod';

export const MEETING_STATUSES = ['scheduled', 'rescheduled', 'cancelled'] as const;
export type MeetingStatus = (typeof MEETING_STATUSES)[number];

/**
 * `calendar` is an observation (Google Calendar): it attaches only to a Person
 * already in the workspace and only raises an Opportunity that already exists.
 * `booking` is intent (Cal.com): it may create the Person and an Opportunity.
 */
export const MEETING_ORIGINS = ['calendar', 'booking'] as const;
export type MeetingOrigin = (typeof MEETING_ORIGINS)[number];

/**
 * The canonical `meeting` record. A plain object schema because it is a member
 * of `canonicalRecordSchema`'s discriminated union; the "a live meeting needs a
 * person and both times" rule is `activeMeetingSchema`, applied at ingestion.
 * There is no title, description or attendee list on purpose.
 */
export const canonicalMeetingSchema = z.object({
  kind: z.literal('meeting'),
  id: z.string().min(1).max(1024),
  previousId: z.string().min(1).max(1024).optional(),
  accountName: z.string().optional(),
  personName: z.string().optional(),
  personEmail: z.string().email().optional(),
  status: z.enum(MEETING_STATUSES).default('scheduled'),
  origin: z.enum(MEETING_ORIGINS).default('calendar'),
  startAt: z.string().datetime({ offset: true }).optional(),
  endAt: z.string().datetime({ offset: true }).optional(),
  externalUrl: z.string().url().optional()
});

export type CanonicalMeeting = z.infer<typeof canonicalMeetingSchema>;

export const activeMeetingSchema = z
  .object({
    personEmail: z.string().email(),
    startAt: z.string().datetime({ offset: true }),
    endAt: z.string().datetime({ offset: true })
  })
  .refine((meeting) => Date.parse(meeting.endAt) >= Date.parse(meeting.startAt), {
    message: 'endAt must not be before startAt',
    path: ['endAt']
  });
