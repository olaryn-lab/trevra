/**
 * TRV-040: the rich-content support matrix.
 *
 * ONE TABLE, READ BY EVERY SURFACE. Rows are the channels Trevra writes
 * through; columns are the five kinds of rich content an operator might try to
 * send. Each cell says what happens to that content on that channel today:
 *
 *   supported    -- it is attached and sent as an attachment.
 *   link_only    -- the channel has no attachment surface Trevra drives; put a
 *                   link to the file in the text instead. An attachment is
 *                   REFUSED, never quietly stripped.
 *   unsupported  -- the channel cannot carry it in any form Trevra controls.
 *
 * The values describe the code as it is, not LinkedIn's marketing page. The
 * DM/InMail row is what `uploadComposerAttachment` in driver.ts can verify
 * (a file input, a preview, a 10 MB ceiling); voice notes are recorded in the
 * LinkedIn mobile app and the desktop driver cannot produce one; no driver
 * path uploads video. Posts are what `posts.ts` stores and `driver-post`
 * publishes. Every other channel sends text only.
 *
 * The server enforces this at every write path that accepts attachments and
 * again at the send boundary; the client renders the same table so an
 * operator never builds a step the server will refuse. Changing a cell here
 * changes all three at once, which is the point.
 */

export const RICH_CONTENT_TYPES = ['image', 'gif', 'video', 'voice', 'document'] as const;
export type RichContentType = (typeof RICH_CONTENT_TYPES)[number];

export const RICH_CONTENT_SUPPORT = ['supported', 'link_only', 'unsupported'] as const;
export type RichContentSupport = (typeof RICH_CONTENT_SUPPORT)[number];

/** Stable refusal codes. Clients branch on these; the reason is for people. */
export const RICH_CONTENT_CODES = [
  'content_type_unsupported',
  'attachment_too_large',
  'too_many_attachments'
] as const;
export type RichContentCode = (typeof RICH_CONTENT_CODES)[number];

export const RICH_CONTENT_CHANNELS = [
  'linkedin_message',
  'linkedin_inmail',
  'linkedin_invite_note',
  'linkedin_reply',
  'linkedin_group_message',
  'linkedin_event_message',
  'linkedin_post',
  'email',
  'community_reply',
  'buffer_draft'
] as const;
export type RichContentChannel = (typeof RICH_CONTENT_CHANNELS)[number];

export interface RichContentCell {
  support: RichContentSupport;
  reason: string;
}

export interface RichContentChannelSpec {
  label: string;
  /** Attachments one message/post may carry. 0 = the channel takes none. */
  maxCount: number;
  /** Per-attachment ceiling in bytes. 0 when the channel takes none. */
  maxBytes: number;
  allowedMimeTypes: readonly string[];
  cells: Readonly<Record<RichContentType, RichContentCell>>;
}

const MB = 1024 * 1024;

/** driver.ts `MAX_ATTACHMENT_BYTES`: the composer download ceiling. */
export const LINKEDIN_MESSAGE_ATTACHMENT_MAX_BYTES = 10 * MB;
export const LINKEDIN_MESSAGE_ATTACHMENT_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'application/pdf'
] as const;

const voiceNotes: RichContentCell = {
  support: 'unsupported',
  reason:
    'LinkedIn voice messages can only be recorded in the LinkedIn mobile app; the desktop driver cannot send one.'
};

const composerRow = (label: string): RichContentChannelSpec => ({
  label,
  maxCount: 1,
  maxBytes: LINKEDIN_MESSAGE_ATTACHMENT_MAX_BYTES,
  allowedMimeTypes: LINKEDIN_MESSAGE_ATTACHMENT_TYPES,
  cells: {
    image: {
      support: 'supported',
      reason:
        'PNG or JPEG uploaded through the composer file input; sent only after the preview appears.'
    },
    gif: {
      support: 'supported',
      reason: 'Uploaded as a .gif file through the composer; LinkedIn renders it inline.'
    },
    document: {
      support: 'supported',
      reason: 'PDF uploaded through the composer file input; sent only after the preview appears.'
    },
    video: {
      support: 'unsupported',
      reason:
        'The driver has no verified video upload for LinkedIn messages. Put a link to the hosted video in the message text.'
    },
    voice: voiceNotes
  }
});

const textOnlyRow = (
  label: string,
  why: string,
  voice: RichContentCell = voiceNotes
): RichContentChannelSpec => {
  const linkOnly: RichContentCell = {
    support: 'link_only',
    reason: `${why} Put a link to the file in the text instead.`
  };
  return {
    label,
    maxCount: 0,
    maxBytes: 0,
    allowedMimeTypes: [],
    cells: {
      image: linkOnly,
      gif: linkOnly,
      document: linkOnly,
      video: linkOnly,
      voice
    }
  };
};

export const RICH_CONTENT_MATRIX: Readonly<Record<RichContentChannel, RichContentChannelSpec>> = {
  linkedin_message: composerRow('LinkedIn message'),
  linkedin_inmail: composerRow('LinkedIn InMail'),
  linkedin_invite_note: textOnlyRow(
    'LinkedIn invitation note',
    'An invitation carries a plain-text note of up to 300 characters and no attachment.'
  ),
  linkedin_reply: textOnlyRow(
    'LinkedIn inbox reply',
    'Thread replies are typed as text; the reply driver has no attachment step.'
  ),
  linkedin_group_message: textOnlyRow(
    'LinkedIn group message',
    'The group message driver sends text only.'
  ),
  linkedin_event_message: textOnlyRow(
    'LinkedIn event message',
    'The event message driver sends text only.'
  ),
  linkedin_post: {
    label: 'LinkedIn post',
    maxCount: 9,
    maxBytes: 10 * MB,
    allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
    cells: {
      image: {
        support: 'supported',
        reason: 'JPEG, PNG or WebP stored with the post and uploaded when it publishes.'
      },
      gif: {
        support: 'supported',
        reason: 'GIF stored with the post and uploaded when it publishes.'
      },
      document: {
        support: 'unsupported',
        reason: 'The post publisher has no document (carousel PDF) upload path.'
      },
      video: { support: 'unsupported', reason: 'The post publisher has no video upload path.' },
      voice: { support: 'unsupported', reason: 'LinkedIn posts have no voice format.' }
    }
  },
  email: textOnlyRow(
    'Email',
    'Campaign and prepared email send the subject and body through the connected mailbox without attachments.',
    {
      support: 'unsupported',
      reason: 'Email has no voice-message format; Trevra sends the subject and body as text.'
    }
  ),
  community_reply: textOnlyRow(
    'Community reply',
    'Community replies are posted as text through the platform connector.',
    {
      support: 'unsupported',
      reason: 'Community connectors post text; none of them carries a voice message.'
    }
  ),
  buffer_draft: {
    label: 'Buffer draft',
    maxCount: 0,
    maxBytes: 0,
    allowedMimeTypes: [],
    cells: Object.fromEntries(
      RICH_CONTENT_TYPES.map((type) => [
        type,
        {
          support: 'unsupported',
          reason:
            'Trevra creates text-only Buffer drafts; remove the media here and add it in Buffer before publishing.'
        }
      ])
    ) as Record<RichContentType, RichContentCell>
  }
};

export const RICH_CONTENT_TYPE_LABELS: Readonly<Record<RichContentType, string>> = {
  image: 'Image',
  gif: 'GIF',
  video: 'Video',
  voice: 'Voice',
  document: 'Document'
};

export const RICH_CONTENT_SUPPORT_LABELS: Readonly<Record<RichContentSupport, string>> = {
  supported: 'Supported',
  link_only: 'Link only',
  unsupported: 'Unsupported'
};

/* ---------------------------------------------------------------------------
 * Classification.
 * ------------------------------------------------------------------------ */

const EXTENSION_MIME: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  heic: 'image/heic',
  svg: 'image/svg+xml',
  mp4: 'video/mp4',
  m4v: 'video/x-m4v',
  mov: 'video/quicktime',
  webm: 'video/webm',
  avi: 'video/x-msvideo',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/opus',
  aac: 'audio/aac',
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  txt: 'text/plain',
  csv: 'text/csv',
  zip: 'application/zip'
};

/** Lower-cased MIME without parameters; null for empty or the opaque default. */
export function normalizeMimeType(value: string | null | undefined): string | null {
  const mime = String(value ?? '')
    .split(';')[0]!
    .trim()
    .toLowerCase();
  return mime && mime !== 'application/octet-stream' && mime.includes('/') ? mime : null;
}

/** MIME implied by a file name or URL path extension, or null when there is none. */
export function mimeTypeFromName(value: string | null | undefined): string | null {
  let path = String(value ?? '').trim();
  if (!path) return null;
  try {
    path = new URL(path).pathname;
  } catch {
    /* a bare file name */
  }
  const match = /\.([a-z0-9]{1,5})$/i.exec(path.split(/[?#]/)[0]!);
  return match ? (EXTENSION_MIME[match[1]!.toLowerCase()] ?? null) : null;
}

export function contentTypeOfMime(mime: string): RichContentType {
  if (mime === 'image/gif') return 'gif';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'voice';
  return 'document';
}

export interface RichAttachmentInput {
  url?: string | null;
  name?: string | null;
  mimeType?: string | null;
  sizeBytes?: number | null;
  mediaKind?: string | null;
}

export interface ClassifiedAttachment {
  type: RichContentType;
  /** Null when nothing on the input names a type; the send boundary checks the real bytes. */
  mimeType: string | null;
}

/**
 * What kind of content an attachment is. A declared voice note is voice
 * whatever its file says (the operator asked for a voice message, which no
 * driver can send). Otherwise the file decides: declared MIME, then the name's
 * extension, then the URL's. A GIF-marked attachment with no recognisable file
 * is a GIF; any other unnamed file is a document whose MIME the driver checks
 * against the downloaded bytes before upload.
 */
export function classifyAttachment(input: RichAttachmentInput): ClassifiedAttachment {
  const mimeType =
    normalizeMimeType(input.mimeType) ??
    mimeTypeFromName(input.name) ??
    mimeTypeFromName(input.url);
  if (input.mediaKind === 'voice') return { type: 'voice', mimeType };
  if (mimeType) return { type: contentTypeOfMime(mimeType), mimeType };
  return { type: input.mediaKind === 'gif' ? 'gif' : 'document', mimeType: null };
}

/* ---------------------------------------------------------------------------
 * Validation.
 * ------------------------------------------------------------------------ */

export interface RichContentViolation {
  code: RichContentCode;
  /** Null when the step or action kind sends no message at all. */
  channel: RichContentChannel | null;
  contentType: RichContentType | null;
  /** Position of the offending attachment; null for a count refusal. */
  index: number | null;
  reason: string;
}

function megabytes(bytes: number): string {
  return `${Math.round((bytes / MB) * 10) / 10} MB`;
}

function mimeList(spec: RichContentChannelSpec): string {
  const names = spec.allowedMimeTypes.map((mime) =>
    mime === 'application/pdf' ? 'PDF' : mime.replace(/^image\//, '').toUpperCase()
  );
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} or ${names.at(-1)}` : names.join('');
}

/**
 * The first way these attachments break the channel's row, or null when they
 * fit. Each attachment is checked for type, then MIME, then size; the count is
 * checked after every attachment is individually admissible, so a text-only
 * channel answers with the cell's own reason rather than "too many".
 */
export function checkRichContent(
  channel: RichContentChannel,
  attachments: readonly RichAttachmentInput[]
): RichContentViolation | null {
  const spec = RICH_CONTENT_MATRIX[channel];
  for (const [index, attachment] of attachments.entries()) {
    const { type, mimeType } = classifyAttachment(attachment);
    const cell = spec.cells[type];
    if (cell.support !== 'supported')
      return {
        code: 'content_type_unsupported',
        channel,
        contentType: type,
        index,
        reason: `${RICH_CONTENT_TYPE_LABELS[type]} attachments are ${
          cell.support === 'link_only' ? 'link-only' : 'not supported'
        } on ${spec.label}: ${cell.reason}`
      };
    if (mimeType && !spec.allowedMimeTypes.includes(mimeType))
      return {
        code: 'content_type_unsupported',
        channel,
        contentType: type,
        index,
        reason: `${spec.label} accepts ${mimeList(spec)} attachments; ${mimeType} is not one of them.`
      };
    if (
      typeof attachment.sizeBytes === 'number' &&
      Number.isFinite(attachment.sizeBytes) &&
      attachment.sizeBytes > spec.maxBytes
    )
      return {
        code: 'attachment_too_large',
        channel,
        contentType: type,
        index,
        reason: `${spec.label} attachments must be ${megabytes(spec.maxBytes)} or smaller; this one is ${attachment.sizeBytes} bytes.`
      };
  }
  if (attachments.length > spec.maxCount)
    return {
      code: 'too_many_attachments',
      channel,
      contentType: null,
      index: null,
      reason: `${spec.label} takes at most ${spec.maxCount} attachment${spec.maxCount === 1 ? '' : 's'}; ${attachments.length} were given.`
    };
  return null;
}

/* ---------------------------------------------------------------------------
 * Mapping the product's own shapes onto the matrix.
 * ------------------------------------------------------------------------ */

/** Workflow step action -> channel; null for a step that sends no content. */
export function richContentChannelForStepAction(action: string): RichContentChannel | null {
  switch (action) {
    case 'connection_request':
      return 'linkedin_invite_note';
    case 'message':
      return 'linkedin_message';
    case 'inmail':
      return 'linkedin_inmail';
    case 'email':
      return 'email';
    case 'group_message':
      return 'linkedin_group_message';
    case 'event_message':
      return 'linkedin_event_message';
    default:
      return null;
  }
}

/** `linkedin_actions.kind` -> channel; null for a kind that carries no message. */
export function richContentChannelForActionKind(kind: string): RichContentChannel | null {
  switch (kind) {
    case 'dm':
      return 'linkedin_message';
    case 'inmail':
      return 'linkedin_inmail';
    case 'invite':
      return 'linkedin_invite_note';
    case 'reply':
      return 'linkedin_reply';
    case 'group_message':
      return 'linkedin_group_message';
    case 'event_message':
      return 'linkedin_event_message';
    default:
      return null;
  }
}

export interface RichContentVariantLike {
  id?: string;
  attachmentUrl?: string | null;
  attachmentName?: string | null;
  mediaKind?: string | null;
}

/**
 * The attachments a workflow variant asks for. A declared voice note counts
 * even without a URL: it is a request for content no driver can send, and
 * ignoring it would be the silent drop this module exists to prevent.
 */
export function variantAttachments(variant: RichContentVariantLike): RichAttachmentInput[] {
  if (variant.attachmentUrl)
    return [
      {
        url: variant.attachmentUrl,
        name: variant.attachmentName ?? null,
        mediaKind: variant.mediaKind ?? 'file'
      }
    ];
  if (variant.mediaKind === 'voice') return [{ mediaKind: 'voice' }];
  return [];
}

export interface RichContentStepLike {
  id: string;
  action: string;
  config?: unknown;
}

export interface StepRichContentViolation extends RichContentViolation {
  stepId: string;
  variantId: string | null;
}

function stepVariants(step: RichContentStepLike): RichContentVariantLike[] {
  const config = step.config;
  if (!config || typeof config !== 'object') return [];
  const variants = (config as { variants?: unknown }).variants;
  return Array.isArray(variants)
    ? variants.filter((v): v is RichContentVariantLike => Boolean(v) && typeof v === 'object')
    : [];
}

/** The first variant attachment in these steps the matrix refuses, or null. */
export function workflowRichContentViolation(
  steps: readonly RichContentStepLike[]
): StepRichContentViolation | null {
  for (const step of steps) {
    for (const variant of stepVariants(step)) {
      const violation = variantRichContentViolation(step.action, variant);
      if (violation) return { ...violation, stepId: step.id, variantId: variant.id ?? null };
    }
  }
  return null;
}

/** One variant of one step against the matrix. */
export function variantRichContentViolation(
  action: string,
  variant: RichContentVariantLike
): RichContentViolation | null {
  const attachments = variantAttachments(variant);
  if (attachments.length === 0) return null;
  const channel = richContentChannelForStepAction(action);
  if (!channel)
    return {
      code: 'content_type_unsupported',
      channel: null,
      contentType: classifyAttachment(attachments[0]!).type,
      index: 0,
      reason: `A ${action} step sends no message, so it cannot carry an attachment.`
    };
  return checkRichContent(channel, attachments);
}

/**
 * A stored `linkedin_actions.attachment_json` against the row's kind. The
 * column holds one object (what the runner writes) or, defensively, an array.
 */
export function actionAttachmentViolation(
  kind: string,
  stored: unknown
): RichContentViolation | null {
  let attachment = stored;
  if (typeof attachment === 'string') {
    try {
      attachment = JSON.parse(attachment) as unknown;
    } catch {
      // Unreadable is not "none": sending the text alone would drop it.
      return {
        code: 'content_type_unsupported',
        channel: richContentChannelForActionKind(kind),
        contentType: null,
        index: 0,
        reason: 'The stored attachment cannot be read, so it cannot be checked or sent.'
      };
    }
  }
  const items = (Array.isArray(attachment) ? attachment : attachment ? [attachment] : []).filter(
    (item): item is Record<string, unknown> =>
      Boolean(item) && typeof item === 'object' && Object.keys(item as object).length > 0
  );
  if (items.length === 0) return null;
  const inputs = items.map(richInputOf);
  const channel = richContentChannelForActionKind(kind);
  if (!channel)
    return {
      code: 'content_type_unsupported',
      channel: null,
      contentType: classifyAttachment(inputs[0]!).type,
      index: 0,
      reason: `A LinkedIn ${kind} action sends no message, so it cannot carry an attachment.`
    };
  return checkRichContent(channel, inputs);
}

function richInputOf(item: unknown): RichAttachmentInput {
  if (typeof item === 'string') return { url: item };
  if (!item || typeof item !== 'object') return {};
  const record = item as Record<string, unknown>;
  const text = (key: string) => (typeof record[key] === 'string' ? (record[key] as string) : null);
  const size = record.sizeBytes ?? record.size;
  return {
    url: text('url'),
    name: text('name') ?? text('filename'),
    mimeType: text('mimeType') ?? text('contentType'),
    sizeBytes: typeof size === 'number' ? size : null,
    mediaKind: text('mediaKind')
  };
}

const PAYLOAD_ATTACHMENT_KEYS = ['attachments', 'attachment', 'media', 'images', 'files'] as const;

/**
 * A prepared external-write payload (email, community reply, Buffer draft)
 * that names attachments under any of the usual keys, against its channel.
 * Every such channel is text-only today, so any attachment is refused here
 * rather than stripped by a schema that does not know the key.
 */
export function payloadAttachmentViolation(
  channel: RichContentChannel,
  payload: unknown
): RichContentViolation | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  const items = PAYLOAD_ATTACHMENT_KEYS.flatMap((key) => {
    const value = record[key];
    if (value == null || value === '') return [];
    return Array.isArray(value) ? value : [value];
  });
  return items.length ? checkRichContent(channel, items.map(richInputOf)) : null;
}

/* ---------------------------------------------------------------------------
 * Rendering. The docs page and the in-app help table are both generated here.
 * ------------------------------------------------------------------------ */

export function richContentLimitsSummary(channel: RichContentChannel): string {
  const spec = RICH_CONTENT_MATRIX[channel];
  if (spec.maxCount === 0) return 'No attachments';
  return `Up to ${spec.maxCount} × ${megabytes(spec.maxBytes)}; ${mimeList(spec)}`;
}

export function richContentMarkdownTable(): string {
  const header = `| Channel | ${RICH_CONTENT_TYPES.map((t) => RICH_CONTENT_TYPE_LABELS[t]).join(' | ')} | Limits |`;
  const rule = `|${' --- |'.repeat(RICH_CONTENT_TYPES.length + 2)}`;
  const rows = RICH_CONTENT_CHANNELS.map((channel) => {
    const spec = RICH_CONTENT_MATRIX[channel];
    const cells = RICH_CONTENT_TYPES.map((type) => spec.cells[type].support);
    return `| ${spec.label} (\`${channel}\`) | ${cells.join(' | ')} | ${richContentLimitsSummary(channel)} |`;
  });
  return [header, rule, ...rows].join('\n');
}

export function richContentMarkdownReasons(): string {
  return RICH_CONTENT_CHANNELS.map((channel) => {
    const spec = RICH_CONTENT_MATRIX[channel];
    const lines = RICH_CONTENT_TYPES.map(
      (type) =>
        `- ${RICH_CONTENT_TYPE_LABELS[type]} -- ${spec.cells[type].support}: ${spec.cells[type].reason}`
    );
    return [`### ${spec.label}`, '', ...lines].join('\n');
  }).join('\n\n');
}

/** The generated section of docs/rich-content.md, between its markers. */
export function richContentMarkdown(): string {
  return [
    richContentMarkdownTable(),
    '',
    '## Why each cell is what it is',
    '',
    richContentMarkdownReasons()
  ].join('\n');
}
