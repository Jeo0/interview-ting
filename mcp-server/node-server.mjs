// Node.js entry point (Node 18+). No dependencies.
//
//   MCP_TOKEN=some-long-secret PORT=8787 node node-server.mjs
//
// Files are kept as JSON under ./data (override with DATA_DIR).
// The Anthropic MCP connector must reach this server over public HTTPS,
// so put it behind a tunnel or host (e.g. Render, Fly.io, a VPS + Caddy).
import http from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { createHandler } from "./core.mjs";

const PORT = Number(process.env.PORT || 8787);
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), "data");
let token = process.env.MCP_TOKEN;
if (!token) {
  token = randomBytes(24).toString("base64url");
  console.log(`MCP_TOKEN not set — generated one for this run:\n  ${token}`);
}

await mkdir(DATA_DIR, { recursive: true });
const fileFor = (key) => path.join(DATA_DIR, createHash("sha256").update(key).digest("hex") + ".json");

const store = {
  async get(key) {
    try {
      return await readFile(fileFor(key), "utf8");
    } catch {
      return null;
    }
  },
  async put(key, value) {
    await writeFile(fileFor(key), value, "utf8");
  },
  async delete(key) {
    try {
      await unlink(fileFor(key));
    } catch {}
  },
};

const handle = createHandler({ store, token, allowOrigin: process.env.ALLOW_ORIGIN || "*" });

const server = http.createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const proto = req.headers["x-forwarded-proto"] || "http";
    const request = new Request(`${proto}://${req.headers.host || "localhost"}${req.url}`, {
      method: req.method,
      headers: req.headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
    });
    const response = await handle(request);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (e) {
    console.error(e);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "internal error" }));
  }
});

// Uploads can be a few MB of extracted text.
server.listen(PORT, () => console.log(`Interview Files MCP server on http://localhost:${PORT}  (MCP endpoint: /mcp)`));
