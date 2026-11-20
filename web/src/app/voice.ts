// Voice mode: browser speech recognition in, speech synthesis out. Audio is processed by
// the browser's own speech service; nothing is recorded or stored by the app.

type Rec = {
  lang: string; continuous: boolean; interimResults: boolean;
  start(): void; stop(): void; abort(): void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onend: (() => void) | null; onerror: ((e: { error: string }) => void) | null;
};

export function speechSupported(): boolean {
  const w = window as unknown as Record<string, unknown>;
  return !!(w.SpeechRecognition || w.webkitSpeechRecognition);
}

export class Voice {
  private rec: Rec | null = null;
  listening = false;

  /** Listen for one utterance. onPartial gets live text; resolves with the final text ("" if nothing). */
  listen(onPartial: (t: string) => void): Promise<string> {
    const w = window as unknown as Record<string, new () => Rec>;
    const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    if (!Ctor) return Promise.reject(new Error("Speech recognition isn't available in this browser (try Chrome or Edge)."));
    this.stopSpeaking();
    return new Promise((resolve, reject) => {
      const rec = new Ctor();
      rec.lang = navigator.language || "en-US";
      rec.continuous = false;
      rec.interimResults = true;
      let finalText = "", interim = "";
      rec.onresult = (e) => {
        interim = "";
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const r = e.results[i];
          if (r.isFinal) finalText += r[0].transcript; else interim += r[0].transcript;
        }
        onPartial((finalText + " " + interim).trim());
      };
      rec.onerror = (e) => {
        this.listening = false;
        if (e.error === "no-speech" || e.error === "aborted") resolve("");
        else reject(new Error(e.error === "not-allowed" ? "Microphone permission was denied." : `Voice error: ${e.error}`));
      };
      rec.onend = () => { this.listening = false; resolve((finalText || interim).trim()); };
      this.rec = rec;
      this.listening = true;
      rec.start();
    });
  }

  stop(): void { this.rec?.stop(); }
  abort(): void { this.rec?.abort(); this.listening = false; }

  speak(text: string): Promise<void> {
    if (!("speechSynthesis" in window) || !text) return Promise.resolve();
    return new Promise((resolve) => {
      const u = new SpeechSynthesisUtterance(text.replace(/[*_#`]|[\u{1F300}-\u{1FAFF}]/gu, ""));
      const voices = speechSynthesis.getVoices();
      u.voice = voices.find((v) => /en-US/.test(v.lang) && /Natural|Google|Samantha|Aria|Jenny/.test(v.name)) ?? voices.find((v) => v.lang.startsWith("en")) ?? null;
      u.rate = 1.05;
      u.onend = () => resolve();
      u.onerror = () => resolve();
      speechSynthesis.speak(u);
    });
  }

  stopSpeaking(): void { if ("speechSynthesis" in window) speechSynthesis.cancel(); }
}
