// Speech-to-text via the Web Speech API (Chrome, Edge, Safari).
//
// Keeps listening until stop() is called. Chrome ends recognition sessions on
// its own (silence, network, ~minute-long limits) and can also stall silently,
// so this wrapper:
//   - runs exactly one recognizer at a time and ignores events from old ones,
//   - waits for a stopping recognizer to finish before starting the next,
//   - restarts after the browser ends a session (with backoff on errors),
//   - recycles a recognizer that hears speech but returns no words, never
//     starts, or has run for a long time.

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;

export const speechSupported = Boolean(Recognition);

const DEFAULTS = {
  stallAfterSpeechMs: 8000, // heard speech but no words for this long → restart
  idleRecycleMs: 30000, // no events at all for this long → restart quietly
  startTimeoutMs: 5000, // start() never confirmed → restart
  maxSessionMs: 4 * 60 * 1000, // recycle long sessions at the next pause
  stopGraceMs: 1500, // how long a stopping recognizer may take before abort
  watchdogMs: 1000,
};

export class SpeechInput {
  constructor({ onFinal, onInterim, onState, onError, timing } = {}) {
    this.onFinal = onFinal;
    this.onInterim = onInterim || (() => {});
    this.onState = onState || (() => {});
    this.onError = onError || (() => {});
    this.t = { ...DEFAULTS, ...(timing || {}) };
    this.lang = "en-US";
    this.wanted = false;
    this.rec = null; // the one live recognizer (or the one still shutting down)
    this.closing = false; // this.rec has been asked to stop
    this.restartTimer = null;
    this.graceTimer = null;
    this.watchdog = null;
    this.failures = 0;
    this.resetClock();
  }

  resetClock() {
    const now = Date.now();
    this.launchedAt = now;
    this.startedAt = 0;
    this.lastEventAt = now;
    this.lastResultAt = now;
    this.speechAt = 0;
  }

  setLang(lang) {
    this.lang = lang || "en-US";
  }

  get active() {
    return this.wanted;
  }

  start() {
    if (!speechSupported) {
      this.onError("Speech-to-text isn't supported in this browser. Use Chrome, Edge or Safari.");
      return false;
    }
    if (this.wanted) return true;
    this.wanted = true;
    this.failures = 0;
    this.onState(true);
    this._launch();
    clearInterval(this.watchdog);
    this.watchdog = setInterval(() => this._check(), this.t.watchdogMs);
    return true;
  }

  stop() {
    this.wanted = false;
    clearTimeout(this.restartTimer);
    clearInterval(this.watchdog);
    this.watchdog = null;
    this._close(); // stop() delivers any final words still pending
    this.onInterim("");
    this.onState(false);
  }

  // Ask the current recognizer to stop; force it out if it doesn't end.
  _close() {
    const rec = this.rec;
    if (!rec || this.closing) return;
    this.closing = true;
    try {
      rec.stop();
    } catch {}
    clearTimeout(this.graceTimer);
    this.graceTimer = setTimeout(() => {
      if (this.rec !== rec) return;
      try {
        rec.abort();
      } catch {}
      this._ended(rec); // treat as ended even if the browser never says so
    }, this.t.stopGraceMs);
  }

  _launch() {
    clearTimeout(this.restartTimer);
    if (!this.wanted) return;
    if (this.rec) {
      // A previous recognizer is still shutting down; _ended() relaunches.
      this._close();
      return;
    }
    const rec = new Recognition();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = this.lang;
    const mine = () => rec === this.rec;
    const touch = () => (this.lastEventAt = Date.now());

    rec.onstart = () => {
      if (!mine()) return;
      touch();
      this.startedAt = Date.now();
    };
    rec.onaudiostart = rec.onsoundstart = () => mine() && touch();
    rec.onspeechstart = () => {
      if (!mine()) return;
      touch();
      if (!this.speechAt) this.speechAt = Date.now();
    };
    rec.onspeechend = () => {
      if (!mine()) return;
      touch();
      this.speechAt = 0;
    };
    rec.onresult = (e) => {
      if (!mine()) return;
      touch();
      this.lastResultAt = Date.now();
      this.speechAt = 0;
      this.failures = 0;
      let interim = "";
      let gotFinal = false;
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) {
          const text = r[0].transcript.trim();
          if (text) this.onFinal(text);
          gotFinal = true;
        } else {
          interim += r[0].transcript;
        }
      }
      this.onInterim(interim.trim());
      // Long sessions get unreliable in Chrome: recycle at a natural pause.
      if (gotFinal && !interim && Date.now() - this.startedAt > this.t.maxSessionMs) this._close();
    };
    rec.onerror = (e) => {
      if (!mine()) return;
      touch();
      if (e.error === "no-speech" || e.error === "aborted") return;
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        this.onError("Microphone permission was denied. Allow microphone access for this site in your browser settings.");
        this.stop();
        return;
      }
      this.failures += 1;
      if (e.error === "audio-capture") {
        this.onError("No microphone was found, or another app is using it.");
      } else if (this.failures >= 3) {
        this.onError(`Speech recognition keeps failing (${e.error}). Check your internet connection; it will keep retrying.`);
      }
    };
    rec.onend = () => this._ended(rec);

    this.rec = rec;
    this.closing = false;
    this.resetClock();
    try {
      rec.start();
    } catch (err) {
      // e.g. InvalidStateError: try again shortly
      this.rec = null;
      this.failures += 1;
      this._scheduleRestart();
    }
  }

  _ended(rec) {
    if (rec !== this.rec) return; // stale recognizer: ignore
    clearTimeout(this.graceTimer);
    this.rec = null;
    this.closing = false;
    this.onInterim("");
    if (this.wanted) this._scheduleRestart();
  }

  _scheduleRestart() {
    clearTimeout(this.restartTimer);
    const delay = Math.min(200 * 2 ** Math.min(this.failures, 5), 5000);
    this.restartTimer = setTimeout(() => this._launch(), delay);
  }

  _check() {
    if (!this.wanted || !this.rec || this.closing) return;
    const now = Date.now();
    const notStarted = !this.startedAt && now - this.launchedAt > this.t.startTimeoutMs;
    const heardNoWords = this.speechAt && now - this.speechAt > this.t.stallAfterSpeechMs && this.lastResultAt < this.speechAt;
    const idle = now - this.lastEventAt > this.t.idleRecycleMs;
    if (notStarted || heardNoWords || idle) this._close();
  }
}
