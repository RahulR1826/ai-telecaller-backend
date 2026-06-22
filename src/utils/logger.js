// ─────────────────────────────────────────────────────────────────────────────
// utils/logger.js — Structured, tagged logger for AI Telecaller pipeline
// Tags: [CALL] [STT] [LLM] [TTS] [PLAYBACK] [QUEUE] [STATUS] [WS] [DB] [HTTP]
// ─────────────────────────────────────────────────────────────────────────────

const iso = () => new Date().toISOString();

const fmt = (tag, ...args) => {
  const parts = args.map((a) =>
    typeof a === "object" && a !== null ? JSON.stringify(a) : String(a)
  );
  return `${iso()} ${tag} ${parts.join(" ")}`;
};

export const log = {
  call:   (...a) => console.log(fmt("[CALL]",   ...a)),
  stt:    (...a) => console.log(fmt("[STT]",    ...a)),
  llm:    (...a) => console.log(fmt("[LLM]",    ...a)),
  tts:    (...a) => console.log(fmt("[TTS]",    ...a)),
  play:   (...a) => console.log(fmt("[PLAYBACK]",...a)),
  queue:  (...a) => console.log(fmt("[QUEUE]",  ...a)),
  status: (...a) => console.log(fmt("[STATUS]", ...a)),
  ws:     (...a) => console.log(fmt("[WS]",     ...a)),
  db:     (...a) => console.log(fmt("[DB]",     ...a)),
  http:   (...a) => console.log(fmt("[HTTP]",   ...a)),
  warn:   (...a) => console.warn(fmt("[WARN]",  ...a)),
  error:  (...a) => console.error(fmt("[ERROR]",...a)),
};

/** Returns elapsed milliseconds since startMs = Date.now() */
export const elapsed = (startMs) => `${Date.now() - startMs}ms`;
