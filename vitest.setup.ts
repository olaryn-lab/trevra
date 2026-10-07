/**
 * NO TEST IN THIS REPOSITORY MAY LAUNCH A BROWSER.
 *
 * The LinkedIn subsystem is the only thing that ever could, and every path into
 * it now consults `linkedInBrowserReadiness` first. Pointing Playwright's
 * browser registry at a directory that does not exist -- and clearing the
 * display variables -- makes that probe answer "no" on every platform and
 * every developer machine, whatever they happen to have installed locally.
 *
 * That is not only about speed. A suite that touched a real LinkedIn session
 * would spend a human's daily invite budget on CI, and the ceilings this
 * subsystem exists to respect are per person, not per test run.
 *
 * Tests that need the opposite answer pass an explicit `env` to the probe;
 * nothing here can stop them, and nothing here should.
 */
process.env.PLAYWRIGHT_BROWSERS_PATH = '/nonexistent/trevra-tests-never-launch-a-browser';
delete process.env.DISPLAY;
delete process.env.WAYLAND_DISPLAY;

/**
 * NO TEST MAY RESOLVE REAL DNS. Email deliverability checks read SPF, DKIM and
 * DMARC TXT records; `defaultDnsResolver` refuses every query while this is set,
 * so a test that forgets to inject a fake resolver sees `unknown`, never the
 * network. Tests that exercise evaluation pass an explicit fake `DnsResolver`.
 */
process.env.TREVRA_DNS_DISABLED = 'true';
