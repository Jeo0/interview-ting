// The interviewer: Claude via the Anthropic Messages API, streamed, with the
// Anthropic MCP connector pointing at the Interview Files MCP server.
import Anthropic from "../vendor/anthropic-sdk-1.2.0.mjs";
import { files as fileStore } from "./store.js";
import { blobToBase64 } from "./docs.js";

export const COMPLETE_TOKEN = "<<INTERVIEW_COMPLETE>>";
export const MCP_SERVER_NAME = "interview_files";

export const MODELS = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5 (recommended)" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5 (faster, cheaper)" },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5 (fastest, cheapest)" },
];

// Models that accept the server-side refusal fallback (`fallbacks: "default"`).
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-sonnet-5-5"]);
// Models that support web_search_20260209.
const WEB_SEARCH_MODELS = new Set(["claude-opus-5-5", "claude-sonnet-5-5"]);

export function fileDelivery(global) {
  const hasMcp = Boolean(global.mcpUrl && global.mcpToken);
  if (global.delivery === "direct") return { direct: true, mcp: false };
  if (global.delivery === "mcp") return { direct: !hasMcp, mcp: hasMcp };
  if (global.delivery === "both") return { direct: true, mcp: hasMcp };
  return { direct: !hasMcp, mcp: hasMcp }; // auto
}

export function buildSystemPrompt(settings, sessionId, delivery) {
  const fileAccess = delivery.mcp
    ? `The candidate's files are on the "${MCP_SERVER_NAME}" MCP server. Use its tools with session_id "${sessionId}": list_files, read_file (page ranges), and search_files. Read the files before your first questions, and go back to specific pages when you test a claim.${delivery.direct ? " Some files are also attached directly so you can see their visuals." : ""}`
    : `The candidate's files are attached in the conversation (PDFs with visuals; slide decks and documents as extracted text). Study them before your first questions and refer to specific pages or slides when you test a claim.`;

  return `You are the interviewer in a rehearsal app that prepares a candidate for a real interview or defense. Stay in role for the whole session.

Who you are:
${settings.persona.trim()}

${settings.context.trim() ? `What the candidate told you about this interview:\n<interview_context>\n${settings.context.trim()}\n</interview_context>\n\n` : ""}How the session works
- The candidate may first give a timed presentation. You receive it as a speech-to-text transcript. Bracketed lines such as [Viewing "deck.pptx" — slide 3/12: …] mark which slide or page was on screen at that point, so you can tie what was said to what was shown.
- Everything the candidate sends was usually spoken and then transcribed. Expect misheard words, missing punctuation and filler words. Don't critique transcription errors; critique substance, structure, evidence and clarity.
- ${fileAccess}

Each reply
1. Start with a short, candid reaction to what the candidate just said: what held up, and what was vague, unsupported, inconsistent with their own slides, or missing. Be specific and demanding, the way a strict panel is, but fair. No generic praise.
2. Then ask one to four questions, usually two or three, as a numbered list. Each should be answerable aloud in one or two minutes. Aim at the weakest reasoning first.
3. Where it fits, ground questions in the Philippine setting (laws and codes, climate and hazards, local materials, practice and social context) and in international benchmarks and precedents. Only cite a specific law section, standard clause or statistic when you're sure it's correct; otherwise ask the candidate to cite it.
4. When the candidate answers, judge the answer against the question. If they dodged it, stayed vague, or got a fact wrong, say so plainly and press with a follow-up before moving on.

Keep each reply short enough to read aloud in about a minute: a few sentences of feedback, then the numbered questions. Plain prose; no headings.

Ending the session
Keep the back-and-forth going until you judge the candidate is ready, which usually takes several rounds covering the main lines of critique. Then give a final assessment: a readiness verdict, their strongest points, the three things most worth fixing or rehearsing, and questions they should expect from the real panel. Put ${COMPLETE_TOKEN} alone on the last line of that final message, and never use it before then. If the candidate keeps going after that, continue the interview normally.`;
}

// Expand {type:"_files"} placeholders into document/image blocks.
async function expandMessages(apiMessages) {
  const out = [];
  for (const m of apiMessages) {
    if (m.role !== "user" || typeof m.content === "string") {
      out.push(m);
      continue;
    }
    const content = [];
    for (const block of m.content) {
      if (block.type !== "_files") {
        content.push(block);
        continue;
      }
      for (const id of block.fileIds) {
        const rec = await fileStore.get(id);
        if (!rec) continue;
        content.push(...(await attachmentBlocks(rec)));
      }
    }
    out.push({ role: m.role, content });
  }
  return out;
}

async function attachmentBlocks(rec) {
  if (rec.kind === "pdf") {
    return [
      {
        type: "document",
        title: rec.name,
        source: { type: "base64", media_type: "application/pdf", data: await blobToBase64(rec.blob) },
      },
    ];
  }
  if (rec.kind === "image") {
    const media = ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(rec.type) ? rec.type : "image/png";
    return [
      { type: "text", text: `Image file: ${rec.name}` },
      { type: "image", source: { type: "base64", media_type: media, data: await blobToBase64(rec.blob) } },
    ];
  }
  const unit = rec.kind === "pptx" ? "Slide" : "Page";
  const text = rec.pages
    .map((p, i) => `--- ${unit} ${i + 1}${p.title ? `: ${p.title}` : ""} ---\n${p.text || "(no text)"}`)
    .join("\n\n");
  return [
    {
      type: "document",
      title: rec.name,
      source: { type: "text", media_type: "text/plain", data: text || "(no extractable text)" },
    },
  ];
}

// After a mid-output fallback, only text (and paired server-tool) blocks
// before the last fallback marker may be echoed back.
function sanitizeForHistory(content) {
  const lastFb = content.map((b) => b.type).lastIndexOf("fallback");
  if (lastFb < 0) return content;
  return content.filter((b, i) => i >= lastFb || b.type === "text");
}

export class Interviewer {
  constructor() {
    this.client = null;
    this.key = null;
    this.abort = null;
  }

  _client(apiKey) {
    if (!this.client || this.key !== apiKey) {
      this.client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true, maxRetries: 2 });
      this.key = apiKey;
    }
    return this.client;
  }

  cancel() {
    this.abort?.abort();
  }

  /**
   * Run one interviewer turn. Appends assistant message(s) to session.apiMessages.
   * callbacks: onText(fullTextSoFar), onStatus(string)
   * Returns { text, stopReason, complete }.
   */
  async respond(session, global, { onText, onStatus }) {
    const client = this._client(global.apiKey);
    const delivery = fileDelivery(global);
    const tools = [];
    const betas = [];
    const params = {
      model: global.model,
      max_tokens: 32000,
      thinking: { type: "adaptive" },
      output_config: { effort: global.effort || "high" },
      system: session.system,
      cache_control: { type: "ephemeral" },
    };
    if (delivery.mcp) {
      betas.push("mcp-client-2025-11-20");
      params.mcp_servers = [
        { type: "url", url: mcpEndpoint(global.mcpUrl), name: MCP_SERVER_NAME, authorization_token: global.mcpToken },
      ];
      tools.push({ type: "mcp_toolset", mcp_server_name: MCP_SERVER_NAME });
    }
    if (global.webSearch && WEB_SEARCH_MODELS.has(global.model)) {
      tools.push({ type: "web_search_20260209", name: "web_search", max_uses: 3 });
    }
    if (FALLBACK_MODELS.has(global.model)) {
      betas.push("server-side-fallback-2026-07-01");
      params.fallbacks = "default";
    }
    if (tools.length) params.tools = tools;
    if (betas.length) params.betas = betas;

    let fullText = "";
    const pending = []; // assistant messages from this turn (pause_turn continuations)
    this.abort = new AbortController();

    for (let hop = 0; hop < 6; hop++) {
      const messages = await expandMessages([...session.apiMessages, ...pending]);
      onStatus?.("thinking");
      const stream = client.beta.messages.stream({ ...params, messages }, { signal: this.abort.signal });
      for await (const ev of stream) {
        if (ev.type === "content_block_start") {
          const t = ev.content_block.type;
          if (t === "mcp_tool_use") onStatus?.(`reading files (${ev.content_block.name || "tool"})`);
          else if (t === "server_tool_use") onStatus?.("searching the web");
          else if (t === "text") onStatus?.("writing");
        } else if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
          fullText += ev.delta.text;
          onText?.(fullText);
        }
      }
      const msg = await stream.finalMessage();

      if (msg.stop_reason === "refusal") {
        const err = new Error(
          "The interviewer declined to answer this message (safety filter). Try rephrasing it." +
            (msg.stop_details?.explanation ? ` (${msg.stop_details.explanation})` : "")
        );
        err.refusal = true;
        throw err;
      }

      pending.push({ role: "assistant", content: sanitizeForHistory(msg.content) });
      if (msg.stop_reason === "pause_turn") continue; // server tool loop paused; resume
      session.apiMessages.push(...pending);
      const complete = fullText.includes(COMPLETE_TOKEN);
      return { text: fullText, stopReason: msg.stop_reason, complete };
    }
    session.apiMessages.push(...pending);
    return { text: fullText, stopReason: "pause_turn", complete: false };
  }
}

export function mcpEndpoint(url) {
  const u = url.trim().replace(/\/+$/, "");
  return /\/mcp$/.test(u) ? u : `${u}/mcp`;
}

export function mcpBase(url) {
  return url.trim().replace(/\/+$/, "").replace(/\/mcp$/, "");
}

// ---------- MCP file sync (REST side of the MCP server) ----------

export async function syncFileToMcp(global, sessionId, rec) {
  const res = await fetch(`${mcpBase(global.mcpUrl)}/api/sessions/${encodeURIComponent(sessionId)}/files/${encodeURIComponent(rec.id)}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${global.mcpToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: rec.name, kind: rec.kind, pages: rec.pages }),
  });
  if (!res.ok) throw new Error(`MCP upload failed (${res.status})`);
  return res.json();
}

export async function deleteFileFromMcp(global, sessionId, fileId) {
  await fetch(`${mcpBase(global.mcpUrl)}/api/sessions/${encodeURIComponent(sessionId)}/files/${encodeURIComponent(fileId)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${global.mcpToken}` },
  });
}

export async function deleteSessionFromMcp(global, sessionId) {
  await fetch(`${mcpBase(global.mcpUrl)}/api/sessions/${encodeURIComponent(sessionId)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${global.mcpToken}` },
  });
}

export async function testMcp(global) {
  const res = await fetch(mcpEndpoint(global.mcpUrl), {
    method: "POST",
    headers: { Authorization: `Bearer ${global.mcpToken}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  if (res.status === 401) throw new Error("The MCP server rejected the token.");
  if (!res.ok) throw new Error(`MCP server answered ${res.status}.`);
  const data = await res.json();
  return (data.result?.tools || []).map((t) => t.name);
}
