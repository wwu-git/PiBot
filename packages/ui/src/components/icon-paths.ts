// Desktop icon paths on a 24-unit grid, stroked at 1.7 with round caps and joins. Plain data so
// the React Native app can draw the same set with react-native-svg.
export const iconPaths = {
  image: "M3 3h18v18H3ZM3 16l6-6 5 5 3-3 4 4M16 7h.01",
  info: "M12 11v6M12 7h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0",
  message: "M3 4h18v13H8l-5 4ZM7 8h10M7 12h7",
  island: "M7 8h10a4 4 0 0 1 0 8H7a4 4 0 0 1 0-8ZM8.5 12h.01",
  audit: "M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01",
  refresh: "M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-1l2 3M4 15l2 3a7 7 0 0 0 12-1",
  clock: "M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0",
  calendar: "M4 6h16v14H4ZM4 10h16M8 3v4M16 3v4M8 14h.01M12 14h.01M16 14h.01",
  chevronRight: "M9 6l6 6-6 6",
  home: "M4 11l8-7 8 7v9h-6v-6h-4v6H4Z",
  warning: "M12 3l10 18H2ZM12 9v5M12 17h.01",
  file: "M5 3h9l5 5v13H5ZM14 3v6h5M8 13h8M8 17h6",
  terminal: "M3 4h18v16H3ZM6 8l4 4-4 4M13 16h5",
  plus: "M12 5v14M5 12h14",
  search: "M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  menu: "M5 6h14M5 12h14M5 18h14",
  close: "M6 6l12 12M6 18L18 6",
  folder: "M3 7V5h7l2 2h9v13H3Z",
  pin: "M9 3h6l-1 6 4 4H6l4-4ZM12 13v8",
  check: "M5 12l4 4L19 6",
  edit: "M4 16l12-12 4 4L8 20H4ZM14 6l4 4",
  copy: "M8 8h13v13H8ZM16 8V3H3v13h5",
  quote: "M9 11H4V6h5v7a5 5 0 0 1-5 5M20 11h-5V6h5v7a5 5 0 0 1-5 5",
  hide: "M3 3l18 18M9 5a11 11 0 0 1 12 7l-3 4M6 6l-3 6c3 6 9 8 15 4M10 10a3 3 0 0 0 4 4",
  trash: "M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7",
  user: "M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0M4 21v-3a8 8 0 0 1 16 0v3",
  users:
    "M15 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0M3 21v-3a8 8 0 0 1 16 0v3M18 4a4 4 0 0 1 0 8M21 21v-3a8 8 0 0 0-3-6",
  settings: "M9 3h6l1 4 4 1v8l-4 1-1 4H9l-1-4-4-1V8l4-1ZM15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0",
  link: "M9 15l6-6M8 12l-3 3a4 4 0 0 0 6 6l3-3M10 6l3-3a4 4 0 0 1 6 6l-3 3",
  key: "M11 9a4 4 0 1 0 8 0a4 4 0 1 0-8 0M12.2 11.8 4 20M6.5 17.5l2 2M9 15l2 2",
  chevron: "M6 9l6 6 6-6",
  star: "M12 3l3 6 6 1-4 5 1 6-6-3-6 3 1-6-4-5 6-1Z",
  arrow: "M4 12h16M14 6l6 6-6 6",
  inbox: "M5 3h14l3 12v6H2v-6ZM2 15h6l2 3h4l2-3h6",
  // Skills: a puzzle piece for skills, play for "try it once", back for the detail view.
  puzzle:
    "M10 4a2 2 0 1 1 4 0v2h4v4h-1.5a2 2 0 1 0 0 4H18v4h-4v-1.5a2 2 0 1 0-4 0V18H6v-4h1.5a2 2 0 1 0 0-4H6V6h4Z",
  play: "M8 5l11 7-11 7Z",
  back: "M15 6l-6 6 6 6",
  // Neutral marker for a Bot browser step without a picture.
  globe:
    "M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17M3.5 12h17M12 3.5c3 3 3 14 0 17M12 3.5c-3 3-3 14 0 17",
  // Professions: distinct marks so no two professions share an icon.
  palette:
    "M12 3a9 9 0 1 0 0 18c1 0 1.6-.7 1.6-1.5 0-.4-.2-.8-.4-1.1-.3-.3-.4-.6-.4-1 0-.9.7-1.5 1.5-1.5H16a5 5 0 0 0 5-5c0-4.3-4-7.9-9-7.9M7.5 12h.01M9.5 7.5h.01M14.5 7.5h.01M17 11.5h.01",
  chart: "M4 20h16M7 16v-4M12 16V6M17 16v-7",
  rocket:
    "M9 15l-3-3c2-6 6-9 14-9 0 8-3 12-9 14ZM6 12H3l3-4h4M12 18v3l4-3v-4M15 9h.01M6 18c-1 1-1.5 3-1.5 3s2-.5 3-1.5",
  briefcase: "M3 8h18v12H3ZM8 8V4h8v4M3 13h18",
  // "Come help for a moment": a raised hand.
  hand: "M8 12V6.5a1.5 1.5 0 0 1 3 0V11M11 10.5V5a1.5 1.5 0 0 1 3 0v5.5M14 10.5V6.5a1.5 1.5 0 0 1 3 0V14a6 6 0 0 1-6 6h-.5a5.5 5.5 0 0 1-4.6-2.5L4 14.5a1.6 1.6 0 0 1 2.5-2L8 14",
  // Lively section and row marks.
  shield: "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6Z",
  phone: "M7 2h10v20H7ZM11 18h2",
  moon: "M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5",
  power: "M12 3v9M6.3 7a8 8 0 1 0 11.4 0",
  network:
    "M4 12h16M12 4a12 12 0 0 1 0 16M12 4a12 12 0 0 0 0 16M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0",
  send: "M12 19V5M5 12l7-7 7 7",
  plug: "M9 2v6M15 2v6M6 8h12v4a6 6 0 0 1-12 0ZM12 18v4",
  bolt: "M13 2L4 14h7l-1 8 9-12h-7Z",
  camera: "M3 7h4l2-3h6l2 3h4v13H3ZM12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8",
  server: "M4 4h16v6H4ZM4 14h16v6H4ZM8 7h.01M8 17h.01",
  box: "M3 7l9-4 9 4v10l-9 4-9-4ZM3 7l9 4 9-4M12 11v10",
  pause: "M8 5v14M16 5v14",
  // Menu marks for 归档 and 标为未读 / 已读.
  archive: "M3 4h18v5H3ZM5 9v11h14V9M10 13h4",
  dot: "M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z",
  // Settings
  laptop: "M5 5h14v10H5ZM2 19h20",
  // Downloads and undo
  download: "M12 3v12M7 10l5 5 5-5M4 21h16",
  "cloud-download":
    "M7 18a4 4 0 1 1 1.2-7.8A5 5 0 0 1 18 12h.5a3.5 3.5 0 0 1 0 7H15m-3-5v7m0 0-3-3m3 3 3-3",
  undo: "M9 14L4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3",
  // The "learn" starter.
  bulb: "M9 18h6M10 21h4M12 3a6 6 0 0 0-3 11v2h6v-2a6 6 0 0 0-3-11Z",
  // Chat
  stop: "M7 7h10v10H7Z",
  plan: "M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01",
  eye: "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12ZM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6",
  // The sidebar ＋ menu's 新建 Bot row.
  bot: "M9 7h6a4 4 0 0 1 4 4v4a4 4 0 0 1-4 4H9a4 4 0 0 1-4-4v-4a4 4 0 0 1 4-4ZM10 11v2M14 11v2M12 3v4",
} as const;

export type IconName = keyof typeof iconPaths;
