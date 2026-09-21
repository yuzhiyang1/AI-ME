import assert from "node:assert/strict";
import test from "node:test";
import { BrowserNetworkPolicy } from "./security.js";
import { commandArgs, viewportRect, webUrl } from "./types.js";

test("严格 URL 协议与参数白名单", () => {
  for (const url of ["file:///secret", "javascript:alert(1)", "data:text/html,hi", "https:example.com", "https://user:secret@example.com", " https://example.com", "https://example.com\n"]) {
    assert.throws(() => webUrl(url));
  }
  assert.equal(webUrl("https://example.com/path?q=1"), "https://example.com/path?q=1");
  assert.throws(() => commandArgs({ snapshotId: "s", selector: "#submit" }, ["snapshotId", "actionId", "text"]));
  assert.throws(() => commandArgs({ code: "fetch('/secret')" }, []));
});

test("应用端口包含 DNS/回环别名、WS 及远程同端口，fixture 端口可通", () => {
  const policy = new BrowserNetworkPolicy(["http://127.0.0.1:8000", "http://localhost:5173"]);
  for (const host of ["localhost", "127.0.0.1", "127.1", "0.0.0.0", "[::1]", "[::ffff:7f00:1]", "local.example", "remote.example"]) {
    for (const scheme of ["http", "https", "ws", "wss"]) {
      assert.equal(policy.allows(`${scheme}://${host}:8000/api/sessions`), false);
      assert.equal(policy.allows(`${scheme}://${host}:5173/`), false);
      assert.equal(policy.allows(`${scheme}://${host}:49152/`), true);
    }
  }
  assert.equal(policy.allows("blob:http://127.0.0.1:8000/object"), false);
  assert.equal(policy.allows("file:///tmp/secret"), false);
  assert.equal(policy.allows("data:text/html,hello", true), false);
  assert.equal(policy.allows("data:image/png;base64,hello"), true);
});

test("视口裁剪及无效值拒绝", () => {
  assert.deepEqual(viewportRect({ x: -10, y: 20, width: 400, height: 600 }, 300, 500), { x: 0, y: 20, width: 300, height: 480 });
  assert.equal(viewportRect({ x: 301, y: 0, width: 10, height: 20 }, 300, 500), null);
  assert.throws(() => viewportRect({ x: NaN, y: 0, width: 10, height: 20 }, 300, 500));
});
