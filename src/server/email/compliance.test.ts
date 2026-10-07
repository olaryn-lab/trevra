import { afterEach, describe, expect, it } from 'vitest';
import type { Db } from '../db.js';
import {
  emailComplianceProvider,
  registerEmailComplianceProvider,
  resetEmailComplianceProvider
} from './compliance.js';

const db = {} as Db;

afterEach(() => resetEmailComplianceProvider());

describe('email compliance provider', () => {
  it('defaults to no footer and a blocker', async () => {
    expect(await emailComplianceProvider().footer(db, 'ws')).toBeNull();
    expect(await emailComplianceProvider().blockers(db, 'ws', null)).toEqual([
      {
        code: 'email_compliance_footer_unavailable',
        message:
          'Outreach email needs a compliance footer (legal name, postal address, opt-out). Complete sender compliance in Workspace settings.',
        actionHref: '/setup/workspace'
      }
    ]);
  });

  it('uses a registered provider until reset', async () => {
    registerEmailComplianceProvider({
      footer: async () => 'Acme, 1 Main St',
      blockers: async () => []
    });
    expect(await emailComplianceProvider().footer(db, 'ws')).toBe('Acme, 1 Main St');
    resetEmailComplianceProvider();
    expect(await emailComplianceProvider().footer(db, 'ws')).toBeNull();
  });
});
