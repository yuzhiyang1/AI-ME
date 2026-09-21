// 独立入口：只把本目录 TypeScript 编译到临时目录，不修改 package/main/preload。
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const electron = require("electron");
const source = dirname(fileURLToPath(import.meta.url));
const output = mkdtempSync(join(tmpdir(), "aime-browser-test-"));
try {
  writeFileSync(join(output, "package.json"), '{"type":"module"}');
  for (const name of readdirSync(source).filter((name) => name.endsWith(".ts"))) {
    const compiled = ts.transpileModule(readFileSync(join(source, name), "utf8"), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
    });
    writeFileSync(join(output, name.replace(/\.ts$/, ".js")), compiled.outputText);
  }
  const unit = spawnSync(process.execPath, ["--test", join(output, "security.test.js")], { stdio: "inherit" });
  if (unit.status !== 0) process.exitCode = unit.status ?? 1;
  else {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const smoke = spawnSync(electron, [join(output, "electron.test.js")], { stdio: "inherit", env, timeout: 90_000, windowsHide: true });
    if (smoke.error) console.error(smoke.error);
    process.exitCode = smoke.status ?? 1;
  }
} finally {
  // 仅删除本进程 mkdtemp 创建的测试编译产物。
  rmSync(output, { recursive: true, force: true });
}
