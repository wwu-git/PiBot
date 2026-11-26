// Checks the desktop welcome and settings surfaces in both UI languages.
import { createTranslator, type Language } from "@pibot/i18n";
import { ProviderForm, type Task } from "@pibot/models/ui";
import type { Provider, Settings } from "@pibot/protocol";
import { ThemeProvider } from "@pibot/ui";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WelcomeFlow } from "../welcome/index.tsx";
import { AppearanceControls } from "./appearance.tsx";
import { SettingsScreen } from "./index.tsx";

// Vitest's default CSS stub is empty, including raw CSS imports. Use the actual
// UI palette here so the preview scoping is checked against the shared source.
vi.mock("@pibot/ui/tokens.css?raw", async () => {
  const { readFileSync } = await import("node:fs");
  return {
    default: readFileSync(
      new URL("../../../../../../packages/ui/src/theme/tokens.css", import.meta.url),
      "utf8",
    ),
  };
});

const context = vi.hoisted(() => ({
  language: "zh" as Language,
  update: vi.fn(),
  navigate: vi.fn(),
}));
const settings: Settings = {
  language: "system",
  theme: "system",
  onboardingCompleted: false,
  openAtLogin: true,
  showTrayIcon: true,
  closeToTrayHintShown: false,
};
// The shell hooks live in the renderer kit. Mock its context modules rather than the
// index, so kit-internal imports (widgets) see the same fakes.
vi.mock(
  "../../../../../../packages/renderer-kit/src/settings/context.ts",
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    useSettings: () => ({
      settings,
      update: context.update,
      language: context.language,
      t: createTranslator(context.language),
    }),
    useT: () => createTranslator(context.language),
  }),
);
vi.mock("../../../../../../packages/renderer-kit/src/rpc/context.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useRpc: () => ({ peer: null, state: "ready" }),
  useRpcEvent: () => {},
}));
vi.mock(
  "../../../../../../packages/renderer-kit/src/navigation/context.ts",
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    useNavigation: () => ({ openSettings: context.navigate }),
  }),
);
const provider: Provider = {
  id: "openai",
  name: "OpenAI",
  group: "common",
  auth: "apiKey",
  modelCount: 10,
  configured: true,
  keyHint: "1234",
  envDetected: true,
  envVarName: "OPENAI_API_KEY",
  available: true,
};
const task: Task = {
  busy: false,
  isBusy: () => false,
  blocked: false,
  error: undefined,
  errorKey: undefined,
  success: undefined,
  setSuccess: vi.fn(),
  run: vi.fn(),
};
const render = (element: React.ReactNode) =>
  renderToStaticMarkup(<ThemeProvider theme="dark">{element}</ThemeProvider>);
beforeEach(() => {
  context.language = "zh";
});

describe("welcome and settings static rendering", () => {
  it.each(["zh", "en"] as const)(
    "renders welcome values, switches and five progress steps in %s",
    (language) => {
      context.language = language;
      const t = createTranslator(language);
      const html = render(<WelcomeFlow onDone={() => {}} />);
      expect(html).toContain(t("welcome.title"));
      for (const value of ["team", "local", "approval"] as const)
        expect(html).toContain(t(`welcome.value.${value}.title`));
      expect(html).toContain(t("welcome.progress", { step: 1, total: 5 }));
      expect(html.match(/<li/g)).toHaveLength(5);
      expect(html).toContain('value="system"');
      expect(html).not.toContain("WelcomeFlow (");
    },
  );
  it.each(["zh", "en"] as const)(
    "renders the settings destinations and a close action in %s",
    (language) => {
      context.language = language;
      const t = createTranslator(language);
      const html = render(<SettingsScreen section="general" onClose={() => {}} />);
      const nav = html.match(/<nav[\s\S]*?<\/nav>/)?.[0] ?? "";
      expect(nav.match(/<button/g)).toHaveLength(7);
      expect(nav).toContain(t("settings.browser"));
      expect(nav).toContain(t("settings.general"));
      expect(nav).toContain(t("settings.models").replaceAll("&", "&amp;"));
      expect(html).toContain(t("setup.close"));
      // 登录这台电脑时 is a segmented choice; the live island, tray and proxy switches remain.
      expect(html.match(/role="switch"/g)).toHaveLength(3);
    },
  );
  it("keeps previews in the UI palettes independent of the document theme", () => {
    const html = render(<AppearanceControls previews disabled={false} onChange={() => {}} />);
    expect(html).toContain('data-setup-preview="light"');
    expect(html.match(/role="img" data-setup-preview="dark"/g)).toHaveLength(1);
    expect(html).toContain('[data-setup-preview="light"]');
    expect(html).toContain('[data-setup-preview="dark"]');
  });
  it("shows only the key hint, password input and explicit environment import", () => {
    const html = render(<ProviderForm provider={provider} task={task} refresh={async () => {}} />);
    expect(html).toContain("已保存 · 末尾 4 位 1234");
    expect(html).toContain('type="password"');
    expect(html).toContain('value=""');
    expect(html).toContain("OPENAI_API_KEY");
    expect(html).toContain("导入");
    expect(html).not.toContain("fake-key");
  });
  it("disables credential entry when safe storage has failed", () => {
    const html = render(
      <ProviderForm
        provider={provider}
        task={{ ...task, blocked: true, error: "这台电脑没有系统密钥库，Key 无法安全保存。" }}
        refresh={async () => {}}
      />,
    );
    expect(html.match(/<input[^>]*type="password"[^>]*>/)?.[0]).toContain("disabled");
    expect(html).toContain('role="alert"');
  });
  it.each(["oauth", "cloud"] as const)(
    "renders %s as coming soon without credential inputs",
    (auth) => {
      const html = render(
        <ProviderForm
          provider={{ ...provider, auth, configured: false, available: false, keyHint: undefined }}
          task={task}
          refresh={async () => {}}
        />,
      );
      expect(html).toContain("即将支持");
      expect(html).not.toContain('type="password"');
      expect(html).not.toContain("保存并测试");
    },
  );
  it("renders the custom interface picker, compatibility choices and manual model fallback", () => {
    const html = render(
      <ProviderForm
        provider={{
          ...provider,
          id: "new-custom",
          auth: "custom",
          configured: false,
          keyHint: undefined,
        }}
        task={task}
        refresh={async () => {}}
      />,
    );
    // The closed application picker renders its selection; options mount when opened.
    expect(html).toContain('role="combobox"');
    expect(html).toContain("OpenAI Chat Completions");
    expect(html).toContain("手动添加模型");
    expect(html).toContain("用 system 角色代替 developer 角色");
    expect(html).toContain("不发送思考强度参数");
    expect(html).toContain("清空已保存请求头");
  });
});
