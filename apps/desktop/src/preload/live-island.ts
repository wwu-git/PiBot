import {
  AVATAR_COLORS,
  type AvatarEyes,
  type AvatarShape,
  avatarPaths,
  avatarShapes,
} from "@pibot/ui/avatar-paths";
import { ipcRenderer } from "electron";
import {
  type IslandState,
  IslandStateSchema,
  LIVE_ISLAND_ACTION,
  LIVE_ISLAND_READY,
  LIVE_ISLAND_STATE,
} from "../shared/live-island.ts";

// Live island page. The page itself has no script (CSP default-src 'none'); this sandboxed
// preload draws the pill with DOM APIs and textContent only, and sends clicks and the pill's
// size back to the process that owns the window. Nothing is exposed to the page's main world.

const SVG = "http://www.w3.org/2000/svg";
const EYES = new Set(["marks", "dot", "oval", "pixel", "sleepy"]);
const COLORS = new Set<string>(AVATAR_COLORS);
// Trackpads send many small wheel events per gesture; one flip per this much travel and time.
const WHEEL_STEP = 40;
const FLIP_GAP_MS = 320;

let state: IslandState | undefined;
let currentKey: string | undefined;
let hovering = false;
let wheel = 0;
let lastFlip = 0;
let flipped = false;
let ticker: ReturnType<typeof setInterval> | undefined;
let reported = "";

const send = (action: Record<string, unknown>) => ipcRenderer.send(LIVE_ISLAND_ACTION, action);

function face(avatar: IslandState["items"][number]["avatar"]) {
  const wrap = document.createElement("span");
  wrap.className = "face";
  if (avatar.image) {
    const image = document.createElement("img");
    image.src = avatar.image;
    image.alt = "";
    wrap.append(image);
    return wrap;
  }
  const shape = (Object.hasOwn(avatarShapes, avatar.shape) ? avatar.shape : "blob") as AvatarShape;
  const eyes = (EYES.has(avatar.eyes) ? avatar.eyes : "marks") as AvatarEyes;
  const color = COLORS.has(avatar.color) ? avatar.color : "violet";
  const paths = avatarPaths(shape, eyes, "working");
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "-8 -8 116 116");
  svg.setAttribute("aria-hidden", "true");
  const body = document.createElementNS(SVG, "path");
  body.setAttribute("d", paths.d);
  body.setAttribute("fill", `var(--avatar-${color})`);
  body.setAttribute("stroke", `var(--avatar-${color})`);
  body.setAttribute("stroke-width", "6");
  body.setAttribute("stroke-linejoin", "round");
  const eye = color === "gray" ? "var(--avatar-eye-gray)" : "var(--avatar-eye)";
  const fill = document.createElementNS(SVG, "path");
  fill.setAttribute("d", paths.fillD);
  fill.setAttribute("fill", eye);
  const stroke = document.createElementNS(SVG, "path");
  stroke.setAttribute("d", paths.strokeD);
  stroke.setAttribute("fill", "none");
  stroke.setAttribute("stroke", eye);
  stroke.setAttribute("stroke-width", String(paths.strokeW));
  stroke.setAttribute("stroke-linecap", "round");
  stroke.setAttribute("stroke-linejoin", "round");
  svg.append(body, fill, stroke);
  wrap.append(svg);
  return wrap;
}

function elapsed(startedAt: number, labels: IslandState["labels"]) {
  const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  const [template, count] =
    seconds < 60
      ? [labels.seconds, seconds]
      : seconds < 3600
        ? [labels.minutes, Math.floor(seconds / 60)]
        : [labels.hours, Math.floor(seconds / 3600)];
  return template.replace("{count}", String(count));
}

function arrow(label: string, d: string, step: number) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "arrow";
  button.setAttribute("aria-label", label);
  button.title = label;
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  const path = document.createElementNS(SVG, "path");
  path.setAttribute("d", d);
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "2.4");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  svg.append(path);
  button.append(svg);
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    flip(step);
  });
  return button;
}

function currentIndex(items: IslandState["items"]) {
  const index = items.findIndex((item) => item.key === currentKey);
  return index < 0 ? 0 : index;
}

function flip(step: number) {
  if (!state || state.items.length < 2) return;
  const count = state.items.length;
  const next = (currentIndex(state.items) + step + count) % count;
  currentKey = state.items[next]?.key;
  flipped = true;
  render();
}

function fullRow(current: IslandState) {
  const items = current.items;
  const index = currentIndex(items);
  const item = items[index];
  if (!item) return [];
  currentKey = item.key;
  const pill = document.createElement("div");
  pill.className = "pill full";
  pill.setAttribute("role", "button");
  pill.setAttribute("aria-label", item.open);
  pill.addEventListener("click", () => send({ kind: "open", key: item.key }));
  const text = document.createElement("span");
  text.className = flipped ? "text flip" : "text";
  const name = document.createElement("b");
  name.textContent = item.name;
  const sep = document.createElement("span");
  sep.className = "sep";
  sep.textContent = " · ";
  text.append(name, sep, document.createTextNode(item.text));
  text.title = `${item.name} · ${item.text}`;
  const time = document.createElement("span");
  time.className = "time";
  time.dataset.started = String(item.startedAt);
  time.textContent = elapsed(item.startedAt, current.labels);
  pill.append(face(item.avatar), text, time);
  if (items.length > 1) {
    const nav = document.createElement("span");
    nav.className = "nav";
    const arrows = document.createElement("span");
    arrows.className = "arrows";
    arrows.append(
      arrow(current.labels.previous, "M6 15l6-6 6 6", -1),
      arrow(current.labels.next, "M6 9l6 6 6-6", 1),
    );
    const position = document.createElement("span");
    position.className = "index";
    position.textContent = `${index + 1}/${items.length}`;
    nav.append(arrows, position);
    pill.append(nav);
  }
  if (items.length < 2) return [pill];
  // The next busy Bot peeks out under the pill, so it reads as a stack you can flip.
  const peek = document.createElement("div");
  peek.className = "peek";
  peek.setAttribute("aria-hidden", "true");
  return [pill, peek];
}

function avatarsRow(current: IslandState) {
  const pill = document.createElement("div");
  pill.className = "pill avatars";
  const first = current.items[0];
  if (first) pill.addEventListener("click", () => send({ kind: "open", key: first.key }));
  for (const item of current.items.slice(0, 8)) pill.append(face(item.avatar));
  const dot = document.createElement("span");
  dot.className = "dot";
  const count = document.createElement("span");
  count.className = "count";
  count.textContent = current.labels.working.replace("{count}", String(current.items.length));
  pill.append(dot, count);
  return [pill];
}

function report(host: HTMLElement) {
  const box = host.getBoundingClientRect();
  const width = Math.ceil(box.width);
  const height = Math.ceil(box.height);
  const key = `${width}x${height}`;
  if (!width || !height || key === reported) return;
  reported = key;
  send({ kind: "size", width, height });
}

function render() {
  const host = document.getElementById("host");
  if (!host || !state) return;
  document.documentElement.dataset.theme = state.theme;
  const rows = state.mode === "avatars" && !hovering ? avatarsRow(state) : fullRow(state);
  host.replaceChildren(...rows);
  flipped = false;
  report(host);
  ticker ??= setInterval(() => {
    if (!state) return;
    for (const time of document.querySelectorAll<HTMLElement>(".time"))
      time.textContent = elapsed(Number(time.dataset.started), state.labels);
  }, 1000);
}

ipcRenderer.on(LIVE_ISLAND_STATE, (_event, raw: unknown) => {
  const parsed = IslandStateSchema.safeParse(raw);
  if (!parsed.success) return;
  state = parsed.data;
  render();
});

window.addEventListener("DOMContentLoaded", () => {
  const host = document.getElementById("host");
  host?.addEventListener("mouseenter", () => {
    hovering = true;
    if (state?.mode === "avatars") render();
  });
  host?.addEventListener("mouseleave", () => {
    hovering = false;
    if (state?.mode === "avatars") render();
  });
  window.addEventListener(
    "wheel",
    (event) => {
      wheel += event.deltaY;
      if (Math.abs(wheel) < WHEEL_STEP || Date.now() - lastFlip < FLIP_GAP_MS) return;
      lastFlip = Date.now();
      flip(wheel > 0 ? 1 : -1);
      wheel = 0;
    },
    { passive: true },
  );
  ipcRenderer.send(LIVE_ISLAND_READY);
});
window.addEventListener("pagehide", () => {
  if (ticker) clearInterval(ticker);
  ticker = undefined;
});
