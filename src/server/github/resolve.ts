import { normalizeAccountDomain } from '../accounts/store.js';
import { isFreemailDomain, isPersonalPlatformHost } from './public-domains.js';
import { GitHubNotFoundError, GitHubRequestError, type GitHubClient } from './transport.js';

/**
 * Who is behind a GitHub login, in company terms, from PUBLIC data only.
 *
 * Strongest first: an `@org` handle in the profile's company field whose
 * organization lists a website; then the public email's domain; then the
 * profile blog's domain. A plain-text company ("Acme Inc") is never turned
 * into a domain -- guessing `acme.com` from a name is inventing a company.
 * No candidate means unresolved: the person is counted, never stored.
 */

export type ResolvedVia = 'org_website' | 'email_domain' | 'blog';

export interface DomainCandidate {
  domain: string;
  via: ResolvedVia;
  /** The organization's own display name, when GitHub states one. */
  name: string | null;
}

export interface ResolvedActor {
  login: string;
  profileUrl: string;
  type: 'User' | 'Organization' | 'Bot';
  candidates: DomainCandidate[];
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

export function companyDomainFromUrl(raw: unknown): string | null {
  const value = text(raw);
  if (!value) return null;
  const domain = normalizeAccountDomain(value);
  if (!domain) return null;
  if (isFreemailDomain(domain) || isPersonalPlatformHost(domain)) return null;
  return domain;
}

export function companyDomainFromEmail(raw: unknown): string | null {
  const value = text(raw);
  if (!value) return null;
  const at = value.lastIndexOf('@');
  if (at <= 0 || at === value.length - 1) return null;
  return companyDomainFromUrl(value.slice(at + 1));
}

const ORG_HANDLE = /^@([A-Za-z0-9][A-Za-z0-9-]{0,38})(?![A-Za-z0-9-])/;

export function orgHandleFromCompany(raw: unknown): string | null {
  const value = text(raw);
  if (!value) return null;
  const match = ORG_HANDLE.exec(value);
  return match ? match[1] : null;
}

interface ProfileFields {
  login?: unknown;
  html_url?: unknown;
  type?: unknown;
  name?: unknown;
  company?: unknown;
  blog?: unknown;
  email?: unknown;
}

/**
 * A profile GitHub will not show (gone, or any other 4xx such as a
 * SAML-protected organization's 403) is no profile: an unreadable org falls
 * through to the email and blog, an unreadable person is unresolved. A 5xx is
 * transient and propagates; rate limits and revoked tokens have their own
 * error types and propagate too.
 */
async function readProfile(client: GitHubClient, endpoint: string): Promise<ProfileFields | null> {
  try {
    const response = await client.get(endpoint);
    return response.data && typeof response.data === 'object'
      ? (response.data as ProfileFields)
      : null;
  } catch (error) {
    if (error instanceof GitHubNotFoundError) return null;
    if (error instanceof GitHubRequestError && error.status >= 400 && error.status < 500) {
      return null;
    }
    throw error;
  }
}

export async function resolveGitHubActor(
  client: GitHubClient,
  login: string
): Promise<ResolvedActor | null> {
  const profile = await readProfile(client, `/users/${encodeURIComponent(login)}`);
  if (!profile) return null;
  const actualLogin = text(profile.login) ?? login;
  const profileUrl = text(profile.html_url) ?? `https://github.com/${actualLogin}`;
  // GitHub App accounts end in [bot] even when `type` says User.
  const type =
    profile.type === 'Organization'
      ? 'Organization'
      : profile.type === 'Bot' || actualLogin.endsWith('[bot]')
        ? 'Bot'
        : 'User';
  const candidates: DomainCandidate[] = [];

  if (type === 'Organization') {
    const domain = companyDomainFromUrl(profile.blog);
    if (domain)
      candidates.push({ domain, via: 'org_website', name: text(profile.name) ?? actualLogin });
  } else if (type === 'User') {
    const handle = orgHandleFromCompany(profile.company);
    if (handle) {
      const org = await readProfile(client, `/orgs/${encodeURIComponent(handle)}`);
      const domain = org ? companyDomainFromUrl(org.blog) : null;
      if (domain && org)
        candidates.push({ domain, via: 'org_website', name: text(org.name) ?? handle });
    }
    const emailDomain = companyDomainFromEmail(profile.email);
    if (emailDomain) candidates.push({ domain: emailDomain, via: 'email_domain', name: null });
    const blogDomain = companyDomainFromUrl(profile.blog);
    if (blogDomain) candidates.push({ domain: blogDomain, via: 'blog', name: null });
  }

  const unique: DomainCandidate[] = [];
  for (const candidate of candidates) {
    if (!unique.some((kept) => kept.domain === candidate.domain)) unique.push(candidate);
  }
  return { login: actualLogin, profileUrl, type, candidates: unique };
}
