import type { BrowserRules } from "@pibot/browser-contract/full";
import { privateNetworkOrigin } from "@pibot/browser-contract/full";
import { applyProxy } from "../network.ts";
import type { Session } from "../platform.ts";
import { type PrivateNetworkDial, privateNetworkDial } from "./destination.ts";
import { privateProxyPac } from "./pac.ts";
import { createPrivateNetworkProxy, type PrivateNetworkBudget } from "./proxy.ts";

/** Owns the session route and sockets for one run, including immediate grant invalidation. */
export class PrivateNetworkTransport {
  private readonly proxies = new Map<
    string,
    Awaited<ReturnType<typeof createPrivateNetworkProxy>>
  >();
  private readonly budget: PrivateNetworkBudget = {
    sockets: new Set(),
    active: new Set(),
    pendingDials: 0,
  };
  private rules?: BrowserRules;
  private revision = 0;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly session: Session,
    private readonly dial: PrivateNetworkDial = privateNetworkDial,
  ) {}

  credentialsFor(info: { isProxy: boolean; host: string; port: number }) {
    if (!info.isProxy || info.host !== "127.0.0.1") return undefined;
    for (const proxy of this.proxies.values())
      if (proxy.active && proxy.credentials.port === info.port) return proxy.credentials;
    return undefined;
  }

  rebind(rules: BrowserRules) {
    if (this.proxies.size) this.rules = rules;
  }

  revoke() {
    this.revision++;
    this.rules = undefined;
    const closing = [...this.proxies.values()].map((proxy) => proxy.revoke());
    this.proxies.clear();
    return Promise.all(closing).then(() => {});
  }

  configure(rules: BrowserRules): Promise<void> {
    const closing = this.revoke();
    const revision = this.revision;
    const operation = this.queue.then(async () => {
      await closing;
      if (revision !== this.revision) return;
      await this.configureRevision(rules, revision);
    });
    // Keep reconfiguration serial after a failure, while returning that failure to its caller.
    this.queue = operation.catch(() => {});
    return operation;
  }

  private async configureRevision(rules: BrowserRules, revision: number) {
    const origins = new Set(
      (rules.runId ? rules.privateOrigins : [])?.filter(
        (origin) => privateNetworkOrigin(origin) === origin,
      ) ?? [],
    );
    if (!origins.size) {
      await applyProxy(this.session, rules.proxy, rules.localPorts);
      return;
    }
    try {
      const routes = new Map<string, string>();
      for (const origin of origins) {
        const proxy = await createPrivateNetworkProxy(origin, this.dial, this.budget);
        if (revision !== this.revision) {
          await proxy.revoke();
          return;
        }
        this.proxies.set(origin, proxy);
        routes.set(origin, proxy.route);
      }
      // A data URL has no network/file lifecycle and cannot be replaced by a page. Before each
      // private request we also verify resolveProxy: a PAC failure must never become DIRECT.
      const pac = privateProxyPac({ ...rules, privateOrigins: [...origins] }, routes);
      await this.session.setProxy({
        mode: "pac_script",
        pacScript: `data:application/x-ns-proxy-autoconfig;base64,${Buffer.from(pac).toString("base64")}`,
      });
      await this.session.closeAllConnections();
      if (revision !== this.revision) {
        return;
      }
      this.rules = rules;
    } catch (error) {
      if (revision === this.revision) await this.revoke();
      throw error;
    }
  }

  async routes(rules: BrowserRules, url: URL): Promise<boolean> {
    const origin = privateNetworkOrigin(url.href);
    const proxy = origin ? this.proxies.get(origin) : undefined;
    if (!proxy?.active || this.rules !== rules || !rules.runId) return false;
    if (!origin || !rules.privateOrigins?.includes(origin)) return false;
    try {
      const route = await this.session.resolveProxy(url.href);
      return (
        this.proxies.get(origin) === proxy &&
        this.rules === rules &&
        proxy.active &&
        route === proxy.route
      );
    } catch {
      return false;
    }
  }
}
