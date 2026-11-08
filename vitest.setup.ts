import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server as TlsServer } from 'node:tls';
import { Test } from 'supertest';

/**
 * NO TEST MAY DIAL A PORT IT DOES NOT OWN.
 *
 * supertest's `request(app)` starts each app with `app.listen(0)` -- the
 * wildcard address `::` -- and then dials `127.0.0.1:<port>`. On macOS (BSD
 * bind rules; Node sets SO_REUSEADDR) the kernel will hand that wildcard
 * listener a port another process already holds on 127.0.0.1 itself: a fake
 * provider server in a parallel vitest worker, Docker's published Postgres
 * port, any local dev tool. The more specific listener wins the connection,
 * so the request is answered by a stranger -- a 401/404 from a route that
 * exists, a rate limit that never trips because its hits landed elsewhere --
 * and the file passes when run alone. Listening on 127.0.0.1 itself makes the
 * kernel refuse a port that is already taken there.
 *
 * `listen(0, '127.0.0.1')` binds asynchronously while supertest computes its
 * URL synchronously, so the bind and the URL's port both move to `end()` --
 * the first moment superagent reads the URL. Requests that meet one unlistened
 * server (a `request.agent(app)` fired concurrently) share its one bind; as in
 * supertest, only the request that started the bind closes the server.
 */
interface LoopbackTest {
  url: string;
  _server?: Server;
  _loopback?: { server: Server; protocol: string; path: string };
  serverAddress(app: Server, path: string): string;
  end(fn?: (error: unknown, res?: unknown) => void): unknown;
}
const supertestTest = Test.prototype as unknown as LoopbackTest;
const wildcardServerAddress = supertestTest.serverAddress;
const supertestEnd = supertestTest.end;
const loopbackBinds = new WeakMap<Server, Promise<void>>();
function listenOnLoopback(server: Server): Promise<void> {
  let bind = loopbackBinds.get(server);
  if (!bind) {
    bind = new Promise<void>((resolve, reject) => {
      const failed = (error: Error) => {
        loopbackBinds.delete(server);
        reject(error);
      };
      server.once('error', failed);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', failed);
        loopbackBinds.delete(server);
        resolve();
      });
    });
    loopbackBinds.set(server, bind);
  }
  return bind;
}
supertestTest.serverAddress = function (this: LoopbackTest, app, path) {
  // Already listening: the caller chose the address; supertest's own path.
  if (app.address()) return wildcardServerAddress.call(this, app, path);
  const protocol = app instanceof TlsServer ? 'https' : 'http';
  this._loopback = { server: app, protocol, path };
  // Portless placeholder until end(): cookie jars read only host and path.
  return `${protocol}://127.0.0.1${path}`;
};
supertestTest.end = function (this: LoopbackTest, fn) {
  const pending = this._loopback;
  if (!pending) return supertestEnd.call(this, fn);
  this._loopback = undefined;
  const { server } = pending;
  const listening = server.address() !== null;
  if (!listening && !loopbackBinds.has(server)) this._server = server;
  (listening ? Promise.resolve() : listenOnLoopback(server)).then(
    () => {
      const { port } = server.address() as AddressInfo;
      this.url = `${pending.protocol}://127.0.0.1:${port}${pending.path}`;
      supertestEnd.call(this, fn);
    },
    (error: unknown) => fn?.(error)
  );
  return this;
};

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
