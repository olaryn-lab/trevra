import { id, type Db } from '../db.js';
import {
  AUTO_REPLY_PATTERN,
  OPT_OUT_REPLY_PATTERN,
  OUT_OF_OFFICE_REPLY_PATTERN,
  stripQuotedReply
} from '../email-outcomes.js';

/**
 * TRV-037: what an inbound LinkedIn message most likely means, as a SUGGESTION.
 *
 * DETERMINISTIC AND ADVISORY. The classifier is a fixed, ordered list of rules;
 * the same text always yields the same class, rule id and confidence, and the
 * confidence is the rule's own fixed number rather than a model score. Nothing
 * here changes state: `storeReplySuggestions` files rows with
 * status='suggested', and only a human confirmation in inbox-organization.ts
 * can act on one. No model is consulted.
 *
 * ORDER IS SAFETY. An opt-out is checked first so "not interested, please stop
 * messaging me" is never filed as a plain not-interested, and not-interested is
 * checked before interested because the second phrase contains the first.
 */

export const REPLY_CLASSES = [
  'interested',
  'not_interested',
  'out_of_office',
  'opt_out',
  'referral',
  'question',
  'other'
] as const;
export type ReplyClass = (typeof REPLY_CLASSES)[number];

export const REPLY_CLASSIFIER_VERSION = 'linkedin-reply-rules@1';

export interface ReplySuggestion {
  replyClass: ReplyClass;
  /** The rule that matched, e.g. `rule:opt_out.explicit`. */
  source: string;
  /** The rule's fixed confidence in [0, 1]. */
  confidence: number;
}

interface Rule {
  id: string;
  replyClass: ReplyClass;
  confidence: number;
  test: (text: string) => boolean;
}

const LINKEDIN_OPT_OUT =
  /\b(?:stop (?:messaging|contacting|writing to|reaching out to) me|(?:do not|don'?t) (?:message|contact|dm|write to|reach out to) me|leave me alone|remove me from (?:your|this) list|no more messages|not interested,? (?:please )?stop)\b/i;
const NOT_INTERESTED =
  /\b(?:not interested|no,? thanks|no,? thank you|not (?:a )?(?:good )?fit|not looking|not in the market|we(?:'re| are) all set|i(?:'ll| will) pass|we(?:'ll| will) pass|pass on this|no need for)\b/i;
const REFERRAL =
  /\b(?:(?:you should|better to|please|try) (?:reach out to|contact|talk to|speak (?:to|with)|email)|(?:i'?ll|let me) (?:loop in|introduce you|connect you|forward (?:this|you))|the right person (?:is|would be|to talk to)|not the right person|forwarding (?:this|you) to|in charge of (?:this|that))\b/i;
const INTERESTED =
  /\b(?:interested|sounds (?:good|great|interesting)|let'?s (?:talk|chat|connect|set up|schedule|book)|happy to (?:chat|talk|connect|learn|hop on)|tell me more|send (?:me )?(?:more )?(?:info|details|information)|book a (?:call|time|meeting|demo)|what (?:time|day)s? works|count me in|schedule a (?:call|meeting|demo))\b/i;
const QUESTION_START =
  /^(?:what|how|who|when|where|why|which|can you|could you|do you|does it|is it|is there|are you|would you)\b/i;

const RULES: readonly Rule[] = [
  {
    id: 'rule:opt_out.explicit',
    replyClass: 'opt_out',
    confidence: 0.9,
    test: (text) => OPT_OUT_REPLY_PATTERN.test(text) || LINKEDIN_OPT_OUT.test(text)
  },
  {
    id: 'rule:out_of_office.notice',
    replyClass: 'out_of_office',
    confidence: 0.85,
    test: (text) => OUT_OF_OFFICE_REPLY_PATTERN.test(text) || AUTO_REPLY_PATTERN.test(text)
  },
  {
    id: 'rule:not_interested.explicit',
    replyClass: 'not_interested',
    confidence: 0.8,
    test: (text) => NOT_INTERESTED.test(text)
  },
  {
    id: 'rule:referral.redirect',
    replyClass: 'referral',
    confidence: 0.7,
    test: (text) => REFERRAL.test(text)
  },
  {
    id: 'rule:interested.positive',
    replyClass: 'interested',
    confidence: 0.7,
    test: (text) => INTERESTED.test(text)
  },
  {
    id: 'rule:question.mark',
    replyClass: 'question',
    confidence: 0.55,
    test: (text) => text.includes('?') || QUESTION_START.test(text)
  }
];

/** Pure: one inbound message body in, one suggestion out. */
export function classifyLinkedInReply(body: string | null | undefined): ReplySuggestion {
  const text = stripQuotedReply(body).replace(/\s+/g, ' ').trim();
  if (!text) return { replyClass: 'other', source: 'rule:other.empty', confidence: 0 };
  for (const rule of RULES) {
    if (rule.test(text)) {
      return { replyClass: rule.replyClass, source: rule.id, confidence: rule.confidence };
    }
  }
  return { replyClass: 'other', source: 'rule:other.fallback', confidence: 0.3 };
}

export function isReplyClass(value: unknown): value is ReplyClass {
  return typeof value === 'string' && (REPLY_CLASSES as readonly string[]).includes(value);
}

/**
 * File suggestions for inbound messages. Idempotent per message: a message that
 * already carries a classification -- suggested or confirmed -- is left alone,
 * so a re-sync can never overwrite a human's confirmation.
 */
export async function storeReplySuggestions(
  db: Db,
  workspaceId: string,
  threadId: string,
  messages: ReadonlyArray<{ id: string; body: string }>,
  now: Date
): Promise<number> {
  if (messages.length === 0) return 0;
  const ids: string[] = [];
  const messageIds: string[] = [];
  const classes: string[] = [];
  const sources: string[] = [];
  const confidences: number[] = [];
  for (const message of messages) {
    const suggestion = classifyLinkedInReply(message.body);
    ids.push(id('lrcl'));
    messageIds.push(message.id);
    classes.push(suggestion.replyClass);
    sources.push(suggestion.source);
    confidences.push(suggestion.confidence);
  }
  // The join re-asserts that each message is an inbound message of this thread
  // in this workspace; a mismatched id inserts nothing.
  const result = await db
    .prepare(
      `
    INSERT INTO linkedin_reply_classifications (
      id, workspace_id, thread_id, message_id, suggested_class, suggested_source,
      suggested_confidence, classifier_version, suggested_at, status
    )
    SELECT x.id, m.workspace_id, m.thread_id, m.id, x.cls, x.src, x.conf, ?, ?::timestamptz, 'suggested'
    FROM unnest(?::text[], ?::text[], ?::text[], ?::text[], ?::real[]) AS x(id, message_id, cls, src, conf)
    JOIN linkedin_messages m ON m.id = x.message_id
    WHERE m.workspace_id = ? AND m.thread_id = ? AND m.direction = 'in'
    ON CONFLICT (message_id) DO NOTHING
  `
    )
    .run(
      REPLY_CLASSIFIER_VERSION,
      now.toISOString(),
      ids,
      messageIds,
      classes,
      sources,
      confidences,
      workspaceId,
      threadId
    );
  return result.changes;
}
