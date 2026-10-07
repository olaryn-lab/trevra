import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  SenderIdentityForm,
  draftFromIdentity,
  draftToSenderIdentityInput,
  senderIdentityGaps
} from './SenderIdentityPanel';

const EMPTY = { legalName: null, postalAddress: null, privacyPolicyUrl: null, updatedAt: null };

describe('sender identity panel', () => {
  it('names what blocks email outreach', () => {
    expect(senderIdentityGaps(EMPTY)).toEqual(['postal address', 'privacy policy URL']);
    expect(
      senderIdentityGaps({
        ...EMPTY,
        postalAddress: 'Bahnhofstrasse 1',
        privacyPolicyUrl: 'https://northwind.example/privacy'
      })
    ).toEqual([]);
  });

  it('sends blanks as cleared fields', () => {
    expect(
      draftToSenderIdentityInput({
        legalName: ' Northwind GmbH ',
        postalAddress: '',
        privacyPolicyUrl: '  '
      })
    ).toEqual({ legalName: 'Northwind GmbH', postalAddress: null, privacyPolicyUrl: null });
  });

  it('gives the owner one primary save and shows the block', () => {
    const html = renderToStaticMarkup(
      <SenderIdentityForm
        draft={draftFromIdentity(EMPTY)}
        onChange={() => undefined}
        onSave={() => undefined}
        busy={false}
        isOwner
        error=""
        gaps={senderIdentityGaps(EMPTY)}
      />
    );
    expect(html).toContain('Sender identity');
    expect(html).toContain('Email outreach blocked');
    expect(html).toContain('Missing: postal address and privacy policy URL.');
    expect(html).toContain('Postal address');
    expect(html).toContain('Privacy policy URL');
    expect(html).toContain('Save sender identity');
    expect(html.match(/primary-button/g)).toHaveLength(1);
  });

  it('shows a member the values but no save', () => {
    const html = renderToStaticMarkup(
      <SenderIdentityForm
        draft={draftFromIdentity({ ...EMPTY, legalName: 'Northwind GmbH' })}
        onChange={() => undefined}
        onSave={() => undefined}
        busy={false}
        isOwner={false}
        error=""
        gaps={[]}
      />
    );
    expect(html).toContain('Northwind GmbH');
    expect(html).toContain('Complete');
    expect(html).toContain('Only the workspace owner can change the sender identity.');
    expect(html).not.toContain('Save sender identity');
  });

  it('claims neither blocked nor complete before the saved identity loads', () => {
    const html = renderToStaticMarkup(
      <SenderIdentityForm
        draft={draftFromIdentity(EMPTY)}
        onChange={() => undefined}
        onSave={() => undefined}
        busy={false}
        loading
        isOwner
        error=""
        gaps={null}
      />
    );
    expect(html).not.toContain('Complete');
    expect(html).not.toContain('Email outreach blocked');
    // Disabled with its idle label: nothing is saving.
    expect(html).not.toContain('Saving');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Save sender identity<\/button>/);
  });
});
