import { describe, expect, it } from 'vitest';
import { attributionChips, opportunitySourceLine } from './inbound-attribution';

describe('inbound attribution display', () => {
  it('splits the self-reported channel from the UTM chips', () => {
    expect(
      attributionChips({ utm_source: 'newsletter', heard_about: 'podcast', utm_medium: '' })
    ).toEqual({ heardAbout: 'Podcast', utm: [['utm_source', 'newsletter']] });
    expect(attributionChips({})).toEqual({ heardAbout: null, utm: [] });
  });

  it('describes where an Opportunity came from', () => {
    expect(
      opportunitySourceLine({ sourceHeardAbout: 'ai_assistant', sourceUtmSource: 'chatgpt.com' })
    ).toBe('Source: heard about us via AI assistant · utm_source=chatgpt.com');
    expect(opportunitySourceLine({ sourceHeardAbout: null, sourceUtmSource: null })).toBeNull();
  });
});
