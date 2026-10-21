import { describe, expect, it } from 'vitest';
import type { Request } from 'express';
import { carriesSessionCredential } from './app.js';

const withCookies = (cookies?: Record<string, string>) => ({ cookies }) as unknown as Request;

describe('session-aware launch rate-limit gate', () => {
  it.each([
    'trevra.session_token',
    '__Secure-trevra.session_token',
    'trevra_session',
    'better-auth.session_token'
  ])('recognizes an explicitly supported session cookie %s', (name) => {
    expect(carriesSessionCredential(withCookies({ [name]: 'synthetic-session' }))).toBe(true);
  });

  it('never exempts unrelated, absent, or arbitrary cookies', () => {
    expect(carriesSessionCredential(withCookies())).toBe(false);
    expect(carriesSessionCredential(withCookies({ theme: 'dark' }))).toBe(false);
    expect(carriesSessionCredential(withCookies({ 'trevra.api_key': 'fake' }))).toBe(false);
    expect(carriesSessionCredential(withCookies({ 'not-trevra.session_token': 'fake' }))).toBe(
      false
    );
  });
});
