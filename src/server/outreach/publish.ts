import { z } from 'zod/v3';
import type { Db } from '../db.js';
import { evaluatePolicy } from '../control-plane/policy.js';
import { getChannel } from '../channels/registry.js';
import { envCredentials, type CredentialAccessor } from '../research/types.js';
import type { FetchLike } from '../skills/guard.js';
import { createSsrfFetch } from '../skills/guard.js';
import {
  countPostsToday,
  existingPost,
  existingPostForThread,
  lastPostInCommunity,
  recordPost,
  settlePost
} from './store.js';
import { limitsFor } from './config.js';

/**
 * Delivery for an APPROVED community reply.
 *
 * Reached only from `control-plane/execution.ts`, which the playbook engine
 * calls only after it has matched the action payload's canonical hash against
 * the hash a human approved. There is no other entry point, and nothing here
 * posts anything that a human has not signed off byte for byte.
 *
 * TWO GATES DECIDE WHETHER TREVRA MAY PRESS THE BUTTON, and both must pass:
 *
 * 1. THE CHANNEL'S POLICY (`channels/adapters/*.ts`). `prepare-only` means the
 *    platform's rules make unattended posting a ban risk. Reddit is the case
 *    that matters: its API can post, the reference happily did, and doing so
 *    unattended is what gets an account shadowbanned.
 * 2. WHETHER A REPLY API EXISTS AT ALL. This is NOT the same question, and
 *    conflating them would be a real bug: a channel is `api-publish` when it
 *    can PUBLISH YOUR OWN POST. dev.to can publish an article and has no
 *    comment endpoint whatsoever; replying to someone else's thread there is
 *    not something an API can do at any policy setting.
 *
 * Failing either gate is not an error. The reply becomes a MANUAL HANDOFF: the
 * approved text is written to the post log with the thread URL, and the
 * founder posts it themselves. That still consumes the daily cap and starts
 * the community cooldown, because a human posting it costs the community
 * exactly as much attention as a machine posting it would.
 */

export const communityReplyPayloadSchema = z.object({
  platform: z.string().min(1).max(40),
  threadExternalId: z.string().min(1).max(200),
  threadUrl: z.string().url(),
  community: z.string().max(200).nullish(),
  body: z.string().min(1).max(20_000),
  /**
   * Carries `safetyAllowed`, which this module REQUIRES to be exactly `true`.
   *
   * The safety verdict is part of the payload a human approved, so it is
   * covered by the approval hash: it cannot be flipped after the fact without
   * invalidating the approval and failing the action. That is what makes
   * carrying the decision here equivalent to re-deriving it, and it closes the
   * gap where a custom playbook omits the guard step entirely.
   */
  metadata: z.record(z.unknown()).optional()
});

export type CommunityReplyPayload = z.infer<typeof communityReplyPayloadSchema>;

export interface PublishOptions {
  credentials?: CredentialAccessor;
  fetchImpl?: FetchLike;
  /** Preserve the original playbook actor for actor-scoped workspace policies. */
  actorType?: string;
  actorId?: string | null;
  playbookId?: string;
}

interface PublishOutcome {
  provider: string;
  externalRef: string;
}

/** The platform answered and refused. The claim on this payload is released for retry. */
export class PlatformRejection extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
    this.name = 'PlatformRejection';
  }
}

/**
 * We never learned whether the platform accepted it -- timeout, DNS, reset.
 *
 * Deliberately NOT retryable. If the request landed and only the response was
 * lost, retrying posts a second public comment on a stranger's thread. A
 * missing comment can be posted by hand; a duplicate cannot be unposted, and
 * duplicate replies are exactly what gets an account banned for spam.
 */
export class PlatformUnreachable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlatformUnreachable';
  }
}

/**
 * POST and parse, distinguishing "refused" from "never answered".
 *
 * The scouts' `getJson` collapses both into `null` because for a READ they are
 * the same thing -- no data. For a WRITE they are opposite: one is safe to
 * retry and the other is not.
 */
async function postJson(
  client: FetchLike,
  url: string,
  headers: Record<string, string>,
  body: string
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WRITE_TIMEOUT_MS);
  let response: Response;
  try {
    response = await client(url, { method: 'POST', headers, body, signal: controller.signal });
  } catch (cause) {
    throw new PlatformUnreachable(
      `no response from ${new URL(url).host}: ${cause instanceof Error ? cause.message : String(cause)}`
    );
  } finally {
    clearTimeout(timer);
  }

  if (response.status >= 500) {
    // A 5xx comes from a gateway or a half-failed backend and does NOT prove
    // the origin skipped creating the comment. Treated as unknown, not as a
    // refusal, so the claim is held rather than released for retry. Only a 4xx
    // is evidence that nothing was written.
    const detail = await response.text().catch(() => '');
    throw new PlatformUnreachable(
      `${new URL(url).host} answered HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ''}; whether the write landed is unknown`
    );
  }

  if (response.status === 408) {
    // "I stopped waiting", not "I did not write it".
    throw new PlatformUnreachable(
      `${new URL(url).host} answered HTTP 408; whether the write landed is unknown`
    );
  }

  if (response.status < 200 || response.status > 299) {
    const detail = await response.text().catch(() => '');
    throw new PlatformRejection(
      `HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`,
      response.status
    );
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    // A 2xx we cannot parse still means the write happened.
    throw new PlatformUnreachable(
      `${new URL(url).host} accepted the write but returned an unreadable body`
    );
  }
  // `null` parses fine and is not indexable, so reading `.id` off it throws a
  // bare TypeError -- which the caller would classify as "nothing published"
  // and RELEASE the claim on a write the platform answered 2xx for. Anything
  // that is not an object is an unknown outcome, never a refusal.
  if (parsed === null || typeof parsed !== 'object') {
    throw new PlatformUnreachable(
      `${new URL(url).host} accepted the write but returned an unreadable body`
    );
  }
  return parsed as Record<string, unknown>;
}

const WRITE_TIMEOUT_MS = 15_000;

/**
 * The guarded client for WRITES. Not `scoutClient`.
 *
 * `createSsrfFetch` follows redirects by re-issuing `{ ...init }`, which for a
 * POST re-sends the method AND the body on every hop -- so one approved comment
 * becomes up to `maxRedirects` identical comments, all inside a single claim
 * and therefore invisible to the replay guard. GitHub answers 301 on the REST
 * API for a renamed repo, so this needs no attacker.
 *
 * A write must never be replayed to a destination we did not address, so the
 * budget is zero: at most one request leaves, and a redirect surfaces as an
 * `SsrfError` that `postJson` converts to `PlatformUnreachable`, holding the
 * claim. `control-plane/execution.ts` reaches the same conclusion with
 * `redirect: 'error'` on its own write path.
 */
function writeClient(fetchImpl?: FetchLike): FetchLike {
  return createSsrfFetch({ resolve: fetchImpl === undefined, fetchImpl, maxRedirects: 0 });
}

type ReplyPublisher = (
  payload: CommunityReplyPayload,
  options: { credentials: CredentialAccessor; client: FetchLike }
) => Promise<PublishOutcome>;

/**
 * Platforms with a documented API for replying to SOMEONE ELSE'S thread.
 *
 * Deliberately short. Everything absent from this map is a manual handoff, and
 * the reason is a fact about the platform, not a gap in this file:
 * - hackernews    -- no write API of any kind.
 * - devto         -- publishes articles; exposes no comment endpoint.
 * - lobsters      -- no write API.
 * - stackoverflow -- the Stack Exchange write API does not cover answers.
 * - reddit        -- has one, and is `prepare-only` by policy. Gate 1 stops it.
 * - linkedin      -- disabled outright; see scouts/linkedin.ts.
 */
/** A reply's approved URL must identify the GitHub thread itself, not merely
 * contain the text `github.com/` in an unrelated host, query or pathname.
 * Reject extra segments and ambiguous encoded components before reserving any
 * posting capacity. The REST API uses issues/{number}/comments for both issue
 * and pull-request conversation comments.
 */
function githubReplyTarget(value: string): { owner: string; repo: string; number: string } {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('GitHub reply requires a valid HTTPS github.com issue or pull URL.');
  }
  if (
    url.protocol !== 'https:' ||
    !['github.com', 'www.github.com'].includes(url.hostname) ||
    url.port ||
    url.username ||
    url.password
  ) {
    throw new Error('GitHub reply requires an HTTPS github.com issue or pull URL.');
  }
  const match = /^\/([a-zA-Z0-9-]+)\/([a-zA-Z0-9_.-]+)\/(?:issues|pull)\/([1-9][0-9]*)\/?$/.exec(
    url.pathname
  );
  if (!match) throw new Error('GitHub reply URL must name exactly one issue or pull request.');
  return { owner: match[1], repo: match[2], number: match[3] };
}

const REPLY_PUBLISHERS: Readonly<Record<string, ReplyPublisher>> = {
  async github(payload, { credentials, client }) {
    const { owner, repo, number } = githubReplyTarget(payload.threadUrl);
    const token = credentials.get('GITHUB_TOKEN');
    if (!token) throw new Error('GITHUB_TOKEN is required to post a GitHub comment.');

    const result = await postJson(
      client,
      `https://api.github.com/repos/${owner}/${repo}/issues/${number}/comments`,
      {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json'
      },
      JSON.stringify({ body: payload.body })
    );
    if (!result.id)
      throw new PlatformUnreachable('GitHub accepted the comment but returned no id.');
    return { provider: 'github', externalRef: String(result.html_url ?? result.id) };
  },

  async mastodon(payload, { credentials, client }) {
    const token = credentials.get('MASTODON_ACCESS_TOKEN');
    if (!token) throw new Error('MASTODON_ACCESS_TOKEN is required to post a Mastodon reply.');
    const instance = (
      credentials.get('MASTODON_INSTANCE_URL') ?? 'https://mastodon.social'
    ).replace(/\/+$/, '');

    const result = await postJson(
      client,
      `${instance}/api/v1/statuses`,
      {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        // Mastodon's own replay guard, on top of ours.
        'Idempotency-Key': payload.threadExternalId
      },
      JSON.stringify({
        status: payload.body,
        in_reply_to_id: payload.threadExternalId,
        visibility: 'public'
      })
    );
    if (!result.id)
      throw new PlatformUnreachable('Mastodon accepted the status but returned no id.');
    return { provider: 'mastodon', externalRef: String(result.url ?? result.id) };
  }
};

/**
 * Throw if posting now would breach the daily cap or a live community cooldown.
 *
 * Time-varying limits only. An approval is a decision about CONTENT; these two
 * are facts about the clock, and the clock moves after the founder clicks.
 */
export async function assertPostingWindow(
  db: Db,
  workspaceId: string,
  platform: string,
  community: string | null,
  now: Date
): Promise<void> {
  const limits = limitsFor(platform);
  const postsToday = await countPostsToday(db, workspaceId, platform, now);
  if (postsToday >= limits.maxPostsPerDay) {
    throw new Error(
      `Daily cap reached for ${platform}: ${postsToday} of ${limits.maxPostsPerDay} posts used in the last 24 hours. The approval is still valid; re-run the action once the window clears.`
    );
  }
  if (community) {
    const last = await lastPostInCommunity(db, workspaceId, platform, community);
    if (last) {
      const hoursSince = (now.getTime() - last.getTime()) / 3_600_000;
      if (hoursSince < limits.cooldownHours) {
        throw new Error(
          `Cooldown active for ${community}: last post was ${hoursSince.toFixed(1)}h ago and ${limits.cooldownHours}h is required.`
        );
      }
    }
  }
}

/** Why this reply cannot be delivered by Trevra, or null when it can. */
export function handoffReason(platform: string): string | null {
  const channel = getChannel(platform);
  if (!channel)
    return `No channel adapter is registered for '${platform}', so Trevra has no policy statement permitting it to post there.`;
  if (channel.automation.mode !== 'api-publish')
    return `${channel.name} is ${channel.automation.mode}: ${channel.automation.reason}`;
  if (!REPLY_PUBLISHERS[platform])
    return `${channel.name} publishes your own posts but exposes no API for replying to someone else's thread.`;
  return null;
}

/**
 * Deliver, or record the handoff. Never throws for a policy decision -- only
 * for a platform that accepted the request and then failed it.
 */
/**
 * A prepared approval proves exact content, but it is not an exemption from a
 * workspace rule added while that approval was queued. Re-evaluate restrictive
 * policies at the last safe handoff/provider boundary. The playbook engine
 * verifies exact-payload approval before this adapter; a require_approval
 * decision here is not a new approval mechanism.
 */
async function assertCommunityReplyNotDenied(
  db: Db,
  workspaceId: string,
  options: PublishOptions
): Promise<void> {
  const policy = await evaluatePolicy(db, {
    workspaceId,
    action: 'action:community.reply',
    actorType: options.actorType ?? 'system',
    actorId: options.actorId,
    playbookId: options.playbookId,
    sideEffect: 'external-write',
    environment: process.env.NODE_ENV ?? 'development',
    attributes: { recipients: 1 }
  });
  if (policy.effect === 'deny') {
    throw new Error(
      `Workspace policy denies community reply: ${policy.policyName}; nothing posted or handed off.`
    );
  }
}

export async function publishCommunityReply(
  db: Db,
  workspaceId: string,
  payload: CommunityReplyPayload,
  payloadHash: string,
  now: Date,
  options: PublishOptions = {}
): Promise<
  PublishOutcome & { status: 'posted' | 'manual_handoff'; postId: string; duplicate: boolean }
> {
  const credentials = options.credentials ?? envCredentials;
  const community = payload.community?.trim() ? payload.community.trim() : null;
  const base = {
    workspaceId,
    platform: payload.platform,
    community,
    threadExternalId: payload.threadExternalId,
    threadUrl: payload.threadUrl,
    payloadHash,
    body: payload.body
  };

  // ORDER MATTERS, and it is: safety decision -> replay guard -> time-varying
  // limits -> handoff-or-post. The handoff branch used to run first, which
  // skipped the replay guard and the cap entirely.

  // Gate 0. The safety verdict travels inside the hash-approved payload, so a
  // blocked reply cannot be posted even by a playbook that omits the guard
  // step or by a hand-built action. Absent means blocked: fail closed.
  if (payload.metadata?.safetyAllowed !== true) {
    throw new Error(
      `Refusing to post to ${payload.platform}: the approved payload does not carry a passing safety verdict (metadata.safetyAllowed !== true).`
    );
  }
  // Invalid GitHub URLs must not create a pending claim, consume a daily quota
  // or resolve to an unintended real GitHub thread during provider dispatch.
  if (payload.platform === 'github') githubReplyTarget(payload.threadUrl);
  await assertCommunityReplyNotDenied(db, workspaceId, options);

  // A window check followed by an independent claim lets different workers
  // pass the final daily-cap/cooldown check simultaneously. Serialize the
  // capacity decision and reservation by workspace+platform. Both pending
  // (unknown/in-flight) and posted/handoff rows consume capacity; a confirmed
  // provider refusal releases its slot via status='failed'. Never hold this
  // transaction across a provider call.
  const reservation = await db.transaction(async (tx) => {
    await tx
      .prepare('SELECT pg_advisory_xact_lock(hashtextextended(?,0))')
      .get(`outreach-post-window:${workspaceId}:${payload.platform}`);

    const previous = await existingPost(tx, workspaceId, payloadHash);
    if (previous) return { kind: 'existing' as const, previous };

    await assertCommunityReplyNotDenied(tx, workspaceId, options);

    // The exact-payload replay guard is not a thread-level stop: approving
    // different wording produces a different hash for the same recipient.
    // This query and the claim share the workspace/platform advisory lock, so
    // two concurrent differently worded approvals cannot both slip through.
    const githubTarget =
      payload.platform === 'github' ? githubReplyTarget(payload.threadUrl) : null;
    const canonicalUrl = githubTarget
      ? `https://github.com/${githubTarget.owner.toLowerCase()}/${githubTarget.repo.toLowerCase()}/issues/${githubTarget.number}`
      : null;
    const priorThread = await existingPostForThread(
      tx,
      workspaceId,
      payload.platform,
      payload.threadExternalId,
      canonicalUrl
    );
    if (priorThread)
      throw new Error(
        `This ${payload.platform} thread already has a ${priorThread.status} reply or manual handoff (post ${priorThread.id}); inspect and resolve it rather than sending another message.`
      );

    await assertPostingWindow(tx, workspaceId, payload.platform, community, now);
    const reason = handoffReason(payload.platform);
    const claim = await recordPost(
      tx,
      {
        ...base,
        status: reason ? 'manual_handoff' : 'pending',
        provider: reason ? 'manual-handoff' : null,
        externalRef: reason ? payload.threadUrl : null,
        error: null
      },
      now
    );
    return { kind: 'claimed' as const, claim, reason };
  });
  if (reservation.kind === 'existing') {
    const already = reservation.previous;
    if (already.status === 'pending') {
      throw new Error(
        `A previous execution of this approved payload for ${payload.threadUrl} is unresolved (post ${already.id}); its outcome is unknown. Check the thread and settle post ${already.id} by hand rather than retrying.`
      );
    }
    return {
      provider: already.provider ?? 'manual-handoff',
      externalRef: already.external_ref ?? payload.threadUrl,
      status: already.status === 'posted' ? 'posted' : 'manual_handoff',
      postId: already.id,
      duplicate: true
    };
  }

  const { claim, reason } = reservation;
  if (claim.duplicate) {
    throw new Error(
      `Another execution already claimed this approved payload for ${payload.threadUrl} (post ${claim.id}); not posting a second time.`
    );
  }
  if (reason) {
    return {
      provider: 'manual-handoff',
      externalRef: payload.threadUrl,
      status: 'manual_handoff',
      postId: claim.id,
      duplicate: false
    };
  }

  // Provider effects begin only after the transaction has committed the
  // pending claim. If the response is lost, the unique claim blocks retries.

  const publisher = REPLY_PUBLISHERS[payload.platform];
  let outcome: PublishOutcome;
  try {
    // A previous action approval is not a standing override of a newly added
    // deny rule. Check again after claim but before the first external request.
    await assertCommunityReplyNotDenied(db, workspaceId, options);
    outcome = await publisher(payload, { credentials, client: writeClient(options.fetchImpl) });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (cause instanceof PlatformUnreachable) {
      // Outcome genuinely unknown. HOLD the claim so no retry can duplicate the
      // comment, and tell the operator to check the thread by hand.
      await settlePost(db, claim.id, {
        status: 'pending',
        provider: null,
        externalRef: null,
        error: message
      });
      throw new Error(
        `Posting the approved reply to ${payload.platform} did not complete and its outcome is unknown: ${message}. The payload is held so a retry cannot double-post -- check ${payload.threadUrl} and settle post ${claim.id} by hand.`
      );
    }
    // The platform answered and refused, so nothing was published. Release the
    // claim ('failed' is excluded from the index) and let the engine retry.
    await settlePost(db, claim.id, {
      status: 'failed',
      provider: null,
      externalRef: null,
      error: message
    });
    throw new Error(`Posting the approved reply to ${payload.platform} failed: ${message}`);
  }

  // SETTLED OUTSIDE THE TRY, DELIBERATELY. The comment is public by this point.
  // If this UPDATE were inside the catch's reach, a pool blip here would write
  // 'failed', release the claim, and the engine's next retry would post a
  // SECOND comment. Letting it throw leaves the row 'pending' -- the claim
  // stands, no retry can duplicate, and the operator settles it by hand.
  await settlePost(db, claim.id, {
    status: 'posted',
    provider: outcome.provider,
    externalRef: outcome.externalRef,
    error: null
  });
  return { ...outcome, status: 'posted', postId: claim.id, duplicate: false };
}
