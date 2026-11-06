// Interview Files MCP server — shared core.
//
// A tiny, dependency-free MCP server (Streamable HTTP transport, JSON responses)
// plus a small REST API the static web app uses to upload the text of the
// interviewee's files. Claude reaches the MCP endpoint through the Anthropic
// MCP connector and reads the files with the tools below.
//
// The same handler runs on Cloudflare Workers (worker.mjs) and on Node
// (node-server.mjs); each entry point supplies a key/value `store`.

const SERVER_INFO = { name: "interview-files", version: "1.0.0" };
const DEFAULT_PROTOCOL = "2025-06-18";
const MAX_READ_CHARS = 60000;
const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

const TOOLS = [
  {
    name: "list_files",
    description:
      "List the files the interviewee uploaded for an interview session (presentation slides, thesis PDFs, boards, notes). Returns each file's id, name, type and page/slide count.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "Interview session id given in the conversation." },
      },
      required: ["session_id"],
      additionalProperties: false,
    },
  },
  {
    name: "read_file",
    description:
      "Read the extracted text of a file, page by page (slides count as pages). Use start_page/end_page (1-based, inclusive) to read part of a long document.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        file_id: { type: "string" },
        start_page: { type: "integer", minimum: 1 },
        end_page: { type: "integer", minimum: 1 },
      },
      required: ["session_id", "file_id"],
      additionalProperties: false,
    },
  },
  {
    name: "search_files",
    description:
      "Case-insensitive search across all of a session's files. Returns matching pages with short snippets, so you can check a claim against the slides.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        query: { type: "string", minLength: 2 },
      },
      required: ["session_id", "query"],
      additionalProperties: false,
    },
  },
];

function cors(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers":
      "Authorization, Content-Type, Mcp-Session-Id, Mcp-Protocol-Version, Accept",
    "Access-Control-Expose-Headers": "Mcp-Session-Id",
    "Access-Control-Max-Age": "86400",
  };
}

function json(body, status, origin, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...cors(origin), ...extra },
  });
}

function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function readIndex(store, sid) {
  const raw = await store.get(`index:${sid}`);
  return raw ? JSON.parse(raw) : [];
}

async function writeIndex(store, sid, index) {
  await store.put(`index:${sid}`, JSON.stringify(index));
}

async function readFileRecord(store, sid, fid) {
  const raw = await store.get(`file:${sid}:${fid}`);
  return raw ? JSON.parse(raw) : null;
}

function unitName(kind) {
  return kind === "pptx" ? "slide" : "page";
}

// ---------- MCP tools ----------

async function callTool(store, name, args = {}) {
  const sid = String(args.session_id || "");
  if (!ID_RE.test(sid)) throw new ToolError("Invalid or missing session_id.");

  if (name === "list_files") {
    const index = await readIndex(store, sid);
    if (!index.length) return `No files uploaded for session ${sid}.`;
    return index
      .map(
        (f, i) =>
          `${i + 1}. ${f.name} — id: ${f.id}, type: ${f.kind}, ${f.pageCount} ${unitName(f.kind)}${f.pageCount === 1 ? "" : "s"}`
      )
      .join("\n");
  }

  if (name === "read_file") {
    const fid = String(args.file_id || "");
    if (!ID_RE.test(fid)) throw new ToolError("Invalid or missing file_id.");
    const rec = await readFileRecord(store, sid, fid);
    if (!rec) throw new ToolError(`File ${fid} not found in session ${sid}. Call list_files first.`);
    const total = rec.pages.length;
    const start = Math.max(1, Number(args.start_page) || 1);
    const end = Math.min(total, Number(args.end_page) || total);
    if (start > total) throw new ToolError(`start_page ${start} is past the end (${total} ${unitName(rec.kind)}s).`);
    const unit = unitName(rec.kind);
    let out = `# ${rec.name} (${rec.kind}, ${total} ${unit}s)\n`;
    let last = start - 1;
    for (let p = start; p <= end; p++) {
      const page = rec.pages[p - 1] || {};
      const chunk = `\n## ${unit[0].toUpperCase() + unit.slice(1)} ${p}${page.title ? ` — ${page.title}` : ""}\n${(page.text || "").trim() || "(no extractable text — likely an image-only page)"}\n`;
      if (out.length + chunk.length > MAX_READ_CHARS) break;
      out += chunk;
      last = p;
    }
    if (last < end) out += `\n…truncated. Continue with start_page=${last + 1}.`;
    return out;
  }

  if (name === "search_files") {
    const q = String(args.query || "").trim().toLowerCase();
    if (q.length < 2) throw new ToolError("query must be at least 2 characters.");
    const index = await readIndex(store, sid);
    const hits = [];
    for (const f of index) {
      const rec = await readFileRecord(store, sid, f.id);
      if (!rec) continue;
      rec.pages.forEach((page, i) => {
        const text = page.text || "";
        const at = text.toLowerCase().indexOf(q);
        if (at >= 0) {
          const s = Math.max(0, at - 120);
          const snippet = text.slice(s, at + q.length + 120).replace(/\s+/g, " ").trim();
          hits.push(`- ${rec.name}, ${unitName(rec.kind)} ${i + 1}: …${snippet}…`);
        }
      });
      if (hits.length >= 40) break;
    }
    return hits.length ? hits.slice(0, 40).join("\n") : `No matches for "${args.query}".`;
  }

  throw new ToolError(`Unknown tool: ${name}`);
}

class ToolError extends Error {}

async function handleRpc(store, msg) {
  const { id, method, params } = msg || {};
  const isNotification = id === undefined || id === null;
  const result = (r) => ({ jsonrpc: "2.0", id, result: r });
  const error = (code, message) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

  if (!msg || msg.jsonrpc !== "2.0" || typeof method !== "string") {
    return error(-32600, "Invalid Request");
  }
  if (isNotification) return null; // notifications/initialized, cancelled, …

  switch (method) {
    case "initialize":
      return result({
        protocolVersion: params?.protocolVersion || DEFAULT_PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          "Files the interviewee uploaded for a rehearsal interview. Call list_files with the session_id from the conversation, then read_file or search_files.",
      });
    case "ping":
      return result({});
    case "tools/list":
      return result({ tools: TOOLS });
    case "tools/call": {
      try {
        const text = await callTool(store, params?.name, params?.arguments || {});
        return result({ content: [{ type: "text", text }], isError: false });
      } catch (e) {
        if (e instanceof ToolError) {
          return result({ content: [{ type: "text", text: e.message }], isError: true });
        }
        return error(-32603, "Internal error");
      }
    }
    case "resources/list":
      return result({ resources: [] });
    case "prompts/list":
      return result({ prompts: [] });
    default:
      return error(-32601, `Method not found: ${method}`);
  }
}

// ---------- REST upload API ----------

async function putFile(store, sid, fid, body) {
  if (!body || typeof body.name !== "string" || !Array.isArray(body.pages)) {
    throw new Error("Body must be {name, kind, pages:[{title?, text}]}");
  }
  const rec = {
    id: fid,
    name: body.name.slice(0, 200),
    kind: String(body.kind || "file").slice(0, 20),
    pages: body.pages.slice(0, 2000).map((p) => ({
      title: typeof p.title === "string" ? p.title.slice(0, 300) : "",
      text: typeof p.text === "string" ? p.text.slice(0, 50000) : "",
    })),
    updatedAt: new Date().toISOString(),
  };
  await store.put(`file:${sid}:${fid}`, JSON.stringify(rec));
  const index = (await readIndex(store, sid)).filter((f) => f.id !== fid);
  index.push({ id: fid, name: rec.name, kind: rec.kind, pageCount: rec.pages.length });
  await writeIndex(store, sid, index);
  return { id: fid, pageCount: rec.pages.length };
}

async function deleteFile(store, sid, fid) {
  await store.delete(`file:${sid}:${fid}`);
  const index = (await readIndex(store, sid)).filter((f) => f.id !== fid);
  await writeIndex(store, sid, index);
}

async function deleteSession(store, sid) {
  const index = await readIndex(store, sid);
  for (const f of index) await store.delete(`file:${sid}:${f.id}`);
  await store.delete(`index:${sid}`);
}

// ---------- entry ----------

export function createHandler({ store, token, allowOrigin = "*" }) {
  if (!token) throw new Error("MCP_TOKEN is required");

  return async function handle(request) {
    const url = new URL(request.url);
    const origin = allowOrigin;
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors(origin) });
    }
    if (path === "/" || path === "/health") {
      return json({ ok: true, server: SERVER_INFO, mcp: "/mcp" }, 200, origin);
    }

    const auth = request.headers.get("Authorization") || "";
    const presented = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    if (!timingSafeEqual(presented, token)) {
      return json({ error: "unauthorized" }, 401, origin, { "WWW-Authenticate": "Bearer" });
    }

    // MCP Streamable HTTP endpoint
    if (path === "/mcp") {
      if (request.method === "GET") {
        // No server-initiated stream.
        return new Response(null, { status: 405, headers: { Allow: "POST", ...cors(origin) } });
      }
      if (request.method === "DELETE") {
        return new Response(null, { status: 204, headers: cors(origin) });
      }
      if (request.method !== "POST") return json({ error: "method not allowed" }, 405, origin);
      let payload;
      try {
        payload = await request.json();
      } catch {
        return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400, origin);
      }
      const batch = Array.isArray(payload);
      const msgs = batch ? payload : [payload];
      const responses = [];
      for (const m of msgs) {
        const r = await handleRpc(store, m);
        if (r) responses.push(r);
      }
      if (!responses.length) return new Response(null, { status: 202, headers: cors(origin) });
      const extra = {};
      if (msgs.some((m) => m && m.method === "initialize")) {
        extra["Mcp-Session-Id"] = crypto.randomUUID();
      }
      return json(batch ? responses : responses[0], 200, origin, extra);
    }

    // REST: /api/sessions/:sid[/files/:fid]
    const m = path.match(/^\/api\/sessions\/([^/]+)(?:\/files\/([^/]+))?$/);
    if (m) {
      const sid = decodeURIComponent(m[1]);
      const fid = m[2] ? decodeURIComponent(m[2]) : null;
      if (!ID_RE.test(sid) || (fid !== null && !ID_RE.test(fid))) {
        return json({ error: "invalid id" }, 400, origin);
      }
      try {
        if (fid && request.method === "PUT") {
          return json(await putFile(store, sid, fid, await request.json()), 200, origin);
        }
        if (fid && request.method === "DELETE") {
          await deleteFile(store, sid, fid);
          return json({ ok: true }, 200, origin);
        }
        if (!fid && request.method === "GET") {
          return json({ files: await readIndex(store, sid) }, 200, origin);
        }
        if (!fid && request.method === "DELETE") {
          await deleteSession(store, sid);
          return json({ ok: true }, 200, origin);
        }
      } catch (e) {
        return json({ error: String(e.message || e) }, 400, origin);
      }
      return json({ error: "method not allowed" }, 405, origin);
    }

    return json({ error: "not found" }, 404, origin);
  };
}
