import { expect, it, vi } from "vitest";
import { createSecureStorage } from "./secure-storage.ts";

it("keeps a slot for encrypting while concurrent availability requests wait for the keychain", async () => {
  const availability = Promise.withResolvers<boolean>();
  const isAsyncEncryptionAvailable = vi.fn(() => availability.promise);
  const ciphertext = Buffer.from("test ciphertext");
  const encryptStringAsync = vi.fn(async () => ciphertext);
  const storage = createSecureStorage(
    {
      isAsyncEncryptionAvailable,
      encryptStringAsync,
      decryptStringAsync: vi.fn(),
    },
    { info: vi.fn() },
    { platform: "darwin" },
  );
  try {
    const probes = Array.from({ length: 24 }, () => storage.isAsyncEncryptionAvailable());
    const receipt = storage.encryptStringAsync("test receipt");
    const results = Promise.allSettled([...probes, receipt]);
    await Promise.resolve();
    availability.resolve(true);
    const settled = await results;

    expect(settled.at(-1)).toEqual({ status: "fulfilled", value: ciphertext });
    expect(settled.slice(0, -1)).toEqual(
      Array.from({ length: 24 }, () => ({ status: "fulfilled", value: true })),
    );
    expect(isAsyncEncryptionAvailable).toHaveBeenCalledTimes(1);
    expect(encryptStringAsync).toHaveBeenCalledExactlyOnceWith("test receipt");
  } finally {
    storage.dispose();
  }
});
