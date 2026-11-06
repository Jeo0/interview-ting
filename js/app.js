import {
  loadGlobal, saveGlobal, loadSessions, saveSessions, loadActiveId, saveActiveId,
  newSession, files as fileStore, uid, DEFAULT_PERSONA,
} from "./store.js";
import { detectKind, extractPages, openDoc, ACCEPT } from "./docs.js";
import { SpeechInput, speechSupported } from "./speech.js";
import { renderMarkdown, escapeHtml } from "./markdown.js";
import {
  Interviewer, MODELS, COMPLETE_TOKEN, buildSystemPrompt, fileDelivery,
  syncFileToMcp, deleteFileFromMcp, deleteSessionFromMcp, testMcp,
} from "./interviewer.js";

const $ = (id) => document.getElementById(id);
const el = {
  tabs: $("tabs"), newSessionBtn: $("newSessionBtn"), settingsBtn: $("settingsBtn"),
  fileTabs: $("fileTabs"), stage: $("stage"), prevBtn: $("prevBtn"), nextBtn: $("nextBtn"),
  pageInfo: $("pageInfo"), insertViewBtn: $("insertViewBtn"),
  presBtn: $("presBtn"), timer: $("timer"), presStatus: $("presStatus"), endPresBtn: $("endPresBtn"),
  banner: $("banner"), messages: $("messages"), composer: $("composer"), interim: $("interim"),
  input: $("input"), micBtn: $("micBtn"), micLabel: $("micLabel"), sendBtn: $("sendBtn"),
  dialog: $("settingsDialog"), form: $("settingsForm"),
  sTitle: $("sTitle"), sMinutes: $("sMinutes"), sSeconds: $("sSeconds"), sMic: $("sMic"),
  sFiles: $("sFiles"), dropzone: $("dropzone"), fileList: $("fileList"), sContext: $("sContext"),
  sPersona: $("sPersona"), resetPersonaBtn: $("resetPersonaBtn"),
  gLang: $("gLang"), gKey: $("gKey"), gModel: $("gModel"), gEffort: $("gEffort"),
  gMcpUrl: $("gMcpUrl"), gMcpToken: $("gMcpToken"), testMcpBtn: $("testMcpBtn"), mcpStatus: $("mcpStatus"),
  gDelivery: $("gDelivery"), gWeb: $("gWeb"), deleteSessionBtn: $("deleteSessionBtn"),
  countdown: $("countdown"), toast: $("toast"),
};

const state = {
  global: loadGlobal(),
  sessions: [],
  activeId: null,
  fileRecs: new Map(), // fileId -> record (active session)
  docs: new Map(), // fileId -> opened doc
  busy: false,
  pres: { phase: "idle", startedAt: 0, endsAt: 0, duration: 0, tick: null, preTimer: null },
};
const interviewer = new Interviewer();

// ---------------------------------------------------------------- helpers

const active = () => state.sessions.find((s) => s.id === state.activeId);
const fmt = (sec) => {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const timerSeconds = (s) => Math.max(0, (Number(s.settings.timerMinutes) || 0) * 60 + (Number(s.settings.timerSeconds) || 0));

let saveTimer = null;
function persist(now = false) {
  clearTimeout(saveTimer);
  const run = () => saveSessions(state.sessions).catch((e) => toast(`Couldn't save: ${e.message || e}`));
  if (now) return run();
  saveTimer = setTimeout(run, 300);
}

let toastTimer = null;
function toast(msg, ms = 4500) {
  el.toast.textContent = msg;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.toast.hidden = true), ms);
}

function setBanner(html, kind = "warn") {
  if (!html) {
    el.banner.hidden = true;
    el.banner.innerHTML = "";
    return;
  }
  el.banner.hidden = false;
  el.banner.className = `banner ${kind === "ok" ? "ok" : ""}`;
  el.banner.innerHTML = html;
}

function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [0, 0.35, 0.7].forEach((t) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = 880;
      g.gain.setValueAtTime(0.0001, ctx.currentTime + t);
      g.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + t + 0.25);
      o.connect(g).connect(ctx.destination);
      o.start(ctx.currentTime + t);
      o.stop(ctx.currentTime + t + 0.3);
    });
    setTimeout(() => ctx.close(), 1500);
  } catch {}
}

// Append text to the message box (speech results, slide markers).
function appendToInput(text, { line = false } = {}) {
  if (!text) return;
  const v = el.input.value;
  let sep = "";
  if (v) {
    if (line) sep = v.endsWith("\n") ? "" : "\n";
    else sep = /\s$/.test(v) ? "" : " ";
  }
  el.input.value = v + sep + text + (line ? "\n" : "");
  el.input.scrollTop = el.input.scrollHeight;
  const s = active();
  if (s) {
    s.draft = el.input.value;
    persist();
  }
  updateControls();
}

// ---------------------------------------------------------------- speech

const speech = new SpeechInput({
  onFinal: (t) => appendToInput(t),
  onInterim: (t) => (el.interim.textContent = t ? `Hearing: ${t}` : ""),
  onState: () => updateControls(),
  onError: (m) => toast(m, 7000),
});
speech.setLang(state.global.speechLang);

function micOn() {
  if (!speechSupported) {
    toast("Speech-to-text isn't available in this browser. Use Chrome, Edge or Safari — or type your answer.", 7000);
    return;
  }
  speech.start();
  updateControls();
}
function micOff() {
  speech.stop();
  updateControls();
}

// ---------------------------------------------------------------- sessions / tabs

function renderTabs() {
  el.tabs.replaceChildren();
  const locked = state.pres.phase !== "idle" || state.busy;
  for (const s of state.sessions) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "tab";
    b.setAttribute("role", "tab");
    b.setAttribute("aria-selected", String(s.id === state.activeId));
    b.disabled = locked && s.id !== state.activeId;
    b.title = s.title;
    b.innerHTML = `${s.complete ? '<span class="tab-dot" title="Interview complete"></span>' : ""}<span class="tab-name">${escapeHtml(s.title)}</span>`;
    if (state.sessions.length > 1) {
      const x = document.createElement("span");
      x.className = "tab-close";
      x.setAttribute("role", "button");
      x.setAttribute("aria-label", `Close ${s.title}`);
      x.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>';
      x.addEventListener("click", (e) => {
        e.stopPropagation();
        if (!locked) deleteSession(s.id);
      });
      b.appendChild(x);
    }
    b.addEventListener("click", () => switchSession(s.id));
    el.tabs.appendChild(b);
  }
}

async function switchSession(id) {
  if (id === state.activeId) return;
  if (state.pres.phase !== "idle" || state.busy) {
    toast("Finish the current presentation or reply first.");
    return;
  }
  micOff();
  const prev = active();
  if (prev) prev.draft = el.input.value;
  state.activeId = id;
  saveActiveId(id);
  await loadActiveSession();
}

async function loadActiveSession() {
  for (const d of state.docs.values()) d.destroy?.();
  state.docs.clear();
  state.fileRecs.clear();
  const s = active();
  for (const fid of s.fileIds) {
    const rec = await fileStore.get(fid);
    if (rec && !rec.removed) state.fileRecs.set(fid, rec);
  }
  if (!s.view.activeFileId || !state.fileRecs.has(s.view.activeFileId)) {
    s.view.activeFileId = visibleFileIds(s)[0] || null;
  }
  el.input.value = s.draft || "";
  el.timer.textContent = fmt(timerSeconds(s));
  el.timer.className = "timer";
  setBanner(s.complete ? completeBannerHtml() : "", "ok");
  renderTabs();
  renderMessages();
  renderFileTabs();
  await renderStage();
  updateControls();
}

function visibleFileIds(s) {
  return s.fileIds.filter((id) => state.fileRecs.has(id));
}

function createSession() {
  if (state.pres.phase !== "idle" || state.busy) {
    toast("Finish the current presentation or reply first.");
    return;
  }
  const n = state.sessions.length + 1;
  const s = newSession(n);
  s.title = `Interview ${n}`;
  state.sessions.push(s);
  persist(true);
  switchSession(s.id).then(() => openSettings());
}

async function deleteSession(id) {
  const s = state.sessions.find((x) => x.id === id);
  if (!s) return;
  if (!confirm(`Delete "${s.title}"? Its conversation and files will be removed from this browser.`)) return;
  for (const fid of s.fileIds) await fileStore.delete(fid).catch(() => {});
  if (state.global.mcpUrl && state.global.mcpToken) deleteSessionFromMcp(state.global, s.id).catch(() => {});
  state.sessions = state.sessions.filter((x) => x.id !== id);
  if (!state.sessions.length) state.sessions.push(newSession(1));
  persist(true);
  if (state.activeId === id) {
    state.activeId = null;
    await switchSession(state.sessions[state.sessions.length - 1].id);
  } else {
    renderTabs();
  }
}

// ---------------------------------------------------------------- messages

function welcomeHtml(s) {
  const t = fmt(timerSeconds(s));
  return `<div class="welcome">
    <h3>Ready when you are</h3>
    <ol>
      <li>Open <strong>Interview settings</strong> to add your files, set the timer (now ${t}) and add your Anthropic API key.</li>
      <li>Press <strong>Start presentation</strong>. The countdown starts and the microphone transcribes you. Use the arrows (or a clicker) to move through your slides — each change is noted in the message box.</li>
      <li>When time is up, turn off the mic, tidy the transcript, and press <strong>Send</strong>.</li>
      <li>The panel will critique you and ask a few questions. The mic turns on for your answer; edit it, send, and repeat until the panel says you're ready.</li>
    </ol>
    <p>You can also just type a message to start the interview without presenting.</p>
  </div>`;
}

function messageNode(m) {
  const d = document.createElement("div");
  if (m.role === "user") {
    d.className = `msg user ${m.kind === "presentation" ? "presentation" : ""}`;
    const meta = m.kind === "presentation" ? `<div class="meta">Presentation transcript${m.duration ? ` · ${escapeHtml(m.duration)}` : ""}</div>` : "";
    d.innerHTML = `${meta}<div class="body"></div>`;
    d.querySelector(".body").textContent = m.text;
  } else if (m.role === "assistant") {
    d.className = "msg assistant";
    d.innerHTML = `<div class="meta">Interviewer</div><div class="body">${renderMarkdown(m.text.replace(COMPLETE_TOKEN, "").trim())}</div>`;
  } else if (m.role === "error") {
    d.className = "msg error";
    d.textContent = m.text;
  } else {
    d.className = "msg note";
    d.textContent = m.text;
  }
  return d;
}

function renderMessages() {
  const s = active();
  el.messages.replaceChildren();
  if (!s.chat.length) el.messages.insertAdjacentHTML("beforeend", welcomeHtml(s));
  for (const m of s.chat) el.messages.appendChild(messageNode(m));
  scrollToBottom();
}

function scrollToBottom() {
  requestAnimationFrame(() => (el.messages.scrollTop = el.messages.scrollHeight));
}

function completeBannerHtml() {
  return `<strong>The panel considers you ready.</strong> Review the final assessment above. You can keep practising here, or start a <button class="btn btn-ghost small" type="button" data-action="new">+ New interview</button>`;
}

// ---------------------------------------------------------------- files / viewer

function renderFileTabs() {
  const s = active();
  el.fileTabs.replaceChildren();
  for (const id of visibleFileIds(s)) {
    const rec = state.fileRecs.get(id);
    const b = document.createElement("button");
    b.type = "button";
    b.className = "file-tab";
    b.setAttribute("role", "tab");
    b.setAttribute("aria-selected", String(id === s.view.activeFileId));
    b.title = rec.name;
    b.innerHTML = `${escapeHtml(rec.name)}<span class="kind">${rec.kind}</span>`;
    b.addEventListener("click", () => selectFile(id));
    el.fileTabs.appendChild(b);
  }
}

async function getDoc(id) {
  if (!state.docs.has(id)) {
    const rec = state.fileRecs.get(id);
    state.docs.set(id, await openDoc(rec));
  }
  return state.docs.get(id);
}

let renderSeq = 0;
async function renderStage() {
  const s = active();
  const id = s.view.activeFileId;
  const seq = ++renderSeq;
  if (!id) {
    el.stage.innerHTML = `<div class="empty"><p>No files yet. Add your slides or thesis PDF in Interview settings — the interviewer will read them too.</p><button class="btn btn-primary" type="button" data-action="settings">Add files</button></div>`;
    el.pageInfo.textContent = "No file";
    updateControls();
    return;
  }
  try {
    if (!state.docs.has(id)) el.stage.innerHTML = `<div class="stage-loading">Loading…</div>`;
    const doc = await getDoc(id);
    if (seq !== renderSeq) return;
    const page = clampPage(s, id, doc);
    await doc.render(el.stage, page);
    if (seq !== renderSeq) return;
    el.pageInfo.textContent = `${doc.unit[0].toUpperCase() + doc.unit.slice(1)} ${page + 1} of ${doc.pageCount}`;
  } catch (e) {
    console.error(e);
    el.stage.innerHTML = `<div class="empty"><p>Couldn't display this file: ${escapeHtml(e.message || String(e))}</p></div>`;
  }
  updateControls();
}

function clampPage(s, id, doc) {
  const p = Math.min(Math.max(0, s.view.pages[id] || 0), Math.max(0, doc.pageCount - 1));
  s.view.pages[id] = p;
  return p;
}

function currentViewText() {
  const s = active();
  const id = s.view.activeFileId;
  const rec = id && state.fileRecs.get(id);
  const doc = id && state.docs.get(id);
  if (!rec || !doc) return null;
  const p = s.view.pages[id] || 0;
  const unit = doc.unit;
  const page = rec.pages?.[p] || {};
  let label = (page.title || page.text || "").replace(/\s+/g, " ").trim();
  if (label.length > 90) label = label.slice(0, 87) + "…";
  return `[Viewing "${rec.name}" — ${unit} ${p + 1}/${doc.pageCount}${label ? `: ${label}` : ""}]`;
}

function shouldLogViews() {
  return state.pres.phase === "running" || state.pres.phase === "timeup" || speech.active;
}

async function goPage(delta) {
  const s = active();
  const id = s.view.activeFileId;
  if (!id) return;
  const doc = await getDoc(id);
  const before = s.view.pages[id] || 0;
  const next = Math.min(Math.max(0, before + delta), doc.pageCount - 1);
  if (next === before) return;
  s.view.pages[id] = next;
  persist();
  await renderStage();
  if (shouldLogViews()) appendToInput(currentViewText(), { line: true });
}

async function selectFile(id) {
  const s = active();
  if (s.view.activeFileId === id) return;
  s.view.activeFileId = id;
  persist();
  renderFileTabs();
  await renderStage();
  if (shouldLogViews()) appendToInput(currentViewText(), { line: true });
}

async function addFiles(fileList) {
  const s = active();
  for (const file of Array.from(fileList)) {
    const kind = detectKind(file);
    if (kind === "unsupported") {
      toast(`${file.name}: unsupported type. Use PDF, PPTX, DOCX, images or text.`);
      continue;
    }
    const item = document.createElement("li");
    item.innerHTML = `<span class="fname">${escapeHtml(file.name)}</span><span class="fmeta">Reading…</span>`;
    el.fileList.appendChild(item);
    try {
      const pages = await extractPages(kind, file);
      const rec = {
        id: uid("f"), sessionId: s.id, name: file.name, type: file.type, size: file.size, kind,
        blob: file, pages, addedAt: Date.now(), mcpSynced: false,
      };
      await fileStore.put(rec);
      s.fileIds.push(rec.id);
      state.fileRecs.set(rec.id, rec);
      if (!s.view.activeFileId) s.view.activeFileId = rec.id;
      persist();
      syncOne(s, rec);
    } catch (e) {
      console.error(e);
      toast(`Couldn't read ${file.name}: ${e.message || e}`, 7000);
    }
  }
  renderFileList();
  renderFileTabs();
  renderStage();
}

async function syncOne(s, rec) {
  const g = state.global;
  if (!g.mcpUrl || !g.mcpToken) return false;
  try {
    await syncFileToMcp(g, s.id, rec);
    rec.mcpSynced = true;
    rec.mcpError = null;
  } catch (e) {
    rec.mcpSynced = false;
    rec.mcpError = e.message || String(e);
  }
  await fileStore.put(rec).catch(() => {});
  if (el.dialog.open) renderFileList();
  return rec.mcpSynced;
}

async function removeFile(id) {
  const s = active();
  const rec = state.fileRecs.get(id);
  if (!rec) return;
  if (s.sentFileIds.includes(id)) {
    // Already part of the conversation: keep the bytes so the history stays
    // identical, just hide it from the viewer.
    rec.removed = true;
    await fileStore.put(rec);
  } else {
    await fileStore.delete(id);
    s.fileIds = s.fileIds.filter((x) => x !== id);
  }
  state.docs.get(id)?.destroy?.();
  state.docs.delete(id);
  state.fileRecs.delete(id);
  if (state.global.mcpUrl && state.global.mcpToken) deleteFileFromMcp(state.global, s.id, id).catch(() => {});
  if (s.view.activeFileId === id) s.view.activeFileId = visibleFileIds(s)[0] || null;
  persist();
  renderFileList();
  renderFileTabs();
  renderStage();
}

function renderFileList() {
  const s = active();
  const g = state.global;
  const mcp = g.mcpUrl && g.mcpToken;
  el.fileList.replaceChildren();
  for (const id of visibleFileIds(s)) {
    const rec = state.fileRecs.get(id);
    const li = document.createElement("li");
    const unit = rec.kind === "pptx" ? "slide" : "page";
    const n = rec.pages?.length || 1;
    const sync = !mcp ? "" : rec.mcpSynced ? '<span class="sync ok">On MCP server</span>' : `<span class="sync err" title="${escapeHtml(rec.mcpError || "")}">Not uploaded</span>`;
    li.innerHTML = `<span class="fname" title="${escapeHtml(rec.name)}">${escapeHtml(rec.name)}</span>
      <span class="fmeta">${rec.kind.toUpperCase()} · ${n} ${unit}${n === 1 ? "" : "s"}</span>${sync}
      <button class="btn icon-btn" type="button" aria-label="Remove ${escapeHtml(rec.name)}"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>`;
    li.querySelector("button").addEventListener("click", () => removeFile(id));
    el.fileList.appendChild(li);
  }
}

// ---------------------------------------------------------------- presentation

function startPresentation() {
  const s = active();
  if (state.pres.phase !== "idle" || state.busy) return;
  const duration = timerSeconds(s);
  if (!duration) {
    toast("Set a presentation time in Interview settings first.");
    openSettings();
    return;
  }
  state.pres.phase = "countdown";
  state.pres.duration = duration;
  renderTabs();
  updateControls();
  let n = 3;
  el.countdown.hidden = false;
  const show = () => (el.countdown.innerHTML = `${n}<small>Presentation: ${fmt(duration)}</small>`);
  show();
  state.pres.preTimer = setInterval(() => {
    n -= 1;
    if (n > 0) return show();
    clearInterval(state.pres.preTimer);
    el.countdown.hidden = true;
    beginRunning();
  }, 1000);
}

function beginRunning() {
  const s = active();
  const p = state.pres;
  p.phase = "running";
  p.startedAt = Date.now();
  p.endsAt = p.startedAt + p.duration * 1000;
  appendToInput(`[Presentation started — ${fmt(p.duration)} allotted]`, { line: true });
  const view = currentViewText();
  if (view) appendToInput(view, { line: true });
  setBanner("");
  if (s.settings.micEnabled) micOn();
  p.tick = setInterval(tickTimer, 250);
  tickTimer();
  updateControls();
}

function tickTimer() {
  const p = state.pres;
  const now = Date.now();
  if (p.phase === "running") {
    const left = (p.endsAt - now) / 1000;
    el.timer.textContent = fmt(Math.ceil(left));
    el.timer.className = `timer running ${left <= 60 ? "low" : ""}`;
    if (left <= 0) timeUp(false);
  } else if (p.phase === "timeup") {
    if (p.endedEarly) {
      el.timer.textContent = fmt((p.stoppedAt - p.startedAt) / 1000);
      el.timer.className = "timer";
    } else {
      const o = ((p.micOffAt || now) - p.endsAt) / 1000;
      el.timer.textContent = `+${fmt(o)}`;
      el.timer.className = "timer over";
    }
  }
}

function timeUp(early) {
  const p = state.pres;
  if (p.phase !== "running") return;
  p.phase = "timeup";
  p.endedEarly = early;
  p.stoppedAt = Date.now();
  const used = fmt((p.stoppedAt - p.startedAt) / 1000);
  appendToInput(early ? `[Presentation ended by the candidate at ${used} of ${fmt(p.duration)}]` : `[Time's up — ${fmt(p.duration)} reached]`, { line: true });
  if (!early) beep();
  setBanner(
    speech.active
      ? `<strong>${early ? "Presentation ended." : "Time's up!"}</strong> Finish your sentence, then turn off the microphone. Review and edit your transcript, and press Send.`
      : `<strong>${early ? "Presentation ended." : "Time's up!"}</strong> Review and edit your transcript, then press Send.`
  );
  updateControls();
  tickTimer();
}

function finishPresentationState() {
  const p = state.pres;
  clearInterval(p.tick);
  clearInterval(p.preTimer);
  let summary = null;
  if (p.startedAt && p.endedEarly) {
    summary = `ended at ${fmt((p.stoppedAt - p.startedAt) / 1000)} of ${fmt(p.duration)} allotted`;
  } else if (p.startedAt) {
    const over = Math.max(0, ((p.micOffAt || Date.now()) - p.endsAt) / 1000);
    summary = `${fmt(p.duration)} allotted${over >= 5 ? `, kept speaking ${fmt(over)} past the limit` : ", finished on time"}`;
  }
  state.pres = { phase: "idle", startedAt: 0, endsAt: 0, duration: 0, tick: null, preTimer: null };
  el.timer.textContent = fmt(timerSeconds(active()));
  el.timer.className = "timer";
  el.countdown.hidden = true;
  renderTabs();
  return summary;
}

function cancelPresentation() {
  if (state.pres.phase === "countdown") {
    finishPresentationState();
    updateControls();
  }
}

// ---------------------------------------------------------------- sending

async function send() {
  const s = active();
  const g = state.global;
  if (state.busy) {
    interviewer.cancel();
    return;
  }
  let text = el.input.value.trim();
  if (!text) return;
  if (!g.apiKey) {
    toast("Add your Anthropic API key in Interview settings first.");
    openSettings("gKey");
    return;
  }
  if (state.pres.phase === "countdown") return;
  if (state.pres.phase === "running") {
    if (!confirm("End the presentation now?")) return;
    timeUp(true);
    micOff();
    toast("Presentation ended. Review and edit your transcript, then press Send.");
    return;
  }
  if (state.pres.phase === "timeup" && speech.active) {
    toast("Turn off the microphone first, then review your transcript and send.");
    return;
  }

  let kind = "answer";
  let duration = null;
  if (state.pres.phase === "timeup") {
    kind = "presentation";
    duration = finishPresentationState();
  }
  micOff();

  // ---- build the user turn (append-only history)
  const delivery = fileDelivery(g);
  const visible = visibleFileIds(s);
  const isFirst = !s.system;
  if (isFirst) {
    s.system = buildSystemPrompt(s.settings, s.id, delivery);
    s.settingsSnapshot = settingsSignature(s, delivery);
  }
  const notes = [];
  const settingsSig = settingsSignature(s, delivery);
  if (!isFirst && settingsSig !== s.settingsSnapshot) {
    notes.push(
      `[Interview settings were updated. Interviewer persona: ${s.settings.persona.trim()}${s.settings.context.trim() ? ` | Context: ${s.settings.context.trim()}` : ""}${delivery.mcp ? ` | Files are available through the ${"interview_files"} MCP tools with session_id "${s.id}".` : ""}]`
    );
    s.settingsSnapshot = settingsSig;
  }

  const newFiles = visible.filter((id) => !s.sentFileIds.includes(id));
  if (delivery.mcp) {
    // make sure everything is on the MCP server before the interviewer looks
    for (const id of visible) {
      const rec = state.fileRecs.get(id);
      if (!rec.mcpSynced) await syncOne(s, rec);
    }
  }
  const content = [];
  if (newFiles.length) {
    if (delivery.direct) content.push({ type: "_files", fileIds: newFiles });
    const list = newFiles
      .map((id, i) => {
        const r = state.fileRecs.get(id);
        const n = r.pages?.length || 1;
        return `${i + 1}. ${r.name} (file_id ${r.id}, ${r.kind.toUpperCase()}, ${n} ${r.kind === "pptx" ? "slide" : "page"}${n === 1 ? "" : "s"})`;
      })
      .join("\n");
    notes.push(
      `[${isFirst ? "Files for this interview" : "New files added"}:\n${list}${delivery.mcp ? `\nRead them with the interview_files MCP tools, session_id "${s.id}".` : ""}]`
    );
  } else if (isFirst) {
    notes.push("[The candidate hasn't uploaded any files.]");
  }

  let body = text;
  if (kind === "presentation") {
    body = `Here is the transcript of my presentation (speech-to-text; ${duration}).\n\n${text}`;
  }
  content.push({ type: "text", text: (notes.length ? notes.join("\n\n") + "\n\n" : "") + body });

  const userMsg = { role: "user", content };
  s.apiMessages.push(userMsg);
  const chatUser = { role: "user", text, kind, duration, ts: Date.now() };
  s.chat.push(chatUser);
  const sentNow = newFiles.filter((id) => !s.sentFileIds.includes(id));
  s.sentFileIds.push(...sentNow);
  el.input.value = "";
  s.draft = "";
  setBanner("");
  persist(true);
  if (s.chat.length === 1) renderMessages();
  else el.messages.appendChild(messageNode(chatUser));

  // ---- stream the interviewer's reply
  state.busy = true;
  renderTabs();
  updateControls();
  const bubble = document.createElement("div");
  bubble.className = "msg assistant";
  bubble.innerHTML = `<div class="meta">Interviewer</div><div class="body"></div><div class="status-line"><span class="dots"><i></i><i></i><i></i></span><span class="st">Reading your ${kind === "presentation" ? "presentation" : "answer"}…</span></div>`;
  el.messages.appendChild(bubble);
  scrollToBottom();
  const bodyEl = bubble.querySelector(".body");
  const stEl = bubble.querySelector(".st");
  const statusLine = bubble.querySelector(".status-line");
  let lastRender = 0;

  try {
    const result = await interviewer.respond(s, g, {
      onText: (t) => {
        const now = performance.now();
        if (now - lastRender < 60) return;
        lastRender = now;
        bodyEl.innerHTML = renderMarkdown(t.replace(COMPLETE_TOKEN, ""));
        const nearBottom = el.messages.scrollHeight - el.messages.scrollTop - el.messages.clientHeight < 160;
        if (nearBottom) el.messages.scrollTop = el.messages.scrollHeight;
      },
      onStatus: (st) => {
        stEl.textContent = st === "thinking" ? "Thinking…" : st === "writing" ? "Writing…" : `${st[0].toUpperCase()}${st.slice(1)}…`;
      },
    });
    statusLine.remove();
    const shown = result.text.replace(COMPLETE_TOKEN, "").trim() || "(The interviewer returned no text. Try sending again.)";
    bodyEl.innerHTML = renderMarkdown(shown);
    s.chat.push({ role: "assistant", text: result.text, ts: Date.now() });
    if (result.stopReason === "max_tokens") s.chat.push({ role: "note", text: "The reply was cut off by the length limit." });
    if (result.complete) {
      s.complete = true;
      setBanner(completeBannerHtml(), "ok");
    }
    persist(true);
    state.busy = false;
    renderTabs();
    updateControls();
    scrollToBottom();
    // Hand the floor back: mic on automatically for the answer.
    if (!result.complete && s.settings.micEnabled && speechSupported && state.activeId === s.id) micOn();
    el.input.focus({ preventScroll: true });
  } catch (e) {
    console.error(e);
    // Roll back the user turn so the history stays valid; give the text back.
    const i = s.apiMessages.lastIndexOf(userMsg);
    if (i >= 0) s.apiMessages.splice(i, 1);
    const j = s.chat.lastIndexOf(chatUser);
    if (j >= 0) s.chat.splice(j, 1);
    s.sentFileIds = s.sentFileIds.filter((id) => !sentNow.includes(id));
    if (isFirst) {
      s.system = null;
      s.settingsSnapshot = null;
    }
    el.input.value = text + (el.input.value ? "\n" + el.input.value : "");
    s.draft = el.input.value;
    state.busy = false;
    persist(true);
    renderMessages();
    const aborted = e?.name === "AbortError" || /abort/i.test(e?.message || "");
    if (!aborted) {
      const err = document.createElement("div");
      err.className = "msg error";
      err.textContent = describeError(e);
      el.messages.appendChild(err);
      scrollToBottom();
    }
    renderTabs();
    updateControls();
  }
}

function settingsSignature(s, delivery) {
  return JSON.stringify([s.settings.persona.trim(), s.settings.context.trim(), delivery.mcp]);
}

function describeError(e) {
  const status = e?.status;
  if (e?.refusal) return e.message;
  if (status === 401) return "The API key was rejected. Check it in Interview settings.";
  if (status === 403) return "This API key isn't allowed to use that model or feature.";
  if (status === 429) return "Rate limited by the API. Wait a moment and send again.";
  if (status === 529 || status === 503) return "The API is overloaded right now. Wait a moment and send again.";
  if (status === 400) {
    const msg = e?.error?.error?.message || e?.message || "";
    if (/mcp/i.test(msg)) return `The MCP server couldn't be used: ${msg}. Check its URL and token, or switch file delivery to "Attach files directly".`;
    return `The request was rejected: ${msg}`;
  }
  if (e instanceof TypeError || /fetch|network/i.test(e?.message || "")) return "Network error — check your connection and send again.";
  return `Something went wrong: ${e?.message || e}`;
}

// ---------------------------------------------------------------- controls

function updateControls() {
  const s = active();
  if (!s) return;
  const p = state.pres.phase;
  const hasText = el.input.value.trim().length > 0;
  const listening = speech.active;

  el.micBtn.setAttribute("aria-pressed", String(listening));
  el.micBtn.disabled = state.busy;
  el.micLabel.textContent = listening ? "Listening — click to turn off the mic" : speechSupported ? "Mic off" : "Speech-to-text not supported in this browser";

  if (state.busy) {
    el.sendBtn.classList.add("stop");
    el.sendBtn.querySelector("span").textContent = "Stop";
    el.sendBtn.disabled = false;
  } else {
    el.sendBtn.classList.remove("stop");
    el.sendBtn.querySelector("span").textContent = "Send";
    el.sendBtn.disabled = !hasText || p === "countdown" || (p === "timeup" && listening);
    el.sendBtn.title = p === "timeup" && listening ? "Turn off the microphone first" : "";
  }
  el.input.readOnly = state.busy;

  el.presBtn.disabled = p !== "idle" || state.busy;
  el.presBtn.querySelector("span").textContent = p === "idle" ? "Start presentation" : p === "countdown" ? "Get ready…" : "Presenting";
  el.endPresBtn.hidden = p !== "running" && p !== "countdown";
  el.endPresBtn.textContent = p === "countdown" ? "Cancel" : "End presentation";
  el.presStatus.textContent =
    p === "running" ? (listening ? "Presenting — mic is on" : "Presenting — mic is off") :
    p === "timeup" ? (listening ? "Turn off the mic to finish" : "Review your transcript, then send") :
    state.busy ? "Interviewer is responding…" :
    s.complete ? "Interview complete" : "";
  if (p === "timeup" && !listening && !state.pres.micOffAt) {
    state.pres.micOffAt = Date.now();
    setBanner(`<strong>Mic off.</strong> Review and edit your transcript, then press Send.`);
    tickTimer();
  }

  const id = s.view.activeFileId;
  const doc = id && state.docs.get(id);
  const page = id ? s.view.pages[id] || 0 : 0;
  el.prevBtn.disabled = !doc || page <= 0;
  el.nextBtn.disabled = !doc || page >= doc.pageCount - 1;
  el.insertViewBtn.disabled = !doc;
}

// ---------------------------------------------------------------- settings dialog

function openSettings(focusId) {
  const s = active();
  const g = state.global;
  el.sTitle.value = s.title;
  el.sMinutes.value = s.settings.timerMinutes;
  el.sSeconds.value = s.settings.timerSeconds;
  el.sMic.checked = s.settings.micEnabled;
  el.sContext.value = s.settings.context;
  el.sPersona.value = s.settings.persona;
  el.gLang.value = g.speechLang;
  el.gKey.value = g.apiKey;
  el.gModel.value = g.model;
  el.gEffort.value = g.effort;
  el.gMcpUrl.value = g.mcpUrl;
  el.gMcpToken.value = g.mcpToken;
  el.gDelivery.value = g.delivery;
  el.gWeb.checked = g.webSearch;
  el.mcpStatus.textContent = "";
  el.sMinutes.disabled = el.sSeconds.disabled = state.pres.phase !== "idle";
  renderFileList();
  if (!el.dialog.open) el.dialog.showModal();
  if (focusId) $(focusId)?.focus();
}

function readSettingsForm() {
  const s = active();
  const g = state.global;
  s.title = el.sTitle.value.trim() || s.title;
  if (state.pres.phase === "idle") {
    s.settings.timerMinutes = Math.max(0, Math.min(180, parseInt(el.sMinutes.value, 10) || 0));
    s.settings.timerSeconds = Math.max(0, Math.min(59, parseInt(el.sSeconds.value, 10) || 0));
  }
  s.settings.micEnabled = el.sMic.checked;
  s.settings.context = el.sContext.value;
  s.settings.persona = el.sPersona.value.trim() || DEFAULT_PERSONA;
  const prevMcp = `${g.mcpUrl}|${g.mcpToken}`;
  g.speechLang = el.gLang.value;
  g.apiKey = el.gKey.value.trim();
  g.model = el.gModel.value;
  g.effort = el.gEffort.value;
  g.mcpUrl = el.gMcpUrl.value.trim();
  g.mcpToken = el.gMcpToken.value.trim();
  g.delivery = el.gDelivery.value;
  g.webSearch = el.gWeb.checked;
  speech.setLang(g.speechLang);
  saveGlobal(g);
  persist();
  if (prevMcp !== `${g.mcpUrl}|${g.mcpToken}`) {
    // new server: re-upload this session's files
    for (const rec of state.fileRecs.values()) {
      rec.mcpSynced = false;
      syncOne(s, rec);
    }
  }
  if (state.pres.phase === "idle") el.timer.textContent = fmt(timerSeconds(s));
  renderTabs();
  if (!s.chat.length) renderMessages();
}

// ---------------------------------------------------------------- events

function bindEvents() {
  el.composer.addEventListener("submit", (e) => {
    e.preventDefault();
    send();
  });
  el.input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      send();
    }
  });
  el.input.addEventListener("input", () => {
    const s = active();
    s.draft = el.input.value;
    persist();
    updateControls();
  });
  el.micBtn.addEventListener("click", () => (speech.active ? micOff() : micOn()));
  el.sendBtn.addEventListener("click", (e) => {
    if (state.busy) {
      e.preventDefault();
      interviewer.cancel();
    }
  });

  el.prevBtn.addEventListener("click", () => goPage(-1));
  el.nextBtn.addEventListener("click", () => goPage(1));
  el.insertViewBtn.addEventListener("click", () => appendToInput(currentViewText(), { line: true }));

  document.addEventListener("keydown", (e) => {
    if (el.dialog.open) return;
    const t = e.target;
    const typing = t && (t.tagName === "TEXTAREA" || t.tagName === "INPUT" || t.tagName === "SELECT" || t.isContentEditable);
    // Presentation clickers send PageUp/PageDown; honour them everywhere.
    if (e.key === "PageDown" || (!typing && e.key === "ArrowRight")) {
      e.preventDefault();
      goPage(1);
    } else if (e.key === "PageUp" || (!typing && e.key === "ArrowLeft")) {
      e.preventDefault();
      goPage(-1);
    }
  });

  el.presBtn.addEventListener("click", startPresentation);
  el.endPresBtn.addEventListener("click", () => (state.pres.phase === "countdown" ? cancelPresentation() : timeUp(true)));

  el.newSessionBtn.addEventListener("click", createSession);
  el.settingsBtn.addEventListener("click", () => openSettings());
  document.addEventListener("click", (e) => {
    const a = e.target.closest?.("[data-action]");
    if (!a) return;
    if (a.dataset.action === "settings") openSettings();
    if (a.dataset.action === "new") createSession();
  });

  el.dialog.addEventListener("close", () => {
    readSettingsForm();
    updateControls();
  });
  el.sFiles.setAttribute("accept", ACCEPT);
  el.sFiles.addEventListener("change", async () => {
    if (el.sFiles.files.length) await addFiles(el.sFiles.files);
    el.sFiles.value = "";
  });
  ["dragenter", "dragover"].forEach((ev) =>
    el.dropzone.addEventListener(ev, (e) => {
      e.preventDefault();
      el.dropzone.classList.add("drag");
    })
  );
  ["dragleave", "drop"].forEach((ev) => el.dropzone.addEventListener(ev, () => el.dropzone.classList.remove("drag")));
  el.dropzone.addEventListener("drop", (e) => {
    e.preventDefault();
    if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
  });
  el.resetPersonaBtn.addEventListener("click", () => (el.sPersona.value = DEFAULT_PERSONA));
  el.testMcpBtn.addEventListener("click", async () => {
    const g = { ...state.global, mcpUrl: el.gMcpUrl.value.trim(), mcpToken: el.gMcpToken.value.trim() };
    if (!g.mcpUrl || !g.mcpToken) {
      el.mcpStatus.textContent = "Enter the server URL and token.";
      return;
    }
    el.mcpStatus.textContent = "Testing…";
    try {
      const tools = await testMcp(g);
      el.mcpStatus.textContent = `Connected — tools: ${tools.join(", ")}`;
    } catch (e) {
      el.mcpStatus.textContent = `Failed: ${e.message || e}`;
    }
  });
  el.deleteSessionBtn.addEventListener("click", () => {
    const id = state.activeId;
    if (state.pres.phase !== "idle" || state.busy) return toast("Finish the current presentation or reply first.");
    el.dialog.close();
    deleteSession(id);
  });

  let resizeTimer = null;
  new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => active()?.view.activeFileId && renderStage(), 120);
  }).observe(el.stage);

  window.addEventListener("beforeunload", () => {
    const s = active();
    if (s) s.draft = el.input.value;
    saveSessions(state.sessions);
  });
}

// ---------------------------------------------------------------- boot

async function boot() {
  for (const m of MODELS) el.gModel.add(new Option(m.label, m.id));
  state.sessions = await loadSessions().catch(() => []);
  if (!state.sessions.length) {
    state.sessions.push(newSession(1));
    await saveSessions(state.sessions);
  }
  const saved = loadActiveId();
  state.activeId = state.sessions.some((s) => s.id === saved) ? saved : state.sessions[0].id;
  bindEvents();
  await loadActiveSession();
  if (!state.global.seenWelcome) {
    state.global.seenWelcome = true;
    saveGlobal(state.global);
    openSettings();
  }
}

boot();
