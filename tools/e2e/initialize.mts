import assert from "node:assert/strict";
import type { Context } from "./context.mts";
import { until } from "./util.mts";

export async function initialize(c: Context, url: string) {
  c.scenario.replies.unshift({ text: "OK" }); // Real model-settings save-and-test consumes one response.
  await until(
    "startup_controls",
    async () =>
      (await c.page.has("common.getStarted")) ||
      (await c.page.has("chat.goToSettings")) ||
      (await c.page.has("appMenu.title")),
    Boolean,
    c.signal,
    60000,
  );
  const onboarding = await c.page.eval<boolean>(
    `([...document.querySelectorAll('button')]).some(e=>e.getClientRects().length && ${JSON.stringify(c.page.texts("common.getStarted"))}.includes(e.innerText.trim()))`,
  );
  if (onboarding) {
    await c.ui.segment("language.label", "language.zh");
    await c.page.click("common.getStarted");
    // The welcome step offers model sources as cards; the provider list is behind "Use my API key".
    await c.ui.segment("welcome.model.route", "welcome.model.apiKey");
    await c.ui.combo("models.provider", "setup.customLabel");
  } else {
    if (await c.page.has("chat.goToSettings")) await c.page.click("chat.goToSettings");
    else await c.settings();
    await c.page.click("settings.models");
    await c.page.waitFor("setup.customLabel");
    await c.page.click("setup.customLabel", { exact: false });
  }
  await c.page.waitFor("models.custom.name");
  await c.page.fill("models.custom.name", "E2E localhost");
  await c.ui.combo("models.custom.api", "models.custom.api.openai-completions");
  await c.page.fill("models.custom.baseUrl", `${url}/v1`);
  await c.page.fill("models.custom.key", "synthetic-e2e-local-key-only");
  await c.page.click("models.custom.addModel");
  await c.page.fill("models.custom.modelId", "fake-model");
  await c.page.fill("models.custom.contextWindow", "32768");
  await c.page.fill("models.custom.maxTokens", "4096");
  await c.page.click("models.saveAndTest");
  await until(
    "provider_test_success",
    async () => {
      const labels = c.page.texts("models.testSuccess", { count: 1 });
      return c.page.eval<boolean>(
        `(${JSON.stringify(labels)}).some(text=>document.body.innerText.includes(text))`,
      );
    },
    Boolean,
    c.signal,
    30000,
  );
  assert.equal(c.modelRequests, 1, "unexpected_setup_model_requests");
  if (!onboarding) await c.page.click("models.backToProviders", { exact: false });
  await c.ui.combo("models.defaultModel", "fake-model");
  if (onboarding) {
    await c.ui.click("common.continue");
    await c.page.waitFor("builtin.firstBot.skip");
    await c.ui.click("builtin.firstBot.skip");
    // Skipping a Bot asynchronously checks native permissions before choosing the next screen.
    await until(
      "welcome_after_bot",
      async () =>
        (await c.page.has("welcome.pi.chat")) || (await c.page.has("welcome.computer.title")),
      Boolean,
      c.signal,
      15000,
    );
    if (!(await c.page.has("welcome.pi.chat"))) {
      if (await c.page.has("welcome.computer.later")) await c.page.click("welcome.computer.later");
      else await c.ui.click("common.continue");
    }
    await c.page.waitFor("welcome.pi.chat", 15000);
    await c.page.click("welcome.pi.chat");
  } else {
    await c.page.click("settings.general");
    await c.ui.segment("language.label", "language.zh");
    await c.page.key("Escape");
  }
  await c.page.waitFor("workspace.new");
  await c.page.click("workspace.new");
  // The palette row also shows its shortcut (⌘1), so its text only starts with the label.
  await c.page.click("workspace.create", { exact: false });
  // Creation opens the role picker; the custom form sits behind the generic role.
  await c.page.click("builtin.role.custom", { exact: false });
  const name = `E2E ${c.name}`;
  await c.page.fill("builtin.custom.name", name);
  await c.page.fill("workspace.description", "Disposable local acceptance Bot");
  await c.page.fill("workspace.persona", "Execute only the supplied synthetic fixture task.");
  // The custom form has no model field: a new Bot takes the default model chosen above.
  await c.page.click("workspace.createStart");
  const bot = await until(
    "created_bot",
    async () =>
      c.db.one(
        "SELECT id,name,model_id FROM bots WHERE name=? AND archived_at IS NULL LIMIT 1",
        name,
      ),
    Boolean,
    c.signal,
  );
  assert(bot && bot.model_id === "fake-model", "created_bot_model_mismatch");
  c.bot = { id: String(bot.id), name: String(bot.name) };
  await c.page.waitFor(name);
  await c.page.click("workspace.profile", { exact: false });
  await c.page.click("workspace.panel.permissions");
  for (const [category, level] of [
    ["run_command", "ask"],
    ["web", "always"],
    ["connector", "always"],
    ["send_out", "ask"],
  ])
    await c.ui.segment(`permissions.category.${category}`, `permissions.level.${level}`);
  await c.page.key("Escape");
}
