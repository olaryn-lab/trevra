import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  deleteLinkedInManagerLeadContact,
  getLinkedInManagerLeadContacts,
  resolveLinkedInHandoff,
  updateLinkedInManagerSeat,
  updateLinkedInSeatCapabilities
} from './api';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('LinkedIn manager client API wiring', () => {
  it('sends warmupOverride to the manager seat PATCH endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ seat: { seatKey: 'owner', warmupOverride: true } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const seat = await updateLinkedInManagerSeat('owner', { warmupOverride: true });
    expect(seat.warmupOverride).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/linkedin/manager/seats/owner');
    expect(init.method).toBe('PATCH');
    expect(init.credentials).toBe('include');
    expect(JSON.parse(String(init.body))).toEqual({ warmupOverride: true });
  });

  it('uses the separate capabilities endpoint only when the form asks for it', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ seat: { seatKey: 'owner' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    await updateLinkedInSeatCapabilities('owner', {
      inmail: 'unknown',
      premium: false,
      salesNavigator: false,
      recruiter: false,
      inmailMonthlyBudget: null,
      inmailPaidCreditCap: null
    });
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/linkedin/manager/seats/owner/capabilities');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(String(init.body))).toEqual({
      inmail: 'unknown',
      premium: false,
      salesNavigator: false,
      recruiter: false,
      inmailMonthlyBudget: null,
      inmailPaidCreditCap: null
    });
  });

  it('reports a handoff resolution to its own route', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ handoff: { actionId: 'lact_1', status: 'sent' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    expect(await resolveLinkedInHandoff('lact_1', 'sent')).toEqual({
      actionId: 'lact_1',
      status: 'sent'
    });
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/linkedin/handoffs/lact_1/resolve');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ resolution: 'sent' });
  });

  it('requires the server to confirm a permanent lead deletion', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ deleted: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ deleted: false }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'Deletion failed' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        })
      );
    vi.stubGlobal('fetch', fetchMock);
    await expect(deleteLinkedInManagerLeadContact('lead/id')).resolves.toBeUndefined();
    await expect(deleteLinkedInManagerLeadContact('lead/id')).rejects.toThrow(/did not confirm/);
    await expect(deleteLinkedInManagerLeadContact('lead/id')).rejects.toThrow(/Deletion failed/);
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/linkedin/manager/contacts/lead%2Fid');
    expect(init.method).toBe('DELETE');
    expect(init.credentials).toBe('include');
  });

  it('passes whole-list search and identity-review filters to the paginated API', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          list: {},
          contacts: [],
          total: 0,
          listTotal: 8,
          identityReviewCount: 3,
          offset: 5,
          hasMore: false,
          pageLimit: 2
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        }
      )
    );
    vi.stubGlobal('fetch', fetchMock);
    const result = await getLinkedInManagerLeadContacts('list/1', 'second', {
      query: ' %_',
      offset: 5,
      limit: 2,
      needsIdentityOnly: true
    });
    expect(result).toMatchObject({ total: 0, listTotal: 8, identityReviewCount: 3 });
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe(
      '/api/linkedin/manager/lead-lists/list%2F1/contacts?seatKey=second&offset=5&limit=2&query=%25_&needsIdentityOnly=true'
    );
    expect(init.credentials).toBe('include');
  });

  it('never removes a lead from the UI before awaiting the deletion API', async () => {
    // Source guard: server tests cannot exercise the browser event handler, and
    // a prior regression removed the remote call while retaining a success toast.
    const source = await readFile(
      new URL('./LinkedInManagerLeadConfig.tsx', import.meta.url),
      'utf8'
    );
    const handler =
      source.split('const removeContact = async ')[1]?.split('const openMeta =')[0] ?? '';
    expect(handler).toMatch(
      /await deleteLinkedInManagerLeadContact\(contact\.id\);[\s\S]*await readContacts\([\s\S]*setToast\(/
    );
  });
});
