import { access } from "node:fs/promises";
import path from "node:path";

const requiredArtifacts = ["main.js", "preload.cjs"];

for (const artifact of requiredArtifacts) {
  const artifactPath = path.resolve("dist", artifact);
  try {
    await access(artifactPath);
  } catch {
    throw new Error(`桌面构建缺少必要产物：${artifact}`);
  }
}

console.log("桌面主进程与沙箱预加载产物验证通过。");
