// Self-test for the MCP core: node test.mjs
import assert from "node:assert/strict";
import { createHandler } from "./core.mjs";

const mem = new Map();
const store = {
  get: async (k) => mem.get(k) ?? null,
  put: async (k, v) => void mem.set(k, v),
  delete: async (k) => void mem.delete(k),
};
const token = "test-token";
const handle = createHandler({ store, token });
const base = "https://mcp.example";
const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

async function rpc(method, params, id = 1) {
  const r = await handle(new Request(`${base}/mcp`, { method: "POST", headers: auth, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) }));
  return r.json();
}

// auth required
let r = await handle(new Request(`${base}/mcp`, { method: "POST", body: "{}" }));
assert.equal(r.status, 401);

// upload a file
r = await handle(
  new Request(`${base}/api/sessions/s_1/files/f_1`, {
    method: "PUT",
    headers: auth,
    body: JSON.stringify({ name: "thesis.pdf", kind: "pdf", pages: [{ title: "Cover", text: "Floating school in Bulacan" }, { text: "Site: flood-prone barangay, storm surge" }] }),
  })
);
assert.equal(r.status, 200);

const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
assert.equal(init.result.serverInfo.name, "interview-files");

r = await handle(new Request(`${base}/mcp`, { method: "POST", headers: auth, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) }));
assert.equal(r.status, 202);

const list = await rpc("tools/list", {});
assert.deepEqual(list.result.tools.map((t) => t.name), ["list_files", "read_file", "search_files"]);

let call = await rpc("tools/call", { name: "list_files", arguments: { session_id: "s_1" } });
assert.match(call.result.content[0].text, /thesis\.pdf — id: f_1, type: pdf, 2 pages/);

call = await rpc("tools/call", { name: "read_file", arguments: { session_id: "s_1", file_id: "f_1", start_page: 2 } });
assert.match(call.result.content[0].text, /Page 2\n.*storm surge/);
assert.doesNotMatch(call.result.content[0].text, /Bulacan/);

call = await rpc("tools/call", { name: "search_files", arguments: { session_id: "s_1", query: "STORM" } });
assert.match(call.result.content[0].text, /page 2/);

call = await rpc("tools/call", { name: "read_file", arguments: { session_id: "s_1", file_id: "nope" } });
assert.equal(call.result.isError, true);

r = await handle(new Request(`${base}/api/sessions/s_1`, { method: "DELETE", headers: auth }));
assert.equal(r.status, 200);
assert.equal(mem.size, 0);

console.log("mcp-server: all tests passed");
