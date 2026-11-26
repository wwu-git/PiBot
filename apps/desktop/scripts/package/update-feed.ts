import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * electron-builder's update manifests (latest.yml, latest-mac.yml, latest-linux.yml) for the
 * generic feed at https://pibot.space/updates/. Builder writes file names relative to the feed;
 * installers are served from R2 at DOWNLOAD_ORIGIN/<version>/<file> instead, so the names become
 * absolute URLs, which electron-updater resolves as-is (it still checks sha512 and size).
 */
export const DOWNLOAD_ORIGIN = "https://pibot.space/downloads";
export const FEED_FILE = /^latest(-mac|-linux(-arm64)?)?\.yml$/;

type Entry = [key: string, raw: string];
export interface UpdateFeed {
  top: Entry[];
  files: Entry[][];
}

const unquote = (raw: string) => raw.replace(/^(['"])(.*)\1$/, "$2");
export const feedValue = (entries: Entry[], key: string) => {
  const raw = entries.find(([name]) => name === key)?.[1];
  return raw === undefined ? undefined : unquote(raw);
};

/** Parses builder's flat manifest: scalar keys plus one `files` list of scalar maps. */
export function parseFeed(text: string): UpdateFeed {
  const feed: UpdateFeed = { top: [], files: [] };
  let inFiles = false;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const top = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
    const item = /^ {2}- ([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
    const field = /^ {4}([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
    if (top?.[1] && top[2] !== undefined) {
      inFiles = top[1] === "files" && top[2] === "";
      if (!inFiles) feed.top.push([top[1], top[2]]);
    } else if (inFiles && item?.[1] && item[2] !== undefined) feed.files.push([[item[1], item[2]]]);
    else if (inFiles && field?.[1] && field[2] !== undefined && feed.files.length)
      feed.files.at(-1)?.push([field[1], field[2]]);
    else throw new Error(`Unexpected update manifest line: ${line}`);
  }
  return feed;
}

export function formatFeed(feed: UpdateFeed) {
  const lines: string[] = [];
  const [version, ...rest] = [
    ...feed.top.filter(([key]) => key === "version"),
    ...feed.top.filter(([key]) => key !== "version"),
  ];
  if (version) lines.push(`${version[0]}: ${version[1]}`);
  lines.push("files:");
  for (const file of feed.files)
    for (const [index, [key, raw]] of file.entries())
      lines.push(`${index ? "    " : "  - "}${key}: ${raw}`);
  for (const [key, raw] of rest) lines.push(`${key}: ${raw}`);
  return `${lines.join("\n")}\n`;
}

/** Points bare file names at the version's download folder; absolute URLs are left alone. */
export function absoluteFeed(feed: UpdateFeed, version: string): UpdateFeed {
  const absolute = ([key, raw]: Entry): Entry => {
    const value = unquote(raw);
    return (key === "url" || key === "path") && /^[A-Za-z0-9._-]+$/.test(value)
      ? [key, `${DOWNLOAD_ORIGIN}/${version}/${value}`]
      : [key, raw];
  };
  return { top: feed.top.map(absolute), files: feed.files.map((file) => file.map(absolute)) };
}

/** This version's manifests in a packaging output folder, by file name. */
export async function readUpdateFeeds(directory: string, version: string) {
  const feeds = new Map<string, UpdateFeed>();
  for (const name of await readdir(directory).catch(() => [] as string[])) {
    if (!FEED_FILE.test(name)) continue;
    const feed = parseFeed(await readFile(join(directory, name), "utf8"));
    if (feedValue(feed.top, "version") === version) feeds.set(name, feed);
  }
  return feeds;
}

/**
 * A second builder run into the same folder rewrites each manifest with only its own files.
 * Puts the earlier run's files (and top-level keys, which name its main installer) back first.
 */
export async function restoreUpdateFeeds(
  directory: string,
  version: string,
  earlier: Map<string, UpdateFeed>,
) {
  const later = await readUpdateFeeds(directory, version);
  for (const [name, first] of earlier) {
    const files = [...first.files];
    for (const file of later.get(name)?.files ?? [])
      if (!files.some((known) => feedValue(known, "url") === feedValue(file, "url")))
        files.push(file);
    await writeFile(join(directory, name), formatFeed({ top: first.top, files }));
  }
}

/** Rewrites every manifest builder left in a packaging output folder; returns their paths. */
export async function rewriteUpdateFeeds(directory: string, version: string) {
  const written: string[] = [];
  for (const name of await readdir(directory).catch(() => [] as string[])) {
    if (!FEED_FILE.test(name)) continue;
    const path = join(directory, name);
    const feed = parseFeed(await readFile(path, "utf8"));
    // A manifest from an older build in the same folder is not this release's.
    if (feedValue(feed.top, "version") !== version) continue;
    await writeFile(path, formatFeed(absoluteFeed(feed, version)));
    written.push(path);
  }
  return written;
}
