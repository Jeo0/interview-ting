// Persistence: sessions + settings in localStorage, file blobs in IndexedDB.

const LS_GLOBAL = "interview-ting.global.v1";
const LS_ACTIVE = "interview-ting.active.v1";

export const DEFAULT_PERSONA = `A master architect and veteran thesis-defense / licensure-board panelist with decades of practice and teaching in the Philippines and abroad. Rigorous, direct, and fair: probes design rationale, site and context, program, structure and materials, climate response and sustainability, cost and feasibility, codes and regulations, precedents, and research method. Grounds questions in Philippine realities (National Building Code PD 1096 and its IRR, RA 9266 Architecture Act, RA 9514 Fire Code, BP 344 accessibility, Green Building Code / BERDE, DHSUD and LGU zoning and CLUPs, typhoons, monsoon flooding, storm surge, heat and humidity, seismic hazard such as the West Valley Fault, local materials and vernacular like the bahay kubo and bahay na bato, informal settlements and urban density) and in international benchmarks (precedent projects, LEED / WELL / EDGE, UN SDGs, the New Urban Agenda, universal design, current research).`;

export function uid(prefix) {
  const a = new Uint8Array(8);
  crypto.getRandomValues(a);
  return `${prefix}_${Array.from(a, (b) => b.toString(36).padStart(2, "0")).join("").slice(0, 12)}`;
}

export function defaultGlobal() {
  return {
    apiKey: "",
    model: "claude-opus-5-5",
    effort: "high",
    mcpUrl: "",
    mcpToken: "",
    delivery: "auto", // auto | direct | mcp | both
    webSearch: false,
    speechLang: "en-US",
    seenWelcome: false,
  };
}

export function defaultSessionSettings() {
  return {
    timerMinutes: 10,
    timerSeconds: 0,
    micEnabled: true,
    persona: DEFAULT_PERSONA,
    context: "",
  };
}

export function newSession(n) {
  return {
    id: uid("s"),
    title: n ? `Interview ${n}` : "Interview 1",
    createdAt: Date.now(),
    settings: defaultSessionSettings(),
    fileIds: [],
    // Exact API conversation (append-only). File attachments are stored as
    // {type:"_files", fileIds:[…]} placeholders and expanded at request time.
    apiMessages: [],
    // What the chat UI shows.
    chat: [],
    system: null, // system prompt frozen on first send
    sentFileIds: [], // files already introduced to the interviewer
    lastSettingsNote: null,
    draft: "",
    complete: false,
    view: { activeFileId: null, pages: {} },
  };
}

function readJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (e) {
    console.warn("localStorage write failed", e);
    return false;
  }
}

export function loadGlobal() {
  return { ...defaultGlobal(), ...readJSON(LS_GLOBAL, {}) };
}
export function saveGlobal(g) {
  writeJSON(LS_GLOBAL, g);
}

export function loadActiveId() {
  return readJSON(LS_ACTIVE, null);
}
export function saveActiveId(id) {
  writeJSON(LS_ACTIVE, id);
}

// ---------- IndexedDB for files ----------

let dbPromise = null;
function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open("interview-ting", 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore("files", { keyPath: "id" });
        req.result.createObjectStore("kv");
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function tx(mode, fn, storeName = "files") {
  return db().then(
    (d) =>
      new Promise((resolve, reject) => {
        const t = d.transaction(storeName, mode);
        const store = t.objectStore(storeName);
        const out = fn(store);
        t.oncomplete = () => resolve(out && "result" in out ? out.result : undefined);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      })
  );
}

export const files = {
  put: (rec) => tx("readwrite", (s) => s.put(rec)),
  get: (id) => tx("readonly", (s) => s.get(id)),
  delete: (id) => tx("readwrite", (s) => s.delete(id)),
};

// Sessions live in IndexedDB too: conversations (including the interviewer's
// file reads) can outgrow localStorage's ~5 MB.
export async function loadSessions() {
  const list = await tx("readonly", (s) => s.get("sessions"), "kv");
  return Array.isArray(list)
    ? list.map((s) => ({ ...newSession(), ...s, settings: { ...defaultSessionSettings(), ...(s.settings || {}) } }))
    : [];
}
export function saveSessions(list) {
  // structuredClone strips anything non-serialisable and snapshots the state.
  return tx("readwrite", (s) => s.put(structuredClone(list), "sessions"), "kv");
}
