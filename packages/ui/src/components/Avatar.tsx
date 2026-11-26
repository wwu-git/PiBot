import type { CSSProperties } from "react";
import { useState } from "react";
import styles from "./Avatar.module.css";
import {
  type AvatarColor,
  type AvatarEyes,
  type AvatarShape,
  type AvatarState,
  avatarPaths,
  avatarShapes,
} from "./avatar-paths.ts";

export type { AvatarColor, AvatarEyes, AvatarShape, AvatarState } from "./avatar-paths.ts";

export interface AvatarProps {
  image?: string | null;
  shape?: AvatarShape;
  color?: AvatarColor;
  eyes?: AvatarEyes;
  state?: AvatarState;
  size?: number;
  label?: string;
  className?: string;
}

export function Avatar({
  image,
  shape = "blob",
  color = "violet",
  eyes = "marks",
  state = "idle",
  size = 96,
  label = "Bot",
  className,
}: AvatarProps) {
  const [failedImage, setFailedImage] = useState<string>();
  if (image && image !== failedImage)
    return (
      <span
        className={[styles.avatar, className].filter(Boolean).join(" ")}
        data-state={state}
        style={{ width: size, height: size }}
      >
        <img
          className={styles.image}
          src={image}
          alt={label}
          width={size}
          height={size}
          draggable={false}
          onError={() => setFailedImage(image)}
        />
      </span>
    );
  const { d, fillD, strokeD, strokeW } = avatarPaths(shape, eyes, state);
  const blink = state === "idle" || state === "waiting";
  const style = {
    width: size,
    height: size,
    "--blink-delay": `${(Object.keys(avatarShapes).indexOf(shape) * 0.7).toFixed(1)}s`,
  } as CSSProperties;
  const fill = `var(--avatar-${color})`;
  const eye = color === "gray" ? "var(--avatar-eye-gray)" : "var(--avatar-eye)";
  return (
    <span
      className={[styles.avatar, className].filter(Boolean).join(" ")}
      data-state={state}
      style={style}
    >
      <svg viewBox="0 0 100 100" width="100%" height="100%" role="img" aria-label={label}>
        <title>{label}</title>
        <path d={d} fill={fill} stroke={fill} strokeWidth={6} strokeLinejoin="round" />
        <g className={blink ? styles.blink : undefined}>
          <path d={fillD} fill={eye} />
          <path
            d={strokeD}
            fill="none"
            stroke={eye}
            strokeWidth={strokeW}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </g>
      </svg>
    </span>
  );
}
