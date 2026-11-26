import { useSettings } from "@pibot/renderer-kit";
import { type RefObject, useLayoutEffect } from "react";

function resize(input: HTMLTextAreaElement) {
  // Reset before measuring so deleting text can shrink the field. CSS caps the visible height.
  input.style.height = "0px";
  input.style.height = `${input.scrollHeight}px`;
}

export function useTextareaHeight(ref: RefObject<HTMLTextAreaElement | null>, text: string) {
  // The chat text size changes the line height without changing the text or the width.
  const fontSize = useSettings().settings?.chatFontSize;
  // biome-ignore lint/correctness/useExhaustiveDependencies: measure after the controlled value commits
  useLayoutEffect(() => {
    if (ref.current) resize(ref.current);
  }, [ref, text, fontSize]);

  useLayoutEffect(() => {
    const input = ref.current;
    if (!input) return;
    let width = input.clientWidth;
    const observer = new ResizeObserver(() => {
      // Height changes from our own measurement must not trigger another resize.
      if (input.clientWidth === width) return;
      width = input.clientWidth;
      resize(input);
    });
    observer.observe(input);
    return () => observer.disconnect();
  }, [ref]);
}
