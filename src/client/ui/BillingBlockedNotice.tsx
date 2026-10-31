import { isEntitlementError } from '../api';

const BILLING_PATH = '/setup/billing';

/**
 * TRV-057: a write the server refused because of the workspace plan. Shows
 * the server's reason verbatim (it already says what keeps running and that
 * nothing was deleted) plus the way to resolve it.
 */
export function BillingBlockedNotice({
  message,
  billingUrl
}: {
  message: string;
  billingUrl?: string;
}) {
  const href =
    billingUrl?.startsWith('/') && !billingUrl.startsWith('//') ? billingUrl : BILLING_PATH;
  return (
    <div className="error-banner billing-blocked-notice" role="alert">
      <span>{message}</span>
      <a href={href}>Open Billing</a>
    </div>
  );
}

/**
 * An error banner that adds the Billing link when the refusal came from the
 * plan. `error` is the thrown value behind `message`; a stale cause from an
 * earlier failure (different message) never adds the link.
 */
export function ErrorOrBillingBlocked({ message, error }: { message: string; error: unknown }) {
  if (isEntitlementError(error) && error.message === message)
    return <BillingBlockedNotice message={message} billingUrl={error.billingUrl} />;
  return <div className="error-banner">{message}</div>;
}
