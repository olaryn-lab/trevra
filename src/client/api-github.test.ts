import { afterEach, describe, expect, it, vi } from 'vitest';
import { getRankedAccounts } from './api';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('accounts client API wiring', () => {
  it('passes the origin filter as the source query parameter', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ accounts: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    await getRankedAccounts({ limit: 200, source: 'github' });
    const [path] = fetchMock.mock.calls[0] as [string];
    expect(path).toContain('source=github');
    expect(path).toContain('limit=200');
  });
});
