import type { ImageContent } from "@earendil-works/pi-ai";
import { expect, it, vi } from "vitest";
import { requeue, SessionAdditions } from "../src/session/session-additions.ts";

it("keeps the SDK delivery order when moving one queued input", async () => {
  const additions = new SessionAdditions();
  const images: ImageContent[] = [{ type: "image", data: "AA==", mimeType: "image/png" }];
  additions.queued.set("second", { text: "second", mode: "steer" });
  additions.queued.set("moved", { text: "move me", mode: "followUp", images });
  additions.queued.set("first", { text: "first", mode: "steer" });
  additions.queued.set("in-flight", { text: "already consumed", mode: "followUp" });
  const sdk = {
    clearQueue: vi.fn(() => ({
      steering: ["first", "sdk input", "second"],
      followUp: ["stay", "move me", "sdk follow-up"],
    })),
    steer: vi.fn(async (_text: string, _images?: ImageContent[]) => undefined),
    followUp: vi.fn(async (_text: string, _images?: ImageContent[]) => undefined),
  };

  expect(await requeue(additions, sdk, "moved", "steer")).toBe(true);
  expect(sdk.steer.mock.calls.map(([text]) => text)).toEqual([
    "first",
    "sdk input",
    "second",
    "move me",
  ]);
  expect(sdk.steer).toHaveBeenLastCalledWith("move me", images);
  expect(sdk.followUp.mock.calls.map(([text]) => text)).toEqual(["stay", "sdk follow-up"]);
  expect(additions.queued.get("moved")?.mode).toBe("steer");
});

it("matches duplicate queued text in order and keeps each input's images", async () => {
  const additions = new SessionAdditions();
  const firstImages: ImageContent[] = [{ type: "image", data: "AA==", mimeType: "image/png" }];
  const secondImages: ImageContent[] = [{ type: "image", data: "AQ==", mimeType: "image/png" }];
  additions.queued.set("first", { text: "continue", mode: "steer", images: firstImages });
  additions.queued.set("second", { text: "continue", mode: "steer", images: secondImages });
  const sdk = {
    clearQueue: vi.fn(() => ({
      steering: ["continue", "other", "continue", "continue"],
      followUp: ["continue"],
    })),
    steer: vi.fn(async (_text: string, _images?: ImageContent[]) => undefined),
    followUp: vi.fn(async (_text: string, _images?: ImageContent[]) => undefined),
  };

  expect(await requeue(additions, sdk, "first", "followUp")).toBe(true);
  expect(sdk.steer.mock.calls).toEqual([
    ["other", undefined],
    ["continue", secondImages],
    ["continue", undefined],
  ]);
  expect(sdk.followUp.mock.calls).toEqual([
    ["continue", undefined],
    ["continue", firstImages],
  ]);
  expect(additions.queued.get("first")?.mode).toBe("followUp");
  expect(additions.queued.get("second")?.mode).toBe("steer");
});
