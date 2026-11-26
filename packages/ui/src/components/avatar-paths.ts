// Bot avatar geometry on a 100-unit grid. Plain data (no React) so a window without the app's
// renderer, such as the live island's preload, draws the same faces.
export const avatarShapes = {
  blob: {
    d: "M50 6 C80 6 94 20 94 50 C94 80 80 94 50 94 C20 94 6 80 6 50 C6 20 20 6 50 6 Z",
    ey: 42,
    ex: 13,
  },
  pill: {
    d: "M50 6 C72 6 82 20 82 40 V62 C82 82 70 94 50 94 C30 94 18 82 18 62 V40 C18 20 28 6 50 6 Z",
    ey: 40,
    ex: 12,
  },
  drop: {
    d: "M50 6 C64 26 88 44 88 64 C88 84 72 94 50 94 C28 94 12 84 12 64 C12 44 36 26 50 6 Z",
    ey: 60,
    ex: 13,
  },
  pebble: {
    d: "M30 14 C46 4 78 6 88 26 C98 46 92 76 74 88 C56 98 22 94 12 76 C2 58 12 26 30 14 Z",
    ey: 44,
    ex: 14,
  },
  flower: {
    d: "M50 6 A20 20 0 0 1 72 28 A20 20 0 0 1 94 50 A20 20 0 0 1 72 72 A20 20 0 0 1 50 94 A20 20 0 0 1 28 72 A20 20 0 0 1 6 50 A20 20 0 0 1 28 28 A20 20 0 0 1 50 6 Z",
    ey: 46,
    ex: 12,
  },
  cloud: {
    d: "M28 84 C14 84 6 74 6 62 C6 50 15 42 26 42 C27 26 38 16 52 16 C66 16 76 26 78 38 C88 38 94 48 94 60 C94 74 84 84 72 84 Z",
    ey: 54,
    ex: 14,
  },
  ghost: {
    d: "M14 50 C14 24 30 8 50 8 C70 8 86 24 86 50 V90 L76 82 L66 90 L56 82 L50 88 L44 82 L34 90 L24 82 L14 90 Z",
    ey: 42,
    ex: 13,
  },
  cat: {
    d: "M14 30 L22 6 L40 22 H60 L78 6 L86 30 C92 44 92 60 88 72 C82 88 68 94 50 94 C32 94 18 88 12 72 C8 60 8 44 14 30 Z",
    ey: 52,
    ex: 14,
  },
  hex: { d: "M50 6 L88 28 V72 L50 94 L12 72 V28 Z", ey: 46, ex: 13 },
  circle: { d: "M50 6 A44 44 0 1 1 49.9 6 Z", ey: 44, ex: 14 },
  bean: {
    d: "M10 46 C10 26 26 16 48 16 C72 16 92 24 92 46 C92 68 74 84 50 84 C26 84 10 66 10 46 Z",
    ey: 40,
    ex: 14,
  },
  tri: {
    d: "M22 10 C30 6 40 8 48 14 L88 46 C96 52 96 62 88 68 L36 92 C26 96 14 90 14 78 L12 24 C12 18 16 12 22 10 Z",
    ey: 44,
    ex: 12,
  },
} as const;

export type AvatarShape = keyof typeof avatarShapes;
export type AvatarEyes = "marks" | "dot" | "oval" | "pixel" | "sleepy";
export type AvatarState = "idle" | "thinking" | "working" | "waiting" | "blocked" | "done";
export const AVATAR_COLORS = [
  "orange",
  "amber",
  "blue",
  "violet",
  "pink",
  "teal",
  "green",
  "brown",
  "ink",
  "gray",
] as const;
export type AvatarColor = (typeof AVATAR_COLORS)[number];

function ellipse(x: number, y: number, rx: number, ry: number) {
  return `M${x - rx} ${y} a${rx} ${ry} 0 1 0 ${2 * rx} 0 a${rx} ${ry} 0 1 0 ${-2 * rx} 0 Z `;
}

/** The body outline and the eye strokes / fills for one face. */
export function avatarPaths(shape: AvatarShape, eyes: AvatarEyes, state: AvatarState) {
  const { d, ey, ex } = avatarShapes[shape];
  const [dx, dy] = {
    idle: [0, 0],
    thinking: [0, -5],
    working: [5, 1],
    waiting: [0, 2],
    blocked: [0, 0],
    done: [0, 0],
  }[state] as [number, number];
  let fillD = "";
  let strokeD = "";
  let strokeW = 7;
  for (const [i, x] of [50 - ex, 50 + ex].entries()) {
    if (state === "blocked") {
      strokeW = 6;
      strokeD += `M${x - 5} ${ey - 5} L${x + 5} ${ey + 5} M${x + 5} ${ey - 5} L${x - 5} ${ey + 5} `;
    } else if (state === "done") {
      strokeW = 6;
      strokeD += `M${x - 6} ${ey + 3} Q${x} ${ey - 7} ${x + 6} ${ey + 3} `;
    } else if (eyes === "marks") {
      const tilt = i === 0 ? -2 : 2;
      strokeD += `M${x + tilt + dx} ${ey - 7 + dy} L${x - tilt + dx} ${ey + 5 + dy} `;
    } else if (eyes === "sleepy") {
      strokeW = 5;
      strokeD += `M${x - 6 + dx} ${ey + dy} Q${x + dx} ${ey + 5 + dy} ${x + 6 + dx} ${ey + dy} `;
    } else if (eyes === "pixel") {
      fillD += `M${x - 4.5 + dx} ${ey - 4.5 + dy} h9 v9 h-9 Z `;
    } else {
      fillD += ellipse(x + dx, ey + dy, eyes === "oval" ? 4.5 : 5.5, eyes === "oval" ? 7 : 5.5);
    }
  }
  return { d, fillD, strokeD, strokeW };
}
