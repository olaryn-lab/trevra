import { describe, expect, it } from 'vitest';
import type { FetchLike } from '../../skills/guard.js';
import { dachFootwearProvider, shoeaiDachProvider } from './footwear.js';
import type { SourceQuery } from '../types.js';

const noCredentials = { get: () => undefined };
function query(overrides: Partial<SourceQuery> = {}): SourceQuery {
  return {
    keywords: [],
    domains: [],
    urls: [],
    countries: [],
    vertical: 'footwear',
    limit: 25,
    ...overrides
  };
}

const ELEMENTS = [
  {
    type: 'node',
    id: 20,
    tags: { name: 'Berlin Shoes', website: 'https://www.berlin-shoes.test' }
  },
  { type: 'way', id: 21, tags: { name: 'Duplicate', website: 'berlin-shoes.test' } },
  {
    type: 'node',
    id: 22,
    tags: { name: 'Normal Shoes', 'contact:website': 'https://normal-shoes.test' }
  },
  { type: 'node', id: 23, tags: { name: 'Not Ecommerce', website: 'https://local-shoes.test' } },
  { type: 'node', id: 24, tags: { name: 'Blocked', website: 'http://127.0.0.1/admin' } }
];

function fakeFetch(requests: string[]): FetchLike {
  return async (url, init) => {
    requests.push(url);
    if (url.includes('overpass.private.coffee')) {
      const body = String(init?.body);
      expect(body).toContain('52.45%2C13.30');
      expect(body).not.toContain('48.15%2C16.28');
      return new Response(JSON.stringify({ elements: ELEMENTS }), {
        headers: { 'content-type': 'application/json' }
      });
    }
    if (url.includes('berlin-shoes.test/products/sneaker')) {
      return new Response('<script src="https://shoesize.me/assets/plugin/loader.js"></script>', {
        headers: { 'content-type': 'text/html' }
      });
    }
    if (url.includes('berlin-shoes.test')) {
      return new Response(
        '<h1>Schuhe</h1><a href="/products/sneaker">Sneaker</a><div>Warenkorb</div>',
        {
          headers: { 'content-type': 'text/html' }
        }
      );
    }
    if (url.includes('normal-shoes.test')) {
      return new Response('<h1>Schuhe</h1><div>Warenkorb</div>', {
        headers: { 'content-type': 'text/html' }
      });
    }
    return new Response('<h1>Visit our physical shoe shop</h1>', {
      headers: { 'content-type': 'text/html' }
    });
  };
}

describe('DACH footwear source providers', () => {
  it('filters by country, deduplicates merchants, checks for checkout signals, and retains OSM provenance', async () => {
    const requests: string[] = [];
    const result = await dachFootwearProvider.search(query({ countries: ['Germany'] }), {
      credentials: noCredentials,
      fetchImpl: fakeFetch(requests)
    });
    expect(result.candidates.map((item) => item.domain)).toEqual([
      'berlin-shoes.test',
      'normal-shoes.test'
    ]);
    expect(result.candidates[0].name).toBe('Berlin Shoes');
    expect(result.candidates[0].sourceUrl).toBe('https://www.openstreetmap.org/node/20');
    expect(result.candidates[0].description).toContain('ShoeAI marker');
    expect(result.candidates[1].description).toContain('ShoeAI unknown');
    expect(result.evidence[0].sourceUrl).toContain('openstreetmap.org/copyright');
    expect(requests.filter((url) => url.includes('overpass.private.coffee')).length).toBe(1);
  });

  it('only surfaces companies with an observed ShoeAI marker, not generic shoe shops', async () => {
    const result = await shoeaiDachProvider.search(query({ countries: ['DE'] }), {
      credentials: noCredentials,
      fetchImpl: fakeFetch([])
    });
    expect(result.candidates.map((item) => item.domain)).toEqual(['berlin-shoes.test']);
    expect(result.warnings.join(' ')).toContain('not all DACH stores');
  });

  it('supports operator supplied storefront domains and does not call an index', async () => {
    const requests: string[] = [];
    const result = await shoeaiDachProvider.search(
      query({
        domains: [
          'https://berlin-shoes.test/shop',
          'berlin-shoes.test',
          '127.0.0.1',
          'normal-shoes.test'
        ]
      }),
      { credentials: noCredentials, fetchImpl: fakeFetch(requests) }
    );
    expect(result.candidates.map((item) => item.domain)).toEqual(['berlin-shoes.test']);
    expect(requests.some((url) => url.includes('overpass.private.coffee'))).toBe(false);
  });

  it('visits all three default DACH capitals instead of exhausting the cap in Berlin', async () => {
    const cities: string[] = [];
    const shops = Array.from({ length: 30 }, (_, index) => ({
      type: 'node',
      id: index + 100,
      tags: { website: `shoes-${index}.test`, name: `Shoes ${index}` }
    }));
    await dachFootwearProvider.search(query({ limit: 10 }), {
      credentials: noCredentials,
      fetchImpl: async (url, init) => {
        if (url.includes('overpass.private.coffee')) {
          const body = decodeURIComponent(String(init?.body));
          const city = body.includes('52.45,13.30')
            ? 'Berlin'
            : body.includes('48.15,16.28')
              ? 'Vienna'
              : 'Zurich';
          cities.push(city);
          return new Response(JSON.stringify({ elements: shops }), { status: 200 });
        }
        return new Response('No shop here', { headers: { 'content-type': 'text/html' } });
      }
    });
    expect(cities).toEqual(['Berlin', 'Vienna', 'Zurich']);
  });

  it('never crawls a storefront whose robots.txt disallows the Trevra crawler', async () => {
    const requests: string[] = [];
    const result = await dachFootwearProvider.search(query({ domains: ['normal-shoes.test'] }), {
      credentials: noCredentials,
      fetchImpl: async (url) => {
        requests.push(url);
        if (url.endsWith('/robots.txt')) {
          return new Response('User-agent: TrevraCrawler\nDisallow: /', {
            headers: { 'content-type': 'text/plain' }
          });
        }
        throw new Error('Blocked storefront must not be read');
      }
    });
    expect(result.candidates).toEqual([]);
    expect(requests).toEqual(['https://normal-shoes.test/robots.txt']);
  });

  it('rejects unsupported countries without arbitrary country-wide scraping', async () => {
    let called = false;
    const result = await dachFootwearProvider.search(query({ countries: ['FR'] }), {
      credentials: noCredentials,
      fetchImpl: async () => {
        called = true;
        throw new Error('not expected');
      }
    });
    expect(called).toBe(false);
    expect(result.candidates).toEqual([]);
    expect(result.warnings[0]).toContain('No supported DACH');
  });

  it('degrades Overpass rate limits to an explicit warning and no fabricated customers', async () => {
    const result = await shoeaiDachProvider.search(query({ countries: ['AT'] }), {
      credentials: noCredentials,
      fetchImpl: async () => new Response('busy', { status: 429 })
    });
    expect(result.candidates).toEqual([]);
    expect(result.warnings[0]).toContain('HTTP 429');
  });
});
