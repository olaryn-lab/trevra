import { describe, expect, it } from 'vitest';
import { isFreemailDomain, isPersonalPlatformHost } from './public-domains.js';
import {
  companyDomainFromEmail,
  companyDomainFromUrl,
  orgHandleFromCompany,
  resolveGitHubActor
} from './resolve.js';
import { GitHubClient, type GitHubTransport } from './transport.js';

const NOW = new Date('2026-10-06T12:00:00.000Z');

function github(routes: Record<string, unknown>): GitHubTransport & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async get(endpoint: string) {
      calls.push(endpoint);
      return endpoint in routes
        ? { status: 200, data: routes[endpoint], headers: {} }
        : { status: 404, data: { message: 'Not Found' }, headers: {} };
    }
  };
}

const client = (transport: GitHubTransport) => new GitHubClient(transport, NOW);

describe('public domain rules', () => {
  it('never treats a mailbox provider or a personal publishing platform as a company', () => {
    for (const domain of [
      'gmail.com',
      'googlemail.com',
      'outlook.com',
      'proton.me',
      'icloud.com',
      'users.noreply.github.com'
    ]) {
      expect(isFreemailDomain(domain)).toBe(true);
    }
    expect(isFreemailDomain('buyer.io')).toBe(false);
    for (const host of [
      'jane.github.io',
      'github.com',
      'medium.com',
      'jane.substack.com',
      'dev.to',
      'linktr.ee',
      'jane.vercel.app'
    ]) {
      expect(isPersonalPlatformHost(host)).toBe(true);
    }
    expect(isPersonalPlatformHost('acmegithub.io')).toBe(false);
  });

  it('reads a company domain out of a URL or an email and nothing else', () => {
    expect(companyDomainFromUrl('https://www.Buyer.io/about')).toBe('buyer.io');
    expect(companyDomainFromUrl('buyer.io')).toBe('buyer.io');
    expect(companyDomainFromUrl('https://medium.com/@maya')).toBeNull();
    expect(companyDomainFromUrl('http://localhost:3000')).toBeNull();
    expect(companyDomainFromUrl('')).toBeNull();
    expect(companyDomainFromUrl(null)).toBeNull();
    expect(companyDomainFromEmail('sam@newco.dev')).toBe('newco.dev');
    expect(companyDomainFromEmail('lee@gmail.com')).toBeNull();
    expect(companyDomainFromEmail('not-an-email')).toBeNull();
  });

  it('reads an organization handle only from an @mention in the company field', () => {
    expect(orgHandleFromCompany('@lemoncrow-lab')).toBe('lemoncrow-lab');
    expect(orgHandleFromCompany(' @buyerco, ex-@oldco')).toBe('buyerco');
    expect(orgHandleFromCompany('Buyer Co')).toBeNull();
    expect(orgHandleFromCompany('@')).toBeNull();
    expect(orgHandleFromCompany(null)).toBeNull();
  });
});

describe('resolveGitHubActor', () => {
  it('prefers the organization website, then the public email domain, then the blog', async () => {
    const transport = github({
      '/users/maya': {
        login: 'maya',
        type: 'User',
        html_url: 'https://github.com/maya',
        company: '@buyerco',
        email: 'maya@buyer-mail.com',
        blog: 'maya.dev'
      },
      '/orgs/buyerco': { login: 'buyerco', name: 'Buyer Co', blog: 'https://www.buyer.io' }
    });
    expect(await resolveGitHubActor(client(transport), 'maya')).toEqual({
      login: 'maya',
      profileUrl: 'https://github.com/maya',
      type: 'User',
      candidates: [
        { domain: 'buyer.io', via: 'org_website', name: 'Buyer Co' },
        { domain: 'buyer-mail.com', via: 'email_domain', name: null },
        { domain: 'maya.dev', via: 'blog', name: null }
      ]
    });
  });

  it('invents nothing from a plain-text company, a freemail address or a platform blog', async () => {
    const transport = github({
      '/users/lee': {
        login: 'lee',
        type: 'User',
        html_url: 'https://github.com/lee',
        company: 'Freelance Consulting',
        email: 'lee@gmail.com',
        blog: 'https://lee.github.io'
      }
    });
    expect(await resolveGitHubActor(client(transport), 'lee')).toMatchObject({
      login: 'lee',
      candidates: []
    });
    expect(transport.calls).toEqual(['/users/lee']);
  });

  it('falls through an @handle that is a person or an organization without a website', async () => {
    const noSite = github({
      '/users/kim': {
        login: 'kim',
        type: 'User',
        html_url: 'https://github.com/kim',
        company: '@nosite',
        email: 'kim@kimco.dev',
        blog: null
      },
      '/orgs/nosite': { login: 'nosite', name: 'No Site', blog: '' }
    });
    expect((await resolveGitHubActor(client(noSite), 'kim'))?.candidates).toEqual([
      { domain: 'kimco.dev', via: 'email_domain', name: null }
    ]);

    const person = github({
      '/users/ann': {
        login: 'ann',
        type: 'User',
        html_url: 'https://github.com/ann',
        company: '@bob',
        email: null,
        blog: null
      }
    });
    expect((await resolveGitHubActor(client(person), 'ann'))?.candidates).toEqual([]);
  });

  it('resolves an organization that forked the repository through its own website', async () => {
    const transport = github({
      '/users/buyerco': {
        login: 'buyerco',
        type: 'Organization',
        html_url: 'https://github.com/buyerco',
        name: 'Buyer Co',
        blog: 'buyer.io'
      }
    });
    expect((await resolveGitHubActor(client(transport), 'buyerco'))?.candidates).toEqual([
      { domain: 'buyer.io', via: 'org_website', name: 'Buyer Co' }
    ]);
  });

  it('returns null for a deleted account and no company for a bot', async () => {
    expect(await resolveGitHubActor(client(github({})), 'ghost')).toBeNull();
    const bot = github({
      '/users/renovate': {
        login: 'renovate',
        type: 'Bot',
        html_url: 'https://github.com/apps/renovate',
        blog: 'https://renovatebot.com'
      }
    });
    expect((await resolveGitHubActor(client(bot), 'renovate'))?.candidates).toEqual([]);
  });
});
