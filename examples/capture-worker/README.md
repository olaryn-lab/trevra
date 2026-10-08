# Trevra capture Worker

A Cloudflare Worker for a site with no backend: a static landing page posts its form here, the Worker checks Cloudflare Turnstile, signs the submission with your Trevra capture secret and delivers it to `POST /api/intake/v1/submissions`. The secret lives only in the Worker, never in page JavaScript.

## 1. Create the pieces

1. In Trevra, open **Setup → Lead capture**, add a source and copy its ID and one-time secret.
2. In the Cloudflare dashboard, add a Turnstile widget for your site's hostname and copy its site key and secret key.

## 2. Deploy

```bash
cd examples/capture-worker
# edit wrangler.toml: TREVRA_API_BASE_URL, TREVRA_CAPTURE_SOURCE_ID, ALLOWED_ORIGIN
npx wrangler secret put TREVRA_CAPTURE_SECRET
npx wrangler secret put TURNSTILE_SECRET_KEY
npx wrangler deploy
```

Set `REDIRECT_URL` (a thank-you page on your site) too: without it, a plain HTML form post leaves the visitor looking at raw JSON.

Do not serve the form page with `Referrer-Policy: no-referrer`: browsers then send `Origin: null` and the Worker refuses the post with `403`.

`TURNSTILE_HOSTNAMES` is optional. When it is unset or blank, the Worker requires the Turnstile token to have been issued on the hostname of `ALLOWED_ORIGIN`; the hostname check is never switched off. Set it only when the widget runs on more than one hostname, for example `www.example.com,example.com`.

## 3. Point your form at it

```html
<form action="https://trevra-capture.<your-subdomain>.workers.dev/" method="POST">
  <label>Work email <input name="email" type="email" required /></label>
  <label>Name <input name="name" /></label>
  <label>Company website <input name="company_domain" placeholder="example.com" /></label>
  <label>What do you need? <textarea name="message"></textarea></label>
  <!-- Consent is opt-in: leave this unticked by default. Only a ticked box sends consent. -->
  <label><input type="checkbox" name="marketing_email" /> Email me product news</label>
  <!-- Honeypot: hidden from people, filled by bots. Keep the name "website". -->
  <input
    name="website"
    tabindex="-1"
    autocomplete="off"
    aria-hidden="true"
    style="position:absolute;left:-10000px"
  />
  <input type="hidden" name="page_url" />
  <input type="hidden" name="utm_source" />
  <input type="hidden" name="utm_medium" />
  <input type="hidden" name="utm_campaign" />
  <div class="cf-turnstile" data-sitekey="YOUR_TURNSTILE_SITE_KEY"></div>
  <button type="submit">Request a demo</button>
</form>
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
<script>
  // Tell the Worker which page the form is on (browsers send only the origin as
  // Referer to a cross-origin Worker), and carry the UTM parameters.
  document.querySelector('input[name="page_url"]').value = location.href;
  const params = new URLSearchParams(location.search);
  for (const name of ['utm_source', 'utm_medium', 'utm_campaign']) {
    const input = document.querySelector(`input[name="${name}"]`);
    if (input && params.get(name)) input.value = params.get(name);
  }
</script>
```

The Turnstile widget adds the `cf-turnstile-response` field that the Worker verifies.

## What the Worker does

| Step                                                                                                                                                                                   | On failure                      |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| Only `POST` from `ALLOWED_ORIGIN`                                                                                                                                                      | `405` or `403`                  |
| Honeypot `website` filled                                                                                                                                                              | pretends success, sends nothing |
| Turnstile siteverify, with the visitor IP from `CF-Connecting-IP` and the token's hostname checked against `TURNSTILE_HOSTNAMES` (default: the host of `ALLOWED_ORIGIN`)               | `403`                           |
| Builds the canonical body: `person.email` (required), `person.name`, `company.domain`, `page.url`, `message`, `utm_*`                                                                  | `400` without a valid email     |
| `page.url` is origin and path of the hidden `page_url` field when its origin equals `ALLOWED_ORIGIN`, otherwise of the `Referer`; query strings and fragments are dropped              |                                 |
| `consent` is `{ "marketingEmail": true, "capturedAt": <time the Worker received the post> }` only when the `marketing_email` box is ticked; an unticked or absent box sends no consent |                                 |
| Signs `<timestamp>.<key>.<body>` and posts; the key is derived from the single-use Turnstile token                                                                                     |                                 |
| Retries once on a network error, `429` or `5xx`, with the same key and bytes                                                                                                           | `502`                           |
| Trevra answers `400`/`413`                                                                                                                                                             | `400`                           |
| Trevra answers `401`/`403`: wrong, unknown or disabled source ID, or wrong secret (all one `401`), or a citation source posting leads                                                  | `502`, no retry                 |
| Trevra answers `409`: the idempotency key was reused with different bytes                                                                                                              | `502`, no retry                 |
| Trevra answers a redirect (`3xx`): the base URL is wrong; the signed body is never re-sent to another host                                                                             | `502`, no retry                 |

On success it returns `{"ok":true}`, or a `303` to `REDIRECT_URL` when set.

## Hosted form builders

Tally and Formbricks cannot post to Trevra directly: neither can sign with a Trevra capture secret. See [Formbricks webhooks](https://formbricks.com/docs/platform/features/integrations/webhooks) for its Standard Webhooks signing, and `docs/lead-capture.md` section 10 for the Worker-in-the-middle approach.

## Testing

Cloudflare's test secret `1x0000000000000000000000000000000AA` passes the check but reports a test-mode hostname (`localhost` in Cloudflare's sample), so a deployed test needs `TURNSTILE_HOSTNAMES` set to that hostname. The secret `2x0000000000000000000000000000000AA` always fails. In this repository, `npx vitest run examples/capture-worker` checks the Worker's signature with Trevra's own verifier.
