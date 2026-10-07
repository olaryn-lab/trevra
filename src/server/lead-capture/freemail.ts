/**
 * Personal mailbox providers. A payer on one of these tells us WHO paid, not
 * which company did, so no Account is created from the domain.
 *
 * lc-debt: a fixed list of the largest consumer providers, not exhaustive;
 * upgrade path is a maintained freemail dataset behind `isFreemailDomain`.
 */
export const FREEMAIL_DOMAINS: ReadonlySet<string> = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'msn.com',
  'yahoo.com',
  'ymail.com',
  'rocketmail.com',
  'aol.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'proton.me',
  'protonmail.com',
  'pm.me',
  'gmx.com',
  'gmx.de',
  'gmx.net',
  'web.de',
  'mail.com',
  'zoho.com',
  'yandex.com',
  'yandex.ru',
  'mail.ru',
  'qq.com',
  '163.com',
  '126.com',
  'fastmail.com',
  'hey.com',
  'tutanota.com',
  'tuta.io'
]);

/** Regional variants of the largest providers: yahoo.co.uk, hotmail.fr, outlook.de, ... */
const FREEMAIL_FAMILIES = ['yahoo.', 'hotmail.', 'outlook.', 'live.', 'gmx.', 'yandex.'];

export function emailDomain(email: string | null | undefined): string | null {
  const value = email?.trim().toLowerCase() ?? '';
  const at = value.lastIndexOf('@');
  if (at < 1 || at === value.length - 1) return null;
  const domain = value.slice(at + 1);
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain) ? domain : null;
}

export function isFreemailDomain(domain: string): boolean {
  const value = domain.trim().toLowerCase();
  return (
    FREEMAIL_DOMAINS.has(value) || FREEMAIL_FAMILIES.some((prefix) => value.startsWith(prefix))
  );
}

export function companyDomainFromEmail(email: string | null | undefined): string | null {
  const domain = emailDomain(email);
  return domain && !isFreemailDomain(domain) ? domain : null;
}
