# Interview Ting

A static web app for rehearsing a thesis defense or interview. You present your slides while the microphone transcribes you, then a demanding AI panel (Claude, by default as an architecture master grounded in Philippine and international practice) critiques you and asks follow-up questions until it judges you're ready.

It runs entirely in the browser and is hosted on GitHub Pages. The interviewer is Claude through the Anthropic API. Your files reach Claude through a small **MCP server** (included in `mcp-server/`) using Anthropic's MCP connector, or by attaching them directly if you don't run a server.

## Features

- **Chat interface**: a message box you can edit before sending, a microphone button (speech to text into the box), a send button, and a scrolling conversation.
- **Presentation mode**: press *Start presentation* for a 3-2-1 lead-in, then a countdown timer (length set in Interview settings). The mic turns on and transcribes you. Each time you change slide, PDF page or file, a line such as `[Viewing "thesis.pptx" — slide 3/12: Site Analysis]` is added to the message box.
- **When time runs out** there's a beep and the timer counts overtime in red. Sending stays locked until you turn the mic off. Then you edit the transcript and send it.
- **Panel Q&A**: the interviewer reacts critically and asks 1–4 questions. When its reply ends, the mic turns back on for your answer. You edit and send, and the back-and-forth continues until the panel gives a final readiness assessment.
- **File viewer**: a tab for each file, ← / → buttons, keyboard arrows, and Page Up / Page Down (so presentation clickers work). Supports PDF, PowerPoint `.pptx` (approximate layout), Word `.docx` (text), images and text files.
- **Interview settings** (per interview): countdown timer, microphone on/off, speech language, file uploads, interview context and interviewer persona. The **Connection** settings (API key, model, rigor, MCP server, file delivery, optional web search) are shared by all interviews.
- **Sessions**: one interview is open on first load. *+ New interview* creates another with its own files, settings, context and conversation. Everything is saved in your browser (IndexedDB).

## Quick start

1. Open the site (see *Deploy* below) in **Chrome or Edge**. Safari also works. Firefox has no speech-to-text, so you'd have to type.
2. In **Interview settings**, paste an [Anthropic API key](https://console.anthropic.com/settings/keys), set the timer, and add your files.
3. Press **Start presentation**.

> **About the API key:** the key is kept in your browser's localStorage and sent only to `api.anthropic.com`, straight from your browser. That suits personal use. Don't share a deployed copy that has your key in it, and set a spending limit on the key.

## How the interviewer reads your files

| Delivery setting | What happens |
|---|---|
| **Automatic** (default) | Uses MCP if a server URL and token are set. Otherwise attaches the files. |
| **MCP connector** | The app uploads each file's extracted text (page by page) to your MCP server. Claude calls the server's `list_files`, `read_file` and `search_files` tools through Anthropic's MCP connector (`mcp_servers` + `mcp_toolset`, beta `mcp-client-2025-11-20`). |
| **Attach directly** | PDFs go to Claude as PDF documents, so it sees the visuals too. Slides and Word files go as extracted text, images as images. |
| **Both** | MCP tools plus attached visuals. |

## Running the MCP server

The server in `mcp-server/` has no dependencies. Anthropic's MCP connector has to reach it over **public HTTPS**, so `localhost` won't work unless you put a tunnel in front of it.

### Option A: Cloudflare Workers (free tier)

```bash
cd mcp-server
```

```bash
npx wrangler kv namespace create FILES
```

Paste the printed id into `wrangler.toml`. Set `ALLOW_ORIGIN` there to your Pages origin (for example `https://your-name.github.io`), then:

```bash
npx wrangler secret put MCP_TOKEN
```

```bash
npx wrangler deploy
```

Then connect the app to it:

1. Open the web app and click **Interview settings** (top right).
2. Scroll to the **Connection** section.
3. In **MCP server URL**, enter your Worker's address: `https://interview-files-mcp.<your-subdomain>.workers.dev`.
4. In **MCP server token**, enter the exact value you typed for `wrangler secret put MCP_TOKEN`.
5. Click **Test MCP connection**. It should say `Connected — tools: list_files, read_file, search_files`.
6. Click **Done**. Files you add from then on are uploaded to the server automatically.

### Option B: any Node 18+ host

```bash
cd mcp-server && MCP_TOKEN=a-long-random-secret PORT=8787 node node-server.mjs
```

Files are stored as JSON under `mcp-server/data/`. To reach it from Anthropic while testing locally, use a tunnel such as `cloudflared tunnel --url http://localhost:8787`.

### Endpoints

- `POST /mcp`: MCP (Streamable HTTP, JSON responses), protected by `Authorization: Bearer <MCP_TOKEN>`. Tools: `list_files`, `read_file`, `search_files`.
- `PUT|DELETE /api/sessions/:sessionId/files/:fileId` and `GET|DELETE /api/sessions/:sessionId`: used by the web app to upload or remove extracted file text (same bearer token).
- `GET /health`

Test it with `cd mcp-server && node test.mjs`.

## Details

- Model: `claude-opus-5-5` by default, with adaptive thinking and a selectable effort level (*Rigor*). Sonnet 5.5 and Haiku 5.5 can be chosen in settings. Opus and Sonnet requests opt into Anthropic's server-side refusal fallback (`fallbacks: "default"`).
- The conversation history is append-only and sent back unchanged each turn, including thinking blocks and MCP tool calls, with prompt caching on.
- The interviewer ends its final assessment with `<<INTERVIEW_COMPLETE>>`. The app hides that marker, shows a "ready" banner and stops turning the mic on automatically.
- Libraries are vendored in `vendor/`: the Anthropic TypeScript SDK 1.2.0 (bundled for the browser), pdf.js 3.11.174 and JSZip 3.10.1. Their licenses are in the same folder.

There's no build step. To run it locally, serve the folder with any static server:

```bash
python3 -m http.server 8000
```
