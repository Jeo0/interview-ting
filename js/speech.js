// Speech-to-text via the Web Speech API (Chrome, Edge, Safari).
// Keeps listening until stop() is called, restarting after the browser's
// automatic silence timeouts.

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;

export const speechSupported = Boolean(Recognition);

export class SpeechInput {
  constructor({ onFinal, onInterim, onState, onError }) {
    this.onFinal = onFinal;
    this.onInterim = onInterim || (() => {});
    this.onState = onState || (() => {});
    this.onError = onError || (() => {});
    this.wanted = false;
    this.listening = false;
    this.lang = "en-US";
    this.rec = null;
    this.restartTimer = null;
  }

  setLang(lang) {
    this.lang = lang || "en-US";
    if (this.rec) this.rec.lang = this.lang;
  }

  _create() {
    const rec = new Recognition();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = this.lang;
    rec.onstart = () => {
      this.listening = true;
      this.onState(true);
    };
    rec.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) this.onFinal(r[0].transcript.trim());
        else interim += r[0].transcript;
      }
      this.onInterim(interim.trim());
    };
    rec.onerror = (e) => {
      if (e.error === "no-speech" || e.error === "aborted") return;
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        this.wanted = false;
        this.onError("Microphone permission was denied. Allow microphone access for this site in your browser settings.");
      } else {
        this.onError(`Speech recognition error: ${e.error}`);
      }
    };
    rec.onend = () => {
      this.listening = false;
      this.onInterim("");
      if (this.wanted) {
        // Browser stopped on its own (silence / network); resume.
        clearTimeout(this.restartTimer);
        this.restartTimer = setTimeout(() => this.wanted && this._start(), 250);
      } else {
        this.onState(false);
      }
    };
    return rec;
  }

  _start() {
    try {
      this.rec = this._create();
      this.rec.start();
    } catch (e) {
      this.onError(`Could not start the microphone: ${e.message || e}`);
      this.wanted = false;
      this.onState(false);
    }
  }

  start() {
    if (!speechSupported) {
      this.onError("Speech-to-text isn't supported in this browser. Use Chrome, Edge or Safari.");
      return false;
    }
    if (this.wanted) return true;
    this.wanted = true;
    this.onState(true);
    this._start();
    return true;
  }

  stop() {
    this.wanted = false;
    clearTimeout(this.restartTimer);
    if (this.rec) {
      try {
        this.rec.stop();
      } catch {}
    }
    this.onInterim("");
    this.onState(false);
  }

  get active() {
    return this.wanted;
  }
}
