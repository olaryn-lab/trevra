import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  Archive,
  ArchiveRestore,
  History,
  Mail,
  MailOpen,
  Pencil,
  Star,
  Tag,
  Trash2,
  X
} from 'lucide-react';
import {
  addInboxThreadNote,
  bulkOrganizeInbox,
  confirmInboxReplyClass,
  createInboxTag,
  deleteInboxTag,
  deleteInboxThreadNote,
  editInboxThreadNote,
  getInboxNoteRevisions,
  getInboxThreadNotes,
  organizeInboxThread,
  tagInboxThread,
  untagInboxThread,
  type AssignableMember,
  type InboxBulkAction,
  type InboxTag,
  type InboxTagColor,
  type LinkedInThreadRecord,
  type ReplyClass,
  type ReplyClassificationView,
  type ThreadNote,
  type ThreadNoteRevision
} from './api';
import { errorMessage } from './LinkedInSafety';
import { relativeTime } from './LinkedInScreen';
import { ConfirmDrawer } from './ui/dialog';
import { Button, Field, Input, Select, SwitchField, Textarea } from './ui/primitives';
import { plural } from './ui/plural';

/**
 * TRV-036 / TRV-037 controls for `/outreach/inbox`: tags, notes, assignment,
 * star/archive/read, bulk actions, and the reply-class confirmation.
 *
 * Every control here calls the server and then re-reads; nothing is decided in
 * the browser. A suggested reply class is shown as a suggestion and changes
 * nothing until a person confirms it.
 */

/** Mirrors the server's INBOX_BULK_MAX; the server refuses past it regardless. */
export const INBOX_BULK_MAX = 200;

export const TAG_COLORS: ReadonlyArray<{ value: InboxTagColor; label: string }> = [
  { value: 'neutral', label: 'Neutral' },
  { value: 'green', label: 'Green' },
  { value: 'blue', label: 'Blue' },
  { value: 'amber', label: 'Amber' },
  { value: 'red', label: 'Red' }
];

export const REPLY_CLASS_LABELS: Record<ReplyClass, string> = {
  interested: 'Interested',
  not_interested: 'Not interested',
  out_of_office: 'Out of office',
  opt_out: 'Opt-out',
  referral: 'Referral',
  question: 'Question',
  other: 'Other'
};
const REPLY_CLASS_ORDER = Object.keys(REPLY_CLASS_LABELS) as ReplyClass[];

export function replyClassLabel(value: string | null | undefined): string {
  return value && value in REPLY_CLASS_LABELS ? REPLY_CLASS_LABELS[value as ReplyClass] : 'Other';
}

export function tagColorClass(color: string): string {
  return `inbox-tag-${TAG_COLORS.some((entry) => entry.value === color) ? color : 'neutral'}`;
}

const NEW_TAG = '__new__';

/* -------------------------------------------------------------------------
 * One conversation: star, archive, read, assignee, tags.
 * ---------------------------------------------------------------------- */

export function ThreadOrganizePanel({
  thread,
  tags,
  assignees,
  onChanged,
  onTagsChanged,
  setToast
}: {
  thread: LinkedInThreadRecord;
  tags: InboxTag[];
  assignees: AssignableMember[];
  onChanged: () => Promise<void>;
  onTagsChanged: () => Promise<void>;
  setToast: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<InboxTag | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const run = async (work: () => Promise<unknown>, success?: string) => {
    setBusy(true);
    setError('');
    try {
      await work();
      if (success) setToast(success);
      await onChanged();
    } catch (err) {
      setError(errorMessage(err, 'That change was not saved. Nothing was changed.'));
    } finally {
      setBusy(false);
    }
  };

  const onThread = new Set(thread.tags.map((tag) => tag.id));
  const available = tags.filter((tag) => !onThread.has(tag.id));
  const assigneeKnown = assignees.some((member) => member.userId === thread.assignee?.userId);

  return (
    <section className="inbox-org" aria-label="Organize this conversation">
      <div className="inbox-org-row">
        <Button
          variant="ghost"
          aria-pressed={thread.starred}
          disabled={busy}
          onClick={() =>
            void run(() => organizeInboxThread(thread.id, { starred: !thread.starred }))
          }
        >
          <Star
            size={14}
            aria-hidden="true"
            className={thread.starred ? 'inbox-star is-filled' : 'inbox-star'}
          />
          {thread.starred ? 'Starred' : 'Star'}
        </Button>
        <Button
          variant="ghost"
          disabled={busy}
          onClick={() =>
            void run(
              () => organizeInboxThread(thread.id, { archived: !thread.archived }),
              thread.archived
                ? 'Moved back to the inbox.'
                : 'Archived. A new reply brings it back automatically.'
            )
          }
        >
          {thread.archived ? (
            <ArchiveRestore size={14} aria-hidden="true" />
          ) : (
            <Archive size={14} aria-hidden="true" />
          )}
          {thread.archived ? 'Unarchive' : 'Archive'}
        </Button>
        <Button
          variant="ghost"
          disabled={busy}
          onClick={() => void run(() => organizeInboxThread(thread.id, { unread: !thread.unread }))}
        >
          {thread.unread ? (
            <MailOpen size={14} aria-hidden="true" />
          ) : (
            <Mail size={14} aria-hidden="true" />
          )}
          {thread.unread ? 'Mark read' : 'Mark unread'}
        </Button>
        <Select
          aria-label="Assignee"
          className="inbox-org-assignee"
          value={thread.assignee?.userId ?? ''}
          disabled={busy}
          onChange={(event) => {
            const value = event.target.value;
            void run(
              () => organizeInboxThread(thread.id, { assigneeUserId: value || null }),
              value ? 'Assigned.' : 'Unassigned.'
            );
          }}
        >
          <option value="">Unassigned</option>
          {assignees.map((member) => (
            <option key={member.userId} value={member.userId}>
              {member.isMe ? `${member.name} (you)` : member.name}
            </option>
          ))}
          {thread.assignee && !assigneeKnown && (
            <option value={thread.assignee.userId}>{thread.assignee.name}</option>
          )}
        </Select>
      </div>

      <div className="inbox-org-tags" role="group" aria-label="Tags on this conversation">
        {thread.tags.map((tag) => (
          <span key={tag.id} className={`inbox-tag ${tagColorClass(tag.color)}`}>
            <Tag size={12} aria-hidden="true" />
            {tag.name}
            <button
              type="button"
              className="inbox-tag-remove"
              aria-label={`Remove the tag ${tag.name}`}
              disabled={busy}
              onClick={() => void run(() => untagInboxThread(thread.id, tag.id))}
            >
              <X size={13} aria-hidden="true" />
            </button>
          </span>
        ))}
        <Select
          aria-label="Add a tag"
          className="inbox-org-tag-picker"
          value=""
          disabled={busy}
          onChange={(event) => {
            const value = event.target.value;
            if (value === NEW_TAG) setCreating(true);
            else if (value) void run(() => tagInboxThread(thread.id, value));
          }}
        >
          <option value="">Add a tag…</option>
          {available.map((tag) => (
            <option key={tag.id} value={tag.id}>
              {tag.name}
            </option>
          ))}
          <option value={NEW_TAG}>New tag…</option>
        </Select>
      </div>

      {creating && (
        <TagCreateForm
          onCancel={() => setCreating(false)}
          onCreated={async (tag) => {
            setCreating(false);
            await onTagsChanged();
            await run(() => tagInboxThread(thread.id, tag.id), `Tag “${tag.name}” created.`);
          }}
        />
      )}

      {tags.length > 0 && (
        <details className="mgr-inputs inbox-tag-manager">
          <summary>
            Manage tags <span>{plural(tags.length, 'tag')}</span>
          </summary>
          <ul className="inbox-tag-manager-list">
            {tags.map((tag) => (
              <li key={tag.id}>
                <span className={`inbox-tag ${tagColorClass(tag.color)}`}>
                  <Tag size={12} aria-hidden="true" />
                  {tag.name}
                </span>
                <span className="li-hint">{plural(tag.threadCount, 'conversation')}</span>
                <Button
                  variant="danger"
                  onClick={() => {
                    setDeleteError(null);
                    setDeleting(tag);
                  }}
                >
                  <Trash2 size={14} aria-hidden="true" /> Delete
                </Button>
              </li>
            ))}
          </ul>
        </details>
      )}

      {deleting && (
        <ConfirmDrawer
          title={`Delete the tag “${deleting.name}”?`}
          body={`It is removed from ${plural(deleting.threadCount, 'conversation')}. The conversations themselves are not changed.`}
          confirmLabel="Delete this tag"
          tone="danger"
          busy={busy}
          error={deleteError}
          onCancel={() => setDeleting(null)}
          onConfirm={() => {
            void (async () => {
              setBusy(true);
              try {
                const result = await deleteInboxTag(deleting.id);
                setToast(
                  `Tag deleted and removed from ${plural(result.removedAssociations, 'conversation')}.`
                );
                setDeleting(null);
                await onTagsChanged();
                await onChanged();
              } catch (err) {
                setDeleteError(errorMessage(err, 'The tag was not deleted.'));
              } finally {
                setBusy(false);
              }
            })();
          }}
        />
      )}

      {error && (
        <p className="li-hint" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

function TagCreateForm({
  onCreated,
  onCancel
}: {
  onCreated: (tag: InboxTag) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState('');
  const [color, setColor] = useState<InboxTagColor>('neutral');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    setError('');
    try {
      await onCreated(await createInboxTag({ name: name.trim(), color }));
    } catch (err) {
      setError(errorMessage(err, 'The tag was not created.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="inbox-tag-create" onSubmit={(event) => void submit(event)}>
      <Field label="Tag name">
        <Input
          value={name}
          maxLength={40}
          autoFocus
          onChange={(event) => setName(event.target.value)}
        />
      </Field>
      <Field label="Colour">
        <Select value={color} onChange={(event) => setColor(event.target.value as InboxTagColor)}>
          {TAG_COLORS.map((entry) => (
            <option key={entry.value} value={entry.value}>
              {entry.label}
            </option>
          ))}
        </Select>
      </Field>
      <div className="inbox-tag-create-actions">
        <Button type="submit" disabled={saving || !name.trim()}>
          Create and add
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
      </div>
      {error && (
        <p className="li-hint" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

/* -------------------------------------------------------------------------
 * Notes: authored, timestamped, editable by their author, with history.
 * ---------------------------------------------------------------------- */

export function ThreadNotesPanel({
  threadId,
  meUserId,
  setToast
}: {
  threadId: string;
  meUserId: string | null;
  setToast: (message: string) => void;
}) {
  const [notes, setNotes] = useState<ThreadNote[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [draft, setDraft] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [history, setHistory] = useState<{
    noteId: string;
    revisions: ThreadNoteRevision[];
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setNotes(await getInboxThreadNotes(threadId));
      setError('');
    } catch (err) {
      setError(errorMessage(err, 'Unable to read the notes on this conversation.'));
    } finally {
      setLoaded(true);
    }
  }, [threadId]);

  useEffect(() => {
    setLoaded(false);
    setNotes([]);
    setHistory(null);
    setEditingId(null);
    void load();
  }, [load]);

  const run = async (work: () => Promise<unknown>, success: string) => {
    setBusy(true);
    setError('');
    try {
      await work();
      setToast(success);
      await load();
    } catch (err) {
      setError(errorMessage(err, 'That note change was not saved.'));
    } finally {
      setBusy(false);
    }
  };

  const showHistory = async (noteId: string) => {
    if (history?.noteId === noteId) {
      setHistory(null);
      return;
    }
    try {
      setHistory({ noteId, revisions: await getInboxNoteRevisions(noteId) });
    } catch (err) {
      setError(errorMessage(err, 'Unable to read this note’s history.'));
    }
  };

  return (
    <details className="mgr-inputs inbox-notes">
      <summary>
        Notes <span>{loaded ? plural(notes.length, 'note') : 'Reading…'}</span>
      </summary>
      <div className="mgr-inputs-body">
        {notes.length > 0 && (
          <ol className="inbox-note-list">
            {notes.map((note) => {
              const mine = meUserId !== null && note.authorUserId === meUserId;
              return (
                <li key={note.id} className="inbox-note">
                  <div className="inbox-note-head">
                    <strong>{note.authorName ?? 'A former member'}</strong>
                    <span className="li-hint">
                      {relativeTime(note.createdAt)}
                      {note.version > 1 ? ` · edited ${relativeTime(note.updatedAt)}` : ''}
                    </span>
                  </div>
                  {editingId === note.id ? (
                    <form
                      className="inbox-note-edit"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void run(async () => {
                          await editInboxThreadNote(note.id, editDraft);
                          setEditingId(null);
                        }, 'Note updated. The earlier version is kept in its history.');
                      }}
                    >
                      <Field label="Edit note">
                        <Textarea
                          rows={3}
                          maxLength={4000}
                          value={editDraft}
                          onChange={(event) => setEditDraft(event.target.value)}
                        />
                      </Field>
                      <div className="inbox-note-actions">
                        <Button type="submit" disabled={busy || !editDraft.trim()}>
                          Save note
                        </Button>
                        <Button variant="ghost" onClick={() => setEditingId(null)}>
                          Cancel
                        </Button>
                      </div>
                    </form>
                  ) : (
                    <p className="inbox-note-body">{note.body}</p>
                  )}
                  {editingId !== note.id && (
                    <div className="inbox-note-actions">
                      {mine && (
                        <>
                          <Button
                            variant="ghost"
                            disabled={busy}
                            onClick={() => {
                              setEditingId(note.id);
                              setEditDraft(note.body);
                            }}
                          >
                            <Pencil size={14} aria-hidden="true" /> Edit
                          </Button>
                          <Button
                            variant="ghost"
                            disabled={busy}
                            onClick={() =>
                              void run(
                                () => deleteInboxThreadNote(note.id),
                                'Note deleted. Its history is kept.'
                              )
                            }
                          >
                            <Trash2 size={14} aria-hidden="true" /> Delete
                          </Button>
                        </>
                      )}
                      <Button
                        variant="ghost"
                        aria-expanded={history?.noteId === note.id}
                        onClick={() => void showHistory(note.id)}
                      >
                        <History size={14} aria-hidden="true" /> History
                      </Button>
                    </div>
                  )}
                  {history?.noteId === note.id && (
                    <ol className="inbox-note-history" aria-label="Note history">
                      {history.revisions.map((revision) => (
                        <li key={revision.id}>
                          <span className="li-hint">
                            v{revision.version} {revision.action} by{' '}
                            {revision.actorName ?? 'a former member'}{' '}
                            {relativeTime(revision.createdAt)}
                          </span>
                          <p>{revision.body}</p>
                        </li>
                      ))}
                    </ol>
                  )}
                </li>
              );
            })}
          </ol>
        )}
        <form
          className="inbox-note-add"
          onSubmit={(event) => {
            event.preventDefault();
            void run(async () => {
              await addInboxThreadNote(threadId, draft);
              setDraft('');
            }, 'Note added.');
          }}
        >
          <Field label="Add a note" hint="Visible to everyone in this workspace. Never sent.">
            <Textarea
              rows={3}
              maxLength={4000}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
            />
          </Field>
          <div className="inbox-note-actions">
            <Button type="submit" disabled={busy || !draft.trim()}>
              Add note
            </Button>
          </div>
        </form>
        {error && (
          <p className="li-hint" role="alert">
            {error}
          </p>
        )}
      </div>
    </details>
  );
}

/* -------------------------------------------------------------------------
 * TRV-037: the suggested class of the latest inbound message.
 * ---------------------------------------------------------------------- */

export function ReplyClassPanel({
  classification,
  personName,
  onConfirmed,
  setToast
}: {
  classification: ReplyClassificationView;
  personName: string;
  onConfirmed: () => Promise<void>;
  setToast: (message: string) => void;
}) {
  const [choice, setChoice] = useState<ReplyClass>(classification.suggestedClass);
  const [endMembership, setEndMembership] = useState(false);
  const [confirmingOptOut, setConfirmingOptOut] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await confirmInboxReplyClass(classification.messageId, {
        confirmedClass: choice,
        ...(choice === 'not_interested' && endMembership ? { endMembership: true } : {})
      });
      const ended = result.effects.endedMemberIds?.length ?? 0;
      const skipped = result.effects.skippedActionIds?.length ?? 0;
      setToast(
        choice === 'opt_out'
          ? `Opt-out confirmed. ${personName} is suppressed on LinkedIn; ${plural(ended, 'campaign membership')} ended and ${plural(skipped, 'queued action')} skipped.`
          : `Confirmed as ${replyClassLabel(choice)}.${ended ? ` ${plural(ended, 'campaign membership')} ended.` : ''}`
      );
      setConfirmingOptOut(false);
      await onConfirmed();
    } catch (err) {
      setError(errorMessage(err, 'The class was not confirmed. Nothing was changed.'));
    } finally {
      setBusy(false);
    }
  };

  if (classification.status === 'confirmed') {
    return (
      <div className="inbox-class" aria-label="Reply class">
        <span className="li-chip inbox-class-chip is-confirmed">
          {replyClassLabel(classification.confirmedClass)}
        </span>
        <span className="li-hint">
          Confirmed by a person
          {classification.confirmedAt ? ` ${relativeTime(classification.confirmedAt)}` : ''}.
          {classification.confirmedClass !== classification.suggestedClass
            ? ` The rules had suggested ${replyClassLabel(classification.suggestedClass)}.`
            : ''}
        </span>
      </div>
    );
  }

  return (
    <div className="inbox-class" aria-label="Reply class">
      <div className="inbox-class-head">
        <span className="li-chip inbox-class-chip">
          Suggested: {replyClassLabel(classification.suggestedClass)}
        </span>
        <span className="li-hint">
          {Math.round(classification.confidence * 100)}% · {classification.source}
        </span>
      </div>
      <div className="inbox-class-row">
        <Select
          aria-label="Reply class to confirm"
          value={choice}
          disabled={busy}
          onChange={(event) => setChoice(event.target.value as ReplyClass)}
        >
          {REPLY_CLASS_ORDER.map((value) => (
            <option key={value} value={value}>
              {REPLY_CLASS_LABELS[value]}
            </option>
          ))}
        </Select>
        <Button
          disabled={busy}
          onClick={() => (choice === 'opt_out' ? setConfirmingOptOut(true) : void confirm())}
        >
          Confirm as {replyClassLabel(choice)}
        </Button>
      </div>
      {choice === 'not_interested' && (
        <SwitchField
          label="Also end their active campaign membership"
          description="Skips anything still queued for them in a campaign. Off by default."
          checked={endMembership}
          onChange={(event) => setEndMembership(event.target.checked)}
        />
      )}
      <p className="li-hint">
        A suggestion changes nothing. Only a confirmed class acts, and only an opt-out or an ended
        membership stops outreach.
      </p>
      {error && !confirmingOptOut && (
        <p className="li-hint" role="alert">
          {error}
        </p>
      )}
      {confirmingOptOut && (
        <ConfirmDrawer
          title={`Confirm that ${personName} opted out?`}
          body={`Trevra will suppress ${personName} on LinkedIn, end every active campaign membership for them, and skip every queued LinkedIn action to them that has not started. This cannot be undone from the inbox.`}
          confirmLabel="Confirm the opt-out"
          tone="danger"
          busy={busy}
          error={error}
          onCancel={() => setConfirmingOptOut(false)}
          onConfirm={() => void confirm()}
        />
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------
 * Bulk actions on selected conversations, capped at INBOX_BULK_MAX.
 * ---------------------------------------------------------------------- */

const BULK_ACTIONS: ReadonlyArray<{ value: InboxBulkAction; label: string }> = [
  { value: 'archive', label: 'Archive' },
  { value: 'unarchive', label: 'Unarchive' },
  { value: 'mark_read', label: 'Mark read' },
  { value: 'mark_unread', label: 'Mark unread' },
  { value: 'star', label: 'Star' },
  { value: 'unstar', label: 'Unstar' },
  { value: 'tag', label: 'Add a tag' },
  { value: 'untag', label: 'Remove a tag' },
  { value: 'assign', label: 'Assign to' },
  { value: 'unassign', label: 'Unassign' }
];

export function InboxBulkBar({
  selectedIds,
  tags,
  assignees,
  onApplied,
  onClear,
  setToast
}: {
  selectedIds: string[];
  tags: InboxTag[];
  assignees: AssignableMember[];
  onApplied: () => Promise<void>;
  onClear: () => void;
  setToast: (message: string) => void;
}) {
  const [action, setAction] = useState<InboxBulkAction>('archive');
  const [tagId, setTagId] = useState('');
  const [assigneeUserId, setAssigneeUserId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const needsTag = action === 'tag' || action === 'untag';
  const needsAssignee = action === 'assign';
  const overCap = selectedIds.length > INBOX_BULK_MAX;
  const incomplete = (needsTag && !tagId) || (needsAssignee && !assigneeUserId);

  const apply = async () => {
    setBusy(true);
    setError('');
    try {
      const result = await bulkOrganizeInbox({
        threadIds: selectedIds,
        action,
        ...(needsTag ? { tagId } : {}),
        ...(needsAssignee ? { assigneeUserId } : {})
      });
      setToast(
        `${BULK_ACTIONS.find((entry) => entry.value === action)?.label ?? 'Done'}: ${plural(result.selected, 'conversation')}.`
      );
      onClear();
      await onApplied();
    } catch (err) {
      setError(errorMessage(err, 'The bulk action was not applied. Nothing was changed.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="inbox-bulk" role="group" aria-label="Bulk actions on selected conversations">
      <strong aria-live="polite">{selectedIds.length} selected</strong>
      <Select
        aria-label="Bulk action"
        value={action}
        disabled={busy}
        onChange={(event) => setAction(event.target.value as InboxBulkAction)}
      >
        {BULK_ACTIONS.map((entry) => (
          <option key={entry.value} value={entry.value}>
            {entry.label}
          </option>
        ))}
      </Select>
      {needsTag && (
        <Select
          aria-label="Tag"
          value={tagId}
          disabled={busy}
          onChange={(event) => setTagId(event.target.value)}
        >
          <option value="">Choose a tag…</option>
          {tags.map((tag) => (
            <option key={tag.id} value={tag.id}>
              {tag.name}
            </option>
          ))}
        </Select>
      )}
      {needsAssignee && (
        <Select
          aria-label="Assign to"
          value={assigneeUserId}
          disabled={busy}
          onChange={(event) => setAssigneeUserId(event.target.value)}
        >
          <option value="">Choose a member…</option>
          {assignees.map((member) => (
            <option key={member.userId} value={member.userId}>
              {member.isMe ? `${member.name} (you)` : member.name}
            </option>
          ))}
        </Select>
      )}
      <Button disabled={busy || overCap || incomplete} onClick={() => void apply()}>
        Apply to {plural(selectedIds.length, 'conversation')}
      </Button>
      <Button variant="ghost" disabled={busy} onClick={onClear}>
        Clear selection
      </Button>
      {overCap && (
        <p className="li-hint inbox-bulk-note" role="alert">
          Bulk actions are limited to {INBOX_BULK_MAX} conversations at a time; {selectedIds.length}{' '}
          are selected. Narrow the selection first.
        </p>
      )}
      {error && (
        <p className="li-hint inbox-bulk-note" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
