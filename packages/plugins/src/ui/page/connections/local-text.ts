import type { ConnectorTool } from "@pibot/plugins-contract/full";
import { connectorsZh } from "@pibot/plugins-contract/i18n";

type Language = "zh" | "en";
type Translate = (key: keyof typeof connectorsZh) => string;

const CJK = /[\u3000-\u303f\u3400-\u9fff\uf900-\ufaff\uff00-\uffef]/u;

/**
 * Plugin authors write one string for both languages as "中文 / English" (title, description,
 * help). The separator is the first " / " with Chinese on one side only, so a Chinese sentence
 * that itself contains " / " ("macOS 系统框架 / Windows 经典 Outlook") stays whole.
 * Anything that does not look bilingual is shown as written.
 */
export function localText(text: string | undefined, language: Language): string {
  if (!text) return "";
  const trimmed = text.trim();
  let at = trimmed.indexOf(" / ");
  while (at > 0) {
    const zh = trimmed.slice(0, at).trim();
    const en = trimmed.slice(at + 3).trim();
    if (en && CJK.test(zh) && !CJK.test(en)) return language === "zh" ? zh : en;
    // "Example / 示例": the English half first, as some packages write it.
    if (zh && en && !CJK.test(zh) && CJK.test(en) && !en.includes(" / "))
      return language === "zh" ? en : zh;
    at = trimmed.indexOf(" / ", at + 3);
  }
  // "GitHub / GitHub": a name both languages share is written once.
  const halves = trimmed.split(" / ");
  if (halves.length === 2 && halves[0] === halves[1]) return halves[0] as string;
  return trimmed;
}

/** Chinese runs straight into the next Chinese word; a Latin name keeps its space. */
export function guideLinkKey(name: string) {
  return CJK.test([...name].at(-1) ?? "")
    ? ("connections.drawer.prepLinkCjk" as const)
    : ("connections.drawer.prepLink" as const);
}

// Words people read in a tool name; everything else is kept as the server wrote it.
const ACRONYMS = new Set(["api", "id", "ids", "url", "pr", "prs", "mcp", "sql", "csv", "pdf"]);

/**
 * A tool's name for people: the bundled translation for built-in apps, else the server's MCP
 * `title` (which may itself be "中文 / English"), else the identifier turned into words with the
 * product prefix dropped ("github_list_repositories" → "List repositories").
 */
export function toolTitle(
  tool: Pick<ConnectorTool, "tool"> & { title?: string },
  language: Language,
  t: Translate,
  /** Names whose leading words are the product prefix: the connection's, then any shared one. */
  products: readonly (string | undefined)[] = [],
) {
  const key = `connectors.tool.${tool.tool}`;
  if (Object.hasOwn(connectorsZh, key)) return t(key as keyof typeof connectorsZh);
  if (tool.title?.trim()) return localText(tool.title, language);
  const words = toolWords(tool.tool);
  for (const product of products) {
    const prefix = product
      ?.toLowerCase()
      .replace(/^pibot-/, "")
      .split(/[\s_.-]+/)
      .filter(Boolean);
    if (!prefix?.length) continue;
    // The longest run of leading words that the product name starts with ("weixin-bot" names
    // its tools "weixin_…"), or the product written as one word ("one-drive" → "onedrive_…").
    let drop = 0;
    while (drop < prefix.length && words[drop] === prefix[drop]) drop++;
    if (!drop && words[0] === prefix.join("")) drop = 1;
    if (drop && words.length > drop) {
      words.splice(0, drop);
      break;
    }
  }
  const sentence = words
    .map((word) => (ACRONYMS.has(word) ? word.toUpperCase() : word))
    .join(" ")
    .slice(0, 100);
  return sentence.replace(/^./u, (char) => char.toUpperCase()) || tool.tool;
}

function toolWords(name: string) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[\s_.:/-]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
}

/**
 * The first word every tool of a connection starts with ("github" for github_list_…,
 * github_get_…), for servers whose connection name says nothing about it (a pasted MCP JSON).
 */
export function sharedToolPrefix(names: readonly string[]) {
  if (names.length < 2) return undefined;
  const first = toolWords(names[0] as string)[0];
  return first && names.every((name) => toolWords(name)[0] === first && toolWords(name).length > 1)
    ? first
    : undefined;
}

/** The description people read: the bundled translation, else the server's own text, split. */
export function toolDescription(
  tool: Pick<ConnectorTool, "description" | "displayDescription">,
  language: Language,
) {
  return tool.displayDescription?.[language] ?? localText(tool.description, language);
}
