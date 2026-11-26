import type { GrantScope } from "@pibot/protocol-base";
import { matchesGrant } from "../grants/grants.ts";
import { BOT_SEND_CONFIRMATION_REASON, PRIVATE_NETWORK_REASON } from "./confirmation-reasons.ts";
import {
  CONNECTION_CONFIRMATION_REASON,
  CONNECTION_READ_ONLY_REASON,
  connectionConfirmation,
} from "./connection-confirmation.ts";
import type { PolicyTrace } from "./explain.ts";
import { deny, type RequestFacts } from "./request-facts.ts";
import type { EvaluationInput, PolicyOptions, PolicyResult } from "./types.ts";

/**
 * The decisions that belong to another side's own access rules: sending out, a connection's
 * confirmation mode, the configured search provider, a Bot-browser login or form submission, and
 * a page served by the Bot's own background command. They read one request each and answer with
 * the trace step that produced the result, or nothing when the category is not theirs.
 */
export function serviceDecision(
  input: EvaluationInput,
  options: PolicyOptions,
  result: PolicyResult,
  trace: PolicyTrace,
  scope: GrantScope | undefined,
  localService: RequestFacts["localService"],
  privateNetwork?: RequestFacts["privateNetwork"],
): PolicyResult | undefined {
  // Maintainers 2026-11-14: a local-network origin in the Bot browser asks each time per origin and
  // task, before login / submit / visit rules; once allowed for this run those apply as usual.
  if (privateNetwork && !privateNetwork.approved) {
    result.decision = "ask";
    result.reason = PRIVATE_NETWORK_REASON;
    result.canRemember = false;
    delete result.grantScope;
    return trace.result(result, "boundary");
  }
  // Before the identity rule and every grant: whichever identity sends, this Bot asks each time.
  if (input.request.category === "send_out" && input.confirmEverySend) {
    result.decision = "ask";
    result.reason = BOT_SEND_CONFIRMATION_REASON;
    result.canRemember = false;
    delete result.grantScope;
    return trace.result(result, "boundary");
  }
  if (input.request.category === "send_out" && input.request.identity === "user") {
    result.reason = "user_send_confirmation";
    result.canRemember = false;
    return trace.result(result, "connector");
  }
  if (input.request.category === "connector" && input.request.operation === "discover") {
    result.decision = "allow";
    result.reason = "connector_metadata";
    return trace.result(result, "connector");
  }
  if (input.request.category === "connector") {
    const confirmation = connectionConfirmation(
      input.request.confirmationMode,
      !input.request.readOnly,
    );
    if (confirmation === "blocked") {
      delete result.grantScope;
      return deny(result, CONNECTION_READ_ONLY_REASON, trace, "connector");
    }
    if (confirmation === "ask_now") {
      result.decision = "ask";
      result.reason = CONNECTION_CONFIRMATION_REASON;
      result.canRemember = false;
      delete result.grantScope;
      return trace.result(result, "connector");
    }
    // The connection's explicit all/selected access already grants use, never send authority:
    // a write only becomes a draft, and the draft's own judgement decides whether it is sent.
    result.decision = "allow";
    result.reason = input.request.readOnly ? "connector_access" : "connector_draft_only";
    result.canRemember = false;
    if (scope) result.grantScope = scope;
    return trace.result(result, "connector");
  }
  if (input.request.category === "web" && input.request.search) {
    if (!input.request.search.disclosed) {
      result.decision = "ask";
      // A configured provider's first-use disclosure is application consent, not a hard deny.
      // Network and permission-never boundaries have already been enforced above.
      result.reason = input.request.search.confirmBeforeUse
        ? "search_disclosure_required"
        : "search_provider_disclosure_required";
      result.canRemember = false;
      return trace.result(result, "boundary");
    }
    result.decision = "allow";
    result.reason = "search_disclosed";
    result.canRemember = false;
    return trace.result(result, "boundary");
  }
  if (input.request.category === "web" && input.request.login) {
    // The first automatic login per Bot and saved site is always asked, even at
    // the "always" web level; "don't ask again" stores a login grant, never a site visit grant.
    const scope = { kind: "login" as const, site: input.request.login.site };
    result.canRemember = true;
    result.grantScope = scope;
    const held = input.grants?.some((grant) =>
      matchesGrant(grant, { botId: input.botId, category: "web", scope }, options.platform),
    );
    result.decision = held ? "allow" : "ask";
    result.reason = held ? "grant_matched" : "browser_login_first";
    if (!held) trace.step("grant", "grant_not_matched", "info");
    return trace.result(result, "grant");
  }
  if (localService) {
    // A page served by this Bot's own background command on loopback. The user approved
    // that command; visiting or submitting to it reaches no other site, so it is not asked.
    result.decision = "allow";
    result.reason = "own_local_service";
    result.canRemember = false;
    delete result.grantScope;
    return trace.result(result, "intrinsic");
  }
  if (input.request.category === "web" && input.request.submit) {
    // The first form submission per Bot and site is always asked, even at the
    // "always" web level; "always allow" stores a submit grant for the site, never a visit grant.
    result.facts.push({ kind: "warning", value: "browser_submit" });
    const scope = result.domain ? { kind: "submit" as const, domain: result.domain } : undefined;
    result.canRemember = !!scope;
    if (scope) result.grantScope = scope;
    const held =
      !!scope &&
      !!input.grants?.some((grant) =>
        matchesGrant(grant, { botId: input.botId, category: "web", scope }, options.platform),
      );
    result.decision = held ? "allow" : "ask";
    result.reason = held ? "grant_matched" : "browser_submit";
    if (!held) trace.step("grant", "grant_not_matched", "info");
    return trace.result(result, "grant");
  }
  if (privateNetwork?.approved) {
    // Visits and page actions on the allowed origin need no site card: it has no domain to
    // remember, and the run's approval ends with the run.
    result.decision = "allow";
    result.reason = "private_network_run_approved";
    result.canRemember = false;
    delete result.grantScope;
    return trace.result(result, "boundary");
  }
  return undefined;
}
