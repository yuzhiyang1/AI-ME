import { describe, expect, it } from "vitest";
import type { StorageAdapter } from "../types";
import { createChatStore } from "./store";

const OPEN_KEY = "multica:chat:isOpen";

function memoryStorage(seed: Record<string, string> = {}) {
  const data = new Map(Object.entries(seed));
  const storage: StorageAdapter = {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
  };
  return { storage, data };
}

describe("createChatStore", () => {
  it("keeps the chat closed by default so work pages are not covered", () => {
    const { storage } = memoryStorage();

    const store = createChatStore({ storage });

    expect(store.getState().isOpen).toBe(false);
  });

  it("honours an explicit previously opened chat preference", () => {
    const { storage } = memoryStorage({ [OPEN_KEY]: "true" });

    const store = createChatStore({ storage });

    expect(store.getState().isOpen).toBe(true);
  });

  it("persists manual open and close choices", () => {
    const { storage, data } = memoryStorage();
    const store = createChatStore({ storage });

    store.getState().toggle();
    expect(store.getState().isOpen).toBe(true);
    expect(data.get(OPEN_KEY)).toBe("true");

    store.getState().setOpen(false);
    expect(store.getState().isOpen).toBe(false);
    expect(data.get(OPEN_KEY)).toBe("false");
  });
});
