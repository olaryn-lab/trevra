import { createPublicWebCrawler } from '../../crawl/public-web.js';
import { createSsrfFetch, type FetchLike } from '../../skills/guard.js';
import { normalizeDomain } from '../../skills/ladder.js';
import type {
  ResearchProvider,
  SourceQuery,
  ProviderSearchOptions,
  CandidateCompany
} from '../types.js';

/** Manual, bounded DACH pilot: OSM shop=shoes websites -> public HTML inspection.
 * Not a complete census. Bulk/recurring use needs a licensed extract or own data server.
 * OSM data © OpenStreetMap contributors, ODbL: https://www.openstreetmap.org/copyright
 */
// Private.coffee permits commercial API usage with fair-share expectations.
// Its public endpoint is still best-effort, not production infrastructure.
const OSM_URL = 'https://overpass.private.coffee/api/interpreter';
const OSM_ATTRIBUTION = 'https://www.openstreetmap.org/copyright';
const REGIONS = [
  { city: 'Berlin', country: 'DE', bbox: '52.45,13.30,52.57,13.53' },
  { city: 'Munich', country: 'DE', bbox: '48.08,11.47,48.21,11.67' },
  { city: 'Hamburg', country: 'DE', bbox: '53.48,9.87,53.63,10.13' },
  { city: 'Vienna', country: 'AT', bbox: '48.15,16.28,48.28,16.46' },
  { city: 'Graz', country: 'AT', bbox: '47.02,15.37,47.11,15.50' },
  { city: 'Zurich', country: 'CH', bbox: '47.33,8.48,47.43,8.60' },
  { city: 'Basel', country: 'CH', bbox: '47.52,7.55,47.61,7.65' },
  { city: 'Bern', country: 'CH', bbox: '46.91,7.38,46.98,7.50' }
] as const;
const ALIASES: Record<string, string> = {
  germany: 'DE',
  deutschland: 'DE',
  de: 'DE',
  austria: 'AT',
  österreich: 'AT',
  at: 'AT',
  switzerland: 'CH',
  schweiz: 'CH',
  ch: 'CH',
  münchen: 'munich',
  muenchen: 'munich',
  wien: 'vienna',
  zürich: 'zurich',
  zuerich: 'zurich'
};
const SHOE = /(?:schuhe|sneaker|stiefel|sandalen|footwear|shoes|boots|chaussures|scarpe)/i;
const COMMERCE =
  /(?:\/cart|\/products?\/|\/collections\/|warenkorb|jetzt.kaufen|add.to.cart|add.to.bag|checkout|in.den.warenkorb)/i;
const SHOEAI = /(?:shoesize\.me\/assets\/plugin\/loader\.js|shoesizeme_loader|data-shoeid)/i;
const PDP = /href\s*=\s*['"]([^'"]*\/(?:products?|produkt|artikel)\/[^'"]+)['"]/i;
const USER_AGENT = 'TrevraFootwearDiscovery/1.0 (https://usetrevra.com)';
type Store = { domain: string; name: string | null; sourceUrl: string; city: string };
type Element = { id?: number; type?: string; tags?: Record<string, string> };

function domainOf(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  try {
    const value = raw.trim().split(';')[0].trim();
    const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port)
      return null;
    const domain = normalizeDomain(url.hostname);
    if (!domain || /(?:^|\.)(facebook|instagram|linkedin|amazon|youtube|tiktok)\./i.test(domain))
      return null;
    return domain;
  } catch {
    return null;
  }
}

function regionsFor(query: SourceQuery) {
  const countries = query.countries.map(
    (value) => ALIASES[value.toLowerCase()] ?? value.toUpperCase()
  );
  const cities = query.keywords.map((value) =>
    (ALIASES[value.toLowerCase()] ?? value).toLowerCase()
  );
  const explicit = REGIONS.filter((region) => cities.includes(region.city.toLowerCase()));
  return (
    explicit.length
      ? explicit
      : REGIONS.filter((region) => ['Berlin', 'Vienna', 'Zurich'].includes(region.city))
  )
    .filter((region) => !countries.length || countries.includes(region.country))
    .slice(0, 3);
}

async function candidatesFromOSM(query: SourceQuery, options: ProviderSearchOptions) {
  const stores = new Map<string, Store>();
  const warnings: string[] = [];
  for (const raw of query.domains.slice(0, 45)) {
    const domain = domainOf(raw);
    if (domain)
      stores.set(domain, {
        domain,
        name: null,
        city: 'operator seed',
        sourceUrl: `https://${domain}/`
      });
  }
  if (query.domains.length) return { stores: [...stores.values()], warnings };
  const client = createSsrfFetch({ fetchImpl: options.fetchImpl, resolve: !options.fetchImpl });
  const regions = regionsFor(query);
  if (!regions.length) warnings.push('No supported DACH city/country selected.');
  for (const region of regions) {
    if (stores.size >= 45) break;
    try {
      const q = `[out:json][timeout:15];(nwr["shop"="shoes"]["website"](${region.bbox});nwr["shop"="shoes"]["contact:website"](${region.bbox}););out body 80;`;
      const response = await client(OSM_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
          'user-agent': USER_AGENT
        },
        body: new URLSearchParams({ data: q }).toString(),
        signal: AbortSignal.timeout(20_000)
      });
      if (!response.ok) {
        warnings.push(`${region.city}: OSM returned HTTP ${response.status}`);
        if (response.status === 429 || response.status === 504) break;
        continue;
      }
      if (Number(response.headers.get('content-length')) > 1_000_000) {
        warnings.push(`${region.city}: OSM response too large`);
        continue;
      }
      const payload = JSON.parse(await readTextLimited(response, 1_000_000)) as {
        elements?: Element[];
      };
      let acceptedForCity = 0;
      const perCityCap = Math.ceil(45 / regions.length);
      for (const element of payload.elements ?? []) {
        const domain = domainOf(element.tags?.website ?? element.tags?.['contact:website']);
        if (
          !domain ||
          stores.has(domain) ||
          !['node', 'way', 'relation'].includes(element.type ?? '') ||
          !Number.isSafeInteger(element.id)
        )
          continue;
        stores.set(domain, {
          domain,
          name: element.tags?.name ?? null,
          city: region.city,
          sourceUrl: `https://www.openstreetmap.org/${element.type}/${element.id}`
        });
        acceptedForCity += 1;
        if (acceptedForCity >= perCityCap || stores.size >= 45) break;
      }
    } catch (error) {
      warnings.push(`${region.city}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { stores: [...stores.values()], warnings };
}

async function readTextLimited(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error('Response exceeded safety size limit');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
}

async function inspect(store: Store, fetchImpl?: FetchLike) {
  // Reuse Trevra's existing crawler: robots.txt, same-site redirects, delays,
  // timeouts, byte limits and request budgets. Do not bypass it for discovery.
  const crawler = await createPublicWebCrawler(store.domain, {
    fetchImpl,
    maxRequests: 4,
    maxResponseBytes: 800_000,
    maxRobotsBytes: 32_768,
    timeoutMs: 8_000,
    maxDurationMs: 18_000,
    maxRetries: 0,
    strictRobots: true
  });
  const homepage = await crawler.get('/');
  if (homepage.response?.status !== 200 || !/text\/html/i.test(homepage.response.contentType))
    return null;
  const html = homepage.response.text;
  if (!SHOE.test(html) || !COMMERCE.test(html)) return null;
  let shoeai = SHOEAI.test(html);
  if (!shoeai) {
    const link = PDP.exec(html)?.[1];
    if (link) {
      try {
        const url = new URL(link.replaceAll('&amp;', '&'), homepage.finalUrl);
        const pdp = await crawler.get(url.toString());
        if (pdp.response?.status === 200 && /text\/html/i.test(pdp.response.contentType)) {
          shoeai = SHOEAI.test(pdp.response.text);
        }
      } catch {
        // A disallowed or unavailable PDP never fabricates a detection.
      }
    }
  }
  return { shoeai };
}

function provider(onlyShoeAI: boolean): ResearchProvider {
  const key = onlyShoeAI ? 'shoeai-dach' : 'dach-footwear';
  return {
    key,
    name: onlyShoeAI ? 'DACH footwear · ShoeAI traces' : 'DACH footwear · online shops',
    docsUrl: OSM_ATTRIBUTION,
    credentialEnvVar: null,
    retention: 'default',
    availability: () => ({
      mode: 'ready',
      reason:
        'Manual small-city pilot (Berlin/Vienna/Zurich by default). OSM-derived candidates are checked for public shoe-commerce HTML; JS-only sites can be missed. © OpenStreetMap contributors.',
      docsUrl: OSM_ATTRIBUTION
    }),
    async search(query, options) {
      const { stores, warnings } = await candidatesFromOSM(query, options);
      const candidates: CandidateCompany[] = [];
      for (let i = 0; i < stores.length && candidates.length < query.limit; i += 4) {
        const checked = await Promise.all(
          stores.slice(i, i + 4).map(async (store) => {
            try {
              return { store, result: await inspect(store, options.fetchImpl) };
            } catch {
              return { store, result: null };
            }
          })
        );
        for (const { store, result } of checked) {
          if (!result || (onlyShoeAI && !result.shoeai)) continue;
          candidates.push({
            domain: store.domain,
            name: store.name,
            providerKey: key,
            sourceUrl: store.sourceUrl,
            description: result.shoeai
              ? `ShoeAI marker observed in public static HTML; live widget unverified. ${store.city}.`
              : `Footwear and shopping markers observed in public HTML; ShoeAI unknown. ${store.city}.`
          });
          if (candidates.length >= query.limit) break;
        }
      }
      warnings.push(
        'Sampled cities/seed domains only; not all DACH stores or active ShoeAI customers. Static HTML may omit JavaScript-loaded widgets.'
      );
      return {
        providerKey: key,
        candidates,
        warnings,
        evidence: [
          {
            label: 'OpenStreetMap attribution',
            detail: '© OpenStreetMap contributors; ODbL. Store verification uses public HTML.',
            sourceUrl: OSM_ATTRIBUTION
          }
        ]
      };
    }
  };
}
export const dachFootwearProvider = provider(false);
export const shoeaiDachProvider = provider(true);
