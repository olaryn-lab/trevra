import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { WorkflowStep } from '../server/linkedin/workflows';
import {
  RICH_CONTENT_CHANNELS,
  RICH_CONTENT_MATRIX,
  RICH_CONTENT_TYPES
} from '../shared/rich-content';

// The builder's import graph reaches `auth-client.ts`, which reads
// `window.location.origin` at module scope; nothing here touches the DOM.
(globalThis as { window?: unknown }).window ??= { location: { origin: 'http://localhost' } };
// The shared Select is a listbox that renders its options only while open, so
// static markup would show none of them. It reads them from <option> children
// (value, label, disabled); a native stand-in renders those same children.
vi.mock('./ui/primitives', async (original) => ({
  ...(await original<typeof import('./ui/primitives')>()),
  Select: ({ children, value, ...rest }: { children?: unknown; value?: string }) => (
    <select value={value} onChange={() => undefined} {...rest}>
      {children as never}
    </select>
  )
}));
const { RichContentAttachNote, RichContentHelp } = await import('./RichContentHelp');
const { VariantMediaFields, stepProblems } = await import('./LinkedInManagerWorkflowConfig');

type Variant = Parameters<typeof VariantMediaFields>[0]['variant'];
const noop = () => undefined;
const variant = (extra: Partial<Variant> = {}): Variant =>
  ({ id: 'a', body: 'Hi {{first_name}}', weight: 100, ...extra }) as Variant;
const decode = (html: string) =>
  html
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');

describe('TRV-040 rich-content help table', () => {
  it('renders every matrix cell and limit from the shared module, with no inline style', () => {
    const html = decode(renderToStaticMarkup(<RichContentHelp current="linkedin_message" />));
    expect(html).not.toContain('style=');
    for (const channel of RICH_CONTENT_CHANNELS) {
      const spec = RICH_CONTENT_MATRIX[channel];
      expect(html).toContain(`<th scope="row">${spec.label}</th>`);
    }
    const cells = html.match(/data-support="[a-z_]+"/g) ?? [];
    expect(cells).toHaveLength(RICH_CONTENT_CHANNELS.length * RICH_CONTENT_TYPES.length);
    expect(html).toMatch(
      /<tr class="is-current" aria-current="true"><th scope="row">LinkedIn message</
    );
    // The current channel's refusals are spelled out in the matrix's words.
    expect(html).toContain(RICH_CONTENT_MATRIX.linkedin_message.cells.voice.reason);
    expect(html).toContain(RICH_CONTENT_MATRIX.linkedin_message.cells.video.reason);
  });

  it('shows a disabled, explained attach control on a text-only channel', () => {
    const html = decode(renderToStaticMarkup(<RichContentAttachNote channel="linkedin_reply" />));
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*aria-describedby="([^"]+)"/);
    const describedBy = /aria-describedby="([^"]+)"/.exec(html)![1];
    expect(html).toContain(`id="${describedBy}"`);
    expect(html).toContain(`No attachments on ${RICH_CONTENT_MATRIX.linkedin_reply.label}.`);
    expect(html).toContain(RICH_CONTENT_MATRIX.linkedin_reply.cells.document.reason);
    expect(html).toContain(RICH_CONTENT_MATRIX.linkedin_reply.cells.voice.reason);
    expect(html).not.toContain('style=');
  });
});

describe('TRV-040 variant attach options', () => {
  it('offers what the DM row supports and disables video and voice with the reason', () => {
    const html = decode(
      renderToStaticMarkup(
        <VariantMediaFields variant={variant()} channel="linkedin_message" onPatch={noop} />
      )
    );
    expect(html).toMatch(/<option value="file">Image or document<\/option>/);
    expect(html).toMatch(/<option value="gif">GIF<\/option>/);
    expect(html).toMatch(/<option value="video" disabled="">Video \(unsupported\)<\/option>/);
    expect(html).toMatch(/<option value="voice" disabled="">Voice note \(unsupported\)<\/option>/);
    expect(html).toContain('Up to 1 × 10 MB; PNG, JPEG, GIF or PDF');
    expect(html).toContain(RICH_CONTENT_MATRIX.linkedin_message.cells.voice.reason);
    expect(html).not.toContain('style=');
  });

  it('reveals the URL field once "Image or document" is chosen, before a URL exists', () => {
    const html = renderToStaticMarkup(
      <VariantMediaFields
        variant={variant({ mediaKind: 'file' })}
        channel="linkedin_message"
        onPatch={noop}
      />
    );
    expect(html).toContain('HTTPS file URL');
  });

  it('renders nothing on a text-only channel, but explains and offers to remove a legacy attachment', () => {
    expect(
      renderToStaticMarkup(
        <VariantMediaFields variant={variant()} channel="linkedin_invite_note" onPatch={noop} />
      )
    ).toBe('');
    const html = decode(
      renderToStaticMarkup(
        <VariantMediaFields
          variant={variant({
            attachmentUrl: 'https://cdn.example.test/deck.pdf',
            mediaKind: 'file'
          })}
          channel="linkedin_invite_note"
          onPatch={noop}
        />
      )
    );
    expect(html).toContain(RICH_CONTENT_MATRIX.linkedin_invite_note.cells.document.reason);
    expect(html).toContain('Remove attachment');
    expect(html).not.toContain('HTTPS file URL');
  });
});

describe('TRV-040 step problems mirror the save route', () => {
  const message = (extra: Partial<Variant>) =>
    ({
      id: 'dm',
      action: 'message',
      delayBefore: { amount: 0, unit: 'hours' },
      config: { variants: [variant(extra)] }
    }) as unknown as WorkflowStep;
  const invite = (extra: Partial<Variant>) =>
    ({
      id: 'invite',
      action: 'connection_request',
      delayBefore: { amount: 0, unit: 'hours' },
      config: { variants: [variant(extra)] }
    }) as unknown as WorkflowStep;
  const problems = (step: WorkflowStep) => stepProblems(step, 0, [step]);

  it('accepts a supported DM attachment and flags refused ones with the matrix reason', () => {
    expect(
      problems(message({ attachmentUrl: 'https://cdn.example.test/deck.pdf', mediaKind: 'file' }))
    ).toEqual([]);
    const voice = problems(
      message({ attachmentUrl: 'https://cdn.example.test/note.m4a', mediaKind: 'voice' })
    );
    expect(voice).toHaveLength(1);
    expect(voice[0]).toMatch(/^Variant A: Voice attachments are not supported on LinkedIn message/);
    expect(voice[0]).toContain(RICH_CONTENT_MATRIX.linkedin_message.cells.voice.reason);
    const video = problems(
      message({ attachmentUrl: 'https://cdn.example.test/clip.mp4', mediaKind: 'file' })
    );
    expect(video).toHaveLength(1);
    expect(video[0]).toContain(RICH_CONTENT_MATRIX.linkedin_message.cells.video.reason);
    expect(
      problems(message({ attachmentUrl: 'http://cdn.example.test/deck.pdf', mediaKind: 'file' }))
    ).toContain('Variant A attachment must use HTTPS.');
  });

  it('flags any attachment on an invite note', () => {
    const found = problems(
      invite({ attachmentUrl: 'https://cdn.example.test/deck.pdf', mediaKind: 'file' })
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('link-only on LinkedIn invitation note');
  });
});
