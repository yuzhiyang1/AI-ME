import { describe, expect, it } from "vitest";

import {
  createCapabilityMap,
  defaultZCodeCapabilities,
  isCapabilityEnabled,
  zcodeCapabilityIds,
} from "./capabilities";

describe("ZCode 工作台能力目录", () => {
  it("保留完整能力目录，并允许暂时隐藏而不删除定义", () => {
    expect(defaultZCodeCapabilities.map((item) => item.id)).toEqual(zcodeCapabilityIds);
    expect(isCapabilityEnabled("chat")).toBe(true);
    expect(isCapabilityEnabled("terminal")).toBe(false);
    expect(createCapabilityMap().get("terminal")?.state).toBe("unavailable");
  });
});
