// Exercises the real SQLite migration and repository contracts in temporary data directories.
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { BotSchema, MessageSchema } from "@pibot/protocol-base";
import { createRedactor, type SecretCipher } from "@pibot/secrets";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProvidersRepo } from "../../models/src/store/index.ts";
import {
  BotsRepo,
  ConversationsRepo,
  DEFAULT_SETTINGS,
  MessagesRepo,
  openDatabase,
  resolveDataDir,
  runMigrations,
  SecretStore,
  SettingsRepo,
} from "../src/index.ts";

let dir: string;
let db: DatabaseSync;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pibot-store-"));
  const dataDir = resolveDataDir({
    platform: process.platform,
    env: { PIBOT_DATA_DIR: dir },
    homedir: dir,
    dev: true,
  });
  db = openDatabase(join(dataDir, "pibot.db"));
});
afterEach(() => {
  vi.useRealTimers();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("resolveDataDir", () => {
  it.each([
    ["darwin", false, {}, "/home/test/Library/Application Support/Pi Bot"],
    ["darwin", true, {}, "/home/test/Library/Application Support/Pi Bot Dev"],
    ["linux", false, {}, "/home/test/.local/share/pi-bot"],
    ["linux", true, {}, "/home/test/.local/share/pi-bot-dev"],
    ["linux", false, { XDG_DATA_HOME: "/xdg" }, "/xdg/pi-bot"],
    ["linux", true, { XDG_DATA_HOME: "/xdg" }, "/xdg/pi-bot-dev"],
    ["win32", false, { APPDATA: "C:\\Roaming" }, "C:\\Roaming\\Pi Bot"],
    ["win32", true, { APPDATA: "C:\\Roaming" }, "C:\\Roaming\\Pi Bot Dev"],
  ] as const)("%s dev=%s env=%j", (platform, dev, env, expected) => {
    const frozenEnv = Object.freeze(env);
    expect(resolveDataDir({ platform, dev, env: frozenEnv, homedir: "/home/test" })).toBe(expected);
  });

  it.each([false, true])("uses the Windows roaming fallback dev=%s", (dev) => {
    expect(resolveDataDir({ platform: "win32", dev, env: {}, homedir: "C:\\Users\\test" })).toBe(
      `C:\\Users\\test\\AppData\\Roaming\\${dev ? "Pi Bot Dev" : "Pi Bot"}`,
    );
  });

  it.each(["darwin", "win32", "linux"] as const)("override wins on %s", (platform) => {
    for (const dev of [false, true]) {
      expect(
        resolveDataDir({
          platform,
          dev,
          homedir: dir,
          env: { PIBOT_DATA_DIR: dir, APPDATA: "ignored", XDG_DATA_HOME: "ignored" },
        }),
      ).toBe(dir);
    }
  });

  it("rejects unsupported platforms", () => {
    expect(() =>
      resolveDataDir({ platform: "freebsd", env: {}, homedir: dir, dev: false }),
    ).toThrow("Unsupported platform");
  });
});

describe("database and migrations", () => {
  it("opens WAL with foreign keys, migrates an empty database and persists across reopen", () => {
    expect(db.prepare("PRAGMA journal_mode").get()?.journal_mode).toBe("wal");
    expect(db.prepare("PRAGMA foreign_keys").get()?.foreign_keys).toBe(1);
    runMigrations(db);
    expect(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all()
        .map((row) => row.name),
    ).toEqual([
      "app_blocklist",
      "approvals",
      "attachments",
      "audit_log",
      "background_commands",
      "background_completion_runs",
      "background_task_health",
      "bot_auto_check",
      "bot_computer_always",
      "bot_sessions",
      "bot_workplace",
      "bots",
      "budget_events",
      "builtin_bot_baselines",
      "builtin_group_baselines",
      "builtin_recoveries",
      "builtin_skill_removals",
      "capability_selection",
      "chat_approval_pauses",
      "chat_notices",
      "chat_search_backfill",
      "chat_search_documents",
      "chat_search_fts",
      "chat_search_fts_config",
      "chat_search_fts_data",
      "chat_search_fts_docsize",
      "chat_search_fts_idx",
      "code_files",
      "code_roots",
      "code_symbols",
      "computer_grants",
      "computer_steps",
      "connection_access_migrations",
      "connection_confirmation_restores",
      "connector_access",
      "connector_diagnostics",
      "connector_operations",
      "connector_tool_denials",
      "connector_tool_overrides",
      "connector_tools",
      "connectors",
      "continuation_intents",
      "continuation_ledgers",
      "conversation_retries",
      "conversation_retry_boundaries",
      "conversations",
      "delivery_evidence",
      "endpoint_capabilities",
      "execution_budgets",
      "execution_checkpoints",
      "execution_plan_archive",
      "execution_settings",
      "execution_todo",
      "external_agent_bots",
      "external_agent_confirmations",
      "external_agent_sessions",
      "file_checkpoint_items",
      "file_checkpoints",
      "file_restore_items",
      "file_restore_operations",
      "folder_checks",
      "grants",
      "group_computer_app_names",
      "group_current_topics",
      "group_cycles",
      "group_execution_limits",
      "group_folders",
      "group_member_skills",
      "group_member_workspaces",
      "group_members",
      "group_memories",
      "group_memory_proposals",
      "group_permissions",
      "group_task_handoffs",
      "group_task_origins",
      "group_task_results",
      "group_task_sources",
      "group_tasks",
      "group_topic_creations",
      "group_topic_workspaces",
      "group_workflow_runs",
      "group_workflow_steps",
      "group_workspace",
      "groups",
      "image_artifacts",
      "image_workspace_receipts",
      "import_folder_records",
      "import_folders",
      "import_jobs",
      "import_memories",
      "import_memory_usage",
      "import_personas",
      "import_project_files",
      "import_project_notes",
      "knowledge_assignments",
      "knowledge_managed_installations",
      "knowledge_sources",
      "managed_git_operations",
      "managed_worktree_bindings",
      "managed_worktrees",
      "memories",
      "memory_aliases",
      "memory_dream_runs",
      "memory_dream_source_facts",
      "memory_dream_source_watermarks",
      "memory_extractions",
      "memory_fts",
      "memory_fts_config",
      "memory_fts_data",
      "memory_fts_docsize",
      "memory_fts_idx",
      "memory_organizations",
      "memory_projects",
      "memory_proposals",
      "memory_recall_metrics",
      "memory_recall_observations",
      "memory_revisions",
      "memory_scope_moves",
      "message_attachment_links",
      "message_transfers",
      "messages",
      "office_render_checks",
      "personal_todos",
      "pi_dispatches",
      "plugin_access",
      "plugin_installations",
      "plugin_skill_access",
      "plugin_skill_copies",
      "plugin_skill_copy_jobs",
      "plugin_skill_copy_migrations",
      "power_events",
      "providers",
      "recordings",
      "remote_devices",
      "remote_offline_bots_off",
      "remote_offline_items",
      "remote_offline_models",
      "remote_offline_providers",
      "remote_offline_topics",
      "remote_runner_phone_control",
      "remote_send_receipts",
      "remote_settings",
      "review_executions",
      "review_findings",
      "review_runs",
      "routine_preauth",
      "routine_proposals",
      "routine_run_ledger",
      "routine_runs",
      "routine_triggers",
      "routine_workflow_retirements",
      "routines",
      "run_diagnostics",
      "run_events",
      "run_file_changes",
      "run_recovery",
      "runs",
      "schema_migrations",
      "scoped_memories",
      "scoped_memory_proposals",
      "secret_revision_sequence",
      "secrets",
      "secrets_meta",
      "send_drafts",
      "settings",
      "sidebar_entries",
      "sidebar_groups",
      "site_credential_bots",
      "site_credentials",
      "skill_document_metadata",
      "skill_packages",
      "skill_proposals",
      "skill_updates",
      "skills",
      "sqlite_sequence",
      "task_attempts",
      "task_instances",
      "task_messages",
      "tool_calls",
      "tool_diagnostics",
      "tool_executions",
      "topic_folders",
      "topic_writable_folders",
      "working_folders",
      "worktree_allocations",
    ]);
    const versions = db.prepare("SELECT * FROM schema_migrations").all();
    expect(versions).toHaveLength(183);
    expect(versions.at(-1)?.version).toBe(185);
    expect(versions[0]?.version).toBe(1);
    expect(String(versions[0]?.applied_at)).toMatch(/Z$/);
    const bot = new BotsRepo(db).ensureMainBot();
    runMigrations(db);
    expect(db.prepare("SELECT * FROM schema_migrations").all()).toEqual(versions);
    db.close();
    db = openDatabase(join(dir, "pibot.db"));
    runMigrations(db);
    expect(new BotsRepo(db).get(bot.id)).toEqual(bot);
  }, 20_000);

  it("upgrades a prd database with previously assigned migration numbers", () => {
    const previous = join(dir, "previous");
    mkdirSync(previous);
    const current = new URL("../migrations/", import.meta.url);
    for (const file of readdirSync(current)) {
      if (Number(file.split("_")[0]) < 176)
        writeFileSync(join(previous, file), readFileSync(new URL(file, current)));
    }
    for (const [from, to] of [
      ["0184_mcp_direct_read_write.sql", "0176_mcp_direct_read_write.sql"],
      ["0185_antigravity_agent.sql", "0177_antigravity_agent.sql"],
    ] as const)
      writeFileSync(join(previous, to), readFileSync(new URL(from, current)));
    runMigrations(db, previous);
    const localVersions = db
      .prepare(
        "SELECT applied_at FROM schema_migrations WHERE version IN (176, 177) ORDER BY version",
      )
      .all();
    runMigrations(db);
    runMigrations(db);
    expect(
      db
        .prepare(
          "SELECT applied_at FROM schema_migrations WHERE version IN (184, 185) ORDER BY version",
        )
        .all(),
    ).toEqual(localVersions);
    expect(db.prepare("SELECT cleanup_phase FROM import_jobs").all()).toEqual([]);
    expect(db.prepare("SELECT kind FROM scoped_memories").all()).toEqual([]);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("executes versions numerically and rolls back a failed migration", () => {
    const migrations = join(dir, "migrations");
    mkdirSync(migrations);
    writeFileSync(join(migrations, "10_ten.sql"), "INSERT INTO probe VALUES (10);");
    writeFileSync(
      join(migrations, "2_two.sql"),
      "CREATE TABLE probe (version INTEGER); INSERT INTO probe VALUES (2);",
    );
    writeFileSync(
      join(migrations, "11_bad.sql"),
      "CREATE TABLE rollback_probe (id INTEGER); INSERT INTO missing_table VALUES (1);",
    );
    expect(() => runMigrations(db, migrations)).toThrow();
    expect(
      db
        .prepare("SELECT version FROM probe ORDER BY rowid")
        .all()
        .map((row) => row.version),
    ).toEqual([2, 10]);
    expect(
      db
        .prepare("SELECT version FROM schema_migrations ORDER BY version")
        .all()
        .map((row) => row.version),
    ).toEqual([2, 10]);
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name = 'rollback_probe'").get(),
    ).toBeUndefined();
    writeFileSync(join(migrations, "11_bad.sql"), "INSERT INTO probe VALUES (11);");
    runMigrations(db, migrations);
    runMigrations(db, migrations);
    expect(db.prepare("SELECT COUNT(*) AS count FROM probe").get()?.count).toBe(3);
  });

  it("rejects duplicate migration versions before applying SQL", () => {
    const migrations = join(dir, "duplicates");
    mkdirSync(migrations);
    writeFileSync(join(migrations, "0001_a.sql"), "CREATE TABLE unexpected (id INTEGER);");
    writeFileSync(join(migrations, "1_b.sql"), "SELECT 1;");
    expect(() => runMigrations(db, migrations)).toThrow("duplicate migration");
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()).toHaveLength(0);
  });

  it("enforces every specified CHECK, UNIQUE and foreign key", () => {
    runMigrations(db);
    const bot = new BotsRepo(db).ensureMainBot();
    const conversation = new ConversationsRepo(db).create({ botId: bot.id });
    expect(() =>
      db
        .prepare(
          "INSERT INTO conversations(id,kind,bot_id,pi_session_file,created_at,updated_at) VALUES (?, ?, ?, NULL, ?, ?)",
        )
        .run(randomUUID(), "group", bot.id, "now", "now"),
    ).toThrow(/CHECK/);
    expect(() => new ConversationsRepo(db).create({ botId: randomUUID() })).toThrow(/FOREIGN KEY/);
    for (const [role, status] of [
      ["system", "done"],
      ["user", "pending"],
    ] as const) {
      expect(() =>
        db
          .prepare(
            "INSERT INTO messages(id,conversation_id,role,content,status,run_id,error_code,usage,created_at,updated_at) VALUES (?, ?, ?, '', ?, NULL, NULL, NULL, ?, ?)",
          )
          .run(randomUUID(), conversation.id, role, status, "now", "now"),
      ).toThrow(/CHECK/);
    }
    expect(() =>
      db.prepare("INSERT INTO providers VALUES ('bad', 'unknown', '{}', 'now', 'now')").run(),
    ).toThrow(/CHECK/);
    const secret =
      db.prepare(`INSERT INTO secrets (id, scope, name, ciphertext, created_at, last_used_at)
      VALUES (?, 'scope', 'name', ?, 'now', NULL)`);
    secret.run(randomUUID(), new Uint8Array([1]));
    expect(() => secret.run(randomUUID(), new Uint8Array([2]))).toThrow(/UNIQUE/);
    expect(() => new BotsRepo(db).remove(bot.id)).toThrow(/main Bot/);
    expect(() =>
      new MessagesRepo(db).create({
        conversationId: randomUUID(),
        role: "user",
        content: "x",
        status: "done",
      }),
    ).toThrow(/Unknown conversation/);
  });
});

describe("repositories", () => {
  // Running every migration can exceed the 10 s default when the machine is busy (verify, 2026-11-16).
  beforeEach(() => runMigrations(db), 30_000);

  it("reads defaults, persists partial settings, resets deleted settings and rejects invalid input atomically", () => {
    const settings = new SettingsRepo(db);
    expect(settings.get()).toEqual(DEFAULT_SETTINGS);
    expect(settings.set({ language: "zh", theme: "dark", openAtLogin: false })).toEqual({
      ...DEFAULT_SETTINGS,
      language: "zh",
      theme: "dark",
      openAtLogin: false,
    });
    expect(settings.set({ onboardingCompleted: true }).language).toBe("zh");
    expect(() => settings.set({ language: "invalid", theme: "light" } as never)).toThrow();
    expect(settings.get().theme).toBe("dark");
    expect(settings.remove("theme")).toBe(true);
    expect(settings.get().theme).toBe("system");
    expect(settings.remove("theme")).toBe(false);
    expect(db.prepare("SELECT value FROM settings WHERE key = 'language'").get()?.value).toBe(
      '"zh"',
    );
  });

  it("ensures Pi once and preserves later model, avatar and persona edits", () => {
    const bots = new BotsRepo(db);
    const pi = bots.ensureMainBot("test persona");
    expect(pi).toMatchObject({
      name: "Pi",
      isMain: true,
      avatarShape: "blob",
      avatarColor: "violet",
      avatarEyes: "marks",
      modelProvider: null,
      modelId: null,
      thinkingLevel: "off",
      systemPrompt: "test persona",
    });
    expect(BotSchema.safeParse(pi).success).toBe(true);
    expect(bots.ensureMainBot("different persona")).toEqual(pi);
    const changed = bots.update(pi.id, {
      modelProvider: "openai",
      modelId: "test-model",
      thinkingLevel: "high",
      avatarColor: "blue",
    });
    expect(bots.ensureMainBot()).toEqual(changed);
    expect(bots.list()).toHaveLength(1);
    expect(bots.update(pi.id, { modelId: null })?.modelId).toBeNull();
    expect(() => bots.update(pi.id, { thinkingLevel: "invalid" } as never)).toThrow();
    expect(bots.update(randomUUID(), { name: "missing" })).toBeUndefined();
    const second = bots.create({
      name: "Another",
      isMain: false,
      avatarShape: "blob",
      avatarColor: "orange",
      avatarEyes: "marks",
      modelProvider: null,
      modelId: null,
      thinkingLevel: "off",
      systemPrompt: "",
    });
    expect(bots.get(second.id)).toEqual(second);
    expect(bots.remove(second.id)).toBe(true);
    expect(bots.remove(second.id)).toBe(false);
    expect(bots.get(second.id)).toBeUndefined();
  });

  it("creates, lists, updates and removes conversations without silently dropping history", () => {
    const bot = new BotsRepo(db).ensureMainBot();
    const conversations = new ConversationsRepo(db);
    const conversation = conversations.ensureDm(bot.id);
    expect(conversations.ensureDm(bot.id)).toEqual(conversation);
    expect(conversation).toMatchObject({ botId: bot.id, kind: "dm", piSessionFile: null });
    const sessionFile = join(dir, "sessions", "example.jsonl");
    expect(
      conversations.update(conversation.id, { piSessionFile: sessionFile })?.piSessionFile,
    ).toBe(sessionFile);
    expect(conversations.list(bot.id)).toHaveLength(1);
    expect(conversations.list(randomUUID())).toEqual([]);
    const second = conversations.create({ botId: bot.id, piSessionFile: sessionFile });
    expect(conversations.list()).toHaveLength(2);
    expect(conversations.update(second.id, { piSessionFile: null })?.piSessionFile).toBeNull();
    const messages = new MessagesRepo(db);
    const message = messages.create({
      conversationId: conversation.id,
      role: "user",
      content: "hello",
      status: "done",
    });
    expect(() => conversations.remove(conversation.id)).toThrow(/FOREIGN KEY/);
    messages.remove(message.id);
    expect(conversations.remove(conversation.id)).toBe(true);
    expect(conversations.get(conversation.id)).toBeUndefined();
    expect(conversations.update(conversation.id, { piSessionFile: null })).toBeUndefined();
    expect(conversations.remove(conversation.id)).toBe(false);
  });

  it("stores message updates, JSON usage, run IDs and errors", () => {
    const bot = new BotsRepo(db).ensureMainBot();
    const conversation = new ConversationsRepo(db).ensureDm(bot.id);
    const messages = new MessagesRepo(db);
    const runId = randomUUID();
    const message = messages.create({
      conversationId: conversation.id,
      role: "assistant",
      content: "",
      status: "streaming",
      runId,
    });
    expect(MessageSchema.safeParse(message).success).toBe(true);
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.parse(message.createdAt) + 1000));
    const updated = messages.update(message.id, {
      content: "partial",
      status: "error",
      errorCode: "network",
      usage: { tokens: 3 },
    });
    expect(updated).toMatchObject({
      content: "partial",
      status: "error",
      errorCode: "network",
      usage: { tokens: 3 },
      runId,
      createdAt: message.createdAt,
    });
    expect(updated?.updatedAt).not.toBe(message.updatedAt);
    expect(messages.get(message.id)).toEqual(updated);
    expect(
      messages.update(message.id, { status: "aborted", errorCode: null, usage: null })?.usage,
    ).toBeNull();
    expect(() => messages.update(message.id, { status: "invalid" } as never)).toThrow();
    expect(messages.remove(message.id)).toBe(true);
    expect(messages.remove(message.id)).toBe(false);
    expect(messages.get(message.id)).toBeUndefined();
    expect(messages.update(message.id, { status: "done" })).toBeUndefined();
  });

  it("paginates 123 same-timestamp messages with no gaps or duplicates and isolates conversations", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const bot = new BotsRepo(db).ensureMainBot();
    const conversations = new ConversationsRepo(db);
    const conversation = conversations.ensureDm(bot.id);
    const other = conversations.create({ botId: bot.id });
    const messages = new MessagesRepo(db);
    const all = Array.from({ length: 123 }, (_, index) =>
      messages.create({
        conversationId: conversation.id,
        role: "user",
        content: String(index),
        status: "done",
      }),
    );
    const foreign = messages.create({
      conversationId: other.id,
      role: "user",
      content: "foreign",
      status: "done",
    });
    const first = messages.list(conversation.id);
    const second = messages.list(conversation.id, { before: first[0]?.id });
    const third = messages.list(conversation.id, { before: second[0]?.id });
    expect(first).toEqual(all.slice(73));
    expect(second).toEqual(all.slice(23, 73));
    expect(third).toEqual(all.slice(0, 23));
    expect([...third, ...second, ...first]).toEqual(all);
    expect(messages.list(conversation.id, { before: all[0]?.id })).toEqual([]);
    expect(messages.list(conversation.id, { before: foreign.id })).toEqual([]);
    expect(messages.list(conversation.id, { before: randomUUID() })).toEqual([]);
    expect(messages.list(conversation.id, { limit: 1 })).toEqual(all.slice(-1));
    expect(messages.list(other.id)).toEqual([foreign]);
    for (const limit of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => messages.list(conversation.id, { limit })).toThrow("Invalid message limit");
    }
  });

  it("orders by creation time before using insertion order as a tie breaker", () => {
    const bot = new BotsRepo(db).ensureMainBot();
    const conversation = new ConversationsRepo(db).ensureDm(bot.id);
    const messages = new MessagesRepo(db);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-02T00:00:00.000Z"));
    const later = messages.create({
      conversationId: conversation.id,
      role: "user",
      content: "later",
      status: "done",
    });
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const earlier = messages.create({
      conversationId: conversation.id,
      role: "user",
      content: "earlier",
      status: "done",
    });
    expect(messages.list(conversation.id)).toEqual([earlier, later]);
    expect(messages.list(conversation.id, { before: later.id })).toEqual([earlier]);
  });

  it("upserts, reads, lists and removes providers with JSON config", () => {
    const providers = new ProvidersRepo(db);
    const initial = providers.upsert({ id: "openai", kind: "builtin", config: { name: "OpenAI" } });
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.parse(initial.createdAt) + 1000));
    const updated = providers.upsert({
      id: "openai",
      kind: "builtin",
      config: { name: "Updated" },
    });
    expect(updated.createdAt).toBe(initial.createdAt);
    expect(updated.updatedAt).not.toBe(initial.updatedAt);
    expect(providers.get("openai")).toEqual(updated);
    const custom = providers.upsert({
      id: "local",
      kind: "custom",
      config: {
        name: "Local",
        baseUrl: "http://127.0.0.1:11434/v1",
        api: "openai-completions",
        models: [{ id: "local-model", maxTokens: 2048 }],
        headers: { "X-Client": "Pi Bot" },
        compat: { supportsDeveloperRole: false },
      },
    });
    expect(providers.list()).toEqual([updated, custom]);
    expect(providers.remove("openai")).toBe(true);
    expect(providers.remove("openai")).toBe(false);
    expect(providers.get("openai")).toBeUndefined();
  });

  it.each([
    { apiKey: "fake" },
    { apiToken: "fake" },
    { accessKeyId: "fake" },
    { access_key: "fake" },
    { signingKey: "fake" },
    { pwd: "fake" },
    { nested: { api_key: "fake" } },
    { items: [{ accessToken: "fake" }] },
    { clientSecret: "fake" },
    { password: "fake" },
    { credentials: { value: "fake" } },
    { headers: { Authorization: "Bearer fake" } },
    { headers: { "x-api-key": "fake" } },
    { headers: { Cookie: "session=fake" } },
    { headers: { "X-Client": "!command" } },
    { headers: { "X-Client": "a\r\nb" } },
  ])("rejects sensitive or unsafe config %j before writing", (config) => {
    const providers = new ProvidersRepo(db);
    providers.upsert({ id: "test", kind: "builtin", config: { name: "original" } });
    const original = providers.get("test");
    expect(() =>
      providers.upsert({ id: "test", kind: "builtin", config: config as never }),
    ).toThrow();
    expect(providers.get("test")).toEqual(original);
  });

  it("validates the serialized config and custom provider schema", () => {
    const providers = new ProvidersRepo(db);
    expect(() =>
      providers.upsert({
        id: "test",
        kind: "builtin",
        config: {
          toJSON: () => ({ apiKey: "smuggled" }),
        } as never,
      }),
    ).toThrow("must not contain secrets");
    expect(() =>
      providers.upsert({ id: "bad", kind: "custom", config: { name: "Missing fields" } }),
    ).toThrow();
    expect(providers.list()).toEqual([]);
  });
});

describe("SecretStore", () => {
  // A reversible test cipher, deliberately not suitable for production encryption.
  const cipher: SecretCipher = {
    isAvailable: async () => true,
    encrypt: async (plain) => Uint8Array.from(Buffer.from(plain), (byte) => byte ^ 0xa5),
    decrypt: async (encrypted) => Buffer.from(encrypted.map((byte) => byte ^ 0xa5)).toString(),
  };
  // Running every migration can exceed the 10 s default when the machine is busy (verify, 2026-11-16).
  beforeEach(() => runMigrations(db), 30_000);

  it("roundtrips only ciphertext, registers decrypted values and preserves UNIQUE metadata on replacement", async () => {
    const redactor = createRedactor();
    const store = new SecretStore(db, cipher, redactor);
    const value = "opaque-test-credential-1234";
    expect(store.has("provider:test", "apiKey")).toBe(false);
    expect(await store.get("provider:test", "apiKey")).toBeUndefined();
    expect(await store.hint("provider:test", "apiKey")).toBeUndefined();
    await store.set("provider:test", "apiKey", value);
    expect(redactor.redact(value)).toBe("[REDACTED]");
    expect(store.has("provider:test", "apiKey")).toBe(true);
    const row = db.prepare("SELECT * FROM secrets").get();
    expect(row?.ciphertext).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(row?.ciphertext as Uint8Array).includes(value)).toBe(false);
    expect(row?.last_used_at).toBeNull();
    const freshRedactor = createRedactor();
    const reopenedStore = new SecretStore(db, cipher, freshRedactor);
    expect(await reopenedStore.get("provider:test", "apiKey")).toBe(value);
    expect(freshRedactor.redact(`key=${value}`)).toBe("key=[REDACTED]");
    expect(await reopenedStore.hint("provider:test", "apiKey")).toBe("1234");
    expect(db.prepare("SELECT last_used_at FROM secrets").get()?.last_used_at).toMatch(/Z$/);
    await store.set("provider:test", "apiKey", "replacement-5678");
    expect(await store.get("provider:test", "apiKey")).toBe("replacement-5678");
    const replaced = db.prepare("SELECT * FROM secrets").get();
    expect(replaced?.id).toBe(row?.id);
    expect(replaced?.created_at).toBe(row?.created_at);
    expect(db.prepare("SELECT COUNT(*) AS count FROM secrets").get()?.count).toBe(1);
    await store.set("provider:other", "apiKey", "other-9999");
    await store.set("provider:test", "another", "another-8888");
    // Search the database and WAL bytes as well as the queried columns.
    db.exec("PRAGMA wal_checkpoint(FULL)");
    for (const filename of ["pibot.db", "pibot.db-wal"]) {
      const bytes = readFileSync(join(dir, filename));
      for (const secret of [value, "replacement-5678", "other-9999", "another-8888"]) {
        expect(bytes.includes(secret)).toBe(false);
      }
    }
    expect(store.remove("provider:test", "apiKey")).toBe(true);
    expect(store.remove("provider:test", "apiKey")).toBe(false);
    expect(store.has("provider:test", "apiKey")).toBe(false);
    expect(await store.get("provider:test", "apiKey")).toBeUndefined();
    expect(store.has("provider:other", "apiKey")).toBe(true);
  });

  it.each(["", " leading", "trailing ", "a\nb", "a\rb", "!command"])(
    "rejects unsafe value without invoking cipher",
    async (value) => {
      const encrypt = vi.fn(cipher.encrypt);
      const store = new SecretStore(db, { ...cipher, encrypt }, createRedactor());
      await expect(store.set("scope", "name", value)).rejects.toThrow("Unsafe secret value");
      expect(encrypt).not.toHaveBeenCalled();
      expect(store.has("scope", "name")).toBe(false);
    },
  );

  it("never saves plaintext or destroys an existing value if encryption is unavailable or fails", async () => {
    const store = new SecretStore(db, cipher, createRedactor());
    await store.set("scope", "name", "original");
    const unavailable = new SecretStore(
      db,
      { ...cipher, isAvailable: async () => false },
      createRedactor(),
    );
    await expect(unavailable.set("scope", "name", "replacement")).rejects.toThrow("unavailable");
    await expect(unavailable.get("scope", "name")).rejects.toThrow("unavailable");
    const failing = new SecretStore(
      db,
      {
        ...cipher,
        encrypt: async () => {
          throw new Error("test failure");
        },
      },
      createRedactor(),
    );
    await expect(failing.set("scope", "name", "replacement")).rejects.toThrow("test failure");
    expect(await store.get("scope", "name")).toBe("original");
  });
});
