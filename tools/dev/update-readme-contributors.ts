import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const path = "README.md";
const start = "<!-- CONTRIBUTORS:START -->\n";
const end = "\n<!-- CONTRIBUTORS:END -->";
const readme = readFileSync(path, "utf8");
const from = readme.indexOf(start);
const to = readme.indexOf(end);
if (
  from === -1 ||
  from + start.length > to ||
  from !== readme.lastIndexOf(start) ||
  to !== readme.lastIndexOf(end)
) {
  throw new Error("Expected one contributor section in the English README");
}

function fetchContributors(): unknown {
  let body: string;
  try {
    body = execFileSync(
      "gh",
      [
        "api",
        "--hostname",
        "github.com",
        "--paginate",
        "--slurp",
        "repos/w01fb0ss/PiBot/contributors?per_page=100",
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 60_000 },
    );
  } catch {
    throw new Error("GitHub contributor request failed");
  }
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new Error("Invalid GitHub contributor response");
  }
}

const pages = fetchContributors();
const invalidResponse = () => new Error("Invalid GitHub contributor response");
if (!Array.isArray(pages) || pages.length === 0) throw invalidResponse();
const logins = new Map<string, string>();
const githubLogin = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i;
for (const page of pages) {
  if (!Array.isArray(page) || page.length === 0) throw invalidResponse();
  for (const contributor of page as unknown[]) {
    if (typeof contributor !== "object" || !contributor || !("type" in contributor))
      throw invalidResponse();
    if (contributor.type === "Anonymous") continue;
    if (!("login" in contributor) || typeof contributor.login !== "string") throw invalidResponse();
    if (contributor.type === "Bot") continue;
    if (contributor.type !== "User" || !githubLogin.test(contributor.login))
      throw invalidResponse();
    const key = contributor.login.toLowerCase();
    if (!logins.has(key)) logins.set(key, contributor.login);
  }
}
if (logins.size === 0) throw new Error("No linked GitHub contributors found");

const list = [...logins.values()]
  .map((login) => `- [@${login}](https://github.com/${login})`)
  .join("\n");
const updated = readme.slice(0, from + start.length) + list + readme.slice(to);
if (updated !== readme) writeFileSync(path, updated);
