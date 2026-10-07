import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db.js';
import {
  BookingUrlError,
  getBookingUrl,
  normalizeBookingUrl,
  setBookingUrl
} from './booking-link.js';

const WORKSPACE = 'ws_booking_link_test';

describe('normalizeBookingUrl', () => {
  it('trims an https link and treats blank as no link', () => {
    expect(normalizeBookingUrl('  https://cal.com/founder/intro ')).toBe(
      'https://cal.com/founder/intro'
    );
    expect(normalizeBookingUrl('   ')).toBeNull();
    expect(normalizeBookingUrl(null)).toBeNull();
  });

  it('refuses http, credentials, whitespace and overlong links', () => {
    for (const value of [
      'http://cal.com/founder',
      'cal.com/founder',
      'https://user:pass@cal.com/founder',
      'https://cal.com/a b',
      `https://cal.com/${'x'.repeat(500)}`
    ]) {
      expect(() => normalizeBookingUrl(value)).toThrow(BookingUrlError);
    }
  });
});

describe('booking link storage', () => {
  let db: Db;

  beforeEach(async () => {
    db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
    await db.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE);
    await db
      .prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)')
      .run(WORKSPACE, 'Booking link', '2026-08-01T00:00:00.000Z');
  });

  afterEach(async () => {
    if (db) await db.prepare('DELETE FROM workspaces WHERE id=?').run(WORKSPACE);
    await db?.close();
  });

  it('creates the settings row when missing, and clears the link', async () => {
    expect(await getBookingUrl(db, WORKSPACE)).toBeNull();
    expect(await setBookingUrl(db, WORKSPACE, 'https://cal.com/founder/intro')).toBe(
      'https://cal.com/founder/intro'
    );
    expect(await getBookingUrl(db, WORKSPACE)).toBe('https://cal.com/founder/intro');
    expect(await setBookingUrl(db, WORKSPACE, '')).toBeNull();
    expect(await getBookingUrl(db, WORKSPACE)).toBeNull();
  });
});
