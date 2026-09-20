// Plays Piper-synthesized audio chunks back-to-back, inside the extension's
// own origin (see offscreen.html for why this can't live in the page).
//
// Only responds to messages tagged { target: "offscreen" } - the popup and the
// service worker share the same runtime message bus, so untagged messages
// belong to them.

// Diagnostic tracing. Inlined rather than imported from trace.js so that
// offscreen.html can stay a classic script - Piper playback works today and
// switching it to a module script is risk this doesn't need. Fire-and-forget.
let currentTraceId = null;
function trace(stage, fields) {
  if (!currentTraceId) return;
  try {
    const sent = chrome.runtime.sendMessage({
      type: "TRACE_EVENT",
      traceId: currentTraceId,
      stage,
      ctx: "offscreen",
      ok: !fields || fields.ok !== false,
      error: fields && fields.error ? String(fields.error.message || fields.error).slice(0, 500) : undefined,
      durationMs: fields && fields.durationMs,
      data: fields && fields.data,
      meta: fields && fields.meta,
      tsWall: Date.now(),
    });
    if (sent && typeof sent.catch === "function") sent.catch(() => {});
  } catch (e) {
    // Document being torn down. Nothing to do.
  }
}

let audioEl = null;
let queue = [];
let queueIndex = 0;
let currentRate = 1;

// Sentence-level progress through the ORIGINAL (pre-translation) text, so a
// mid-read language switch can resume near the same place. Each chunk knows
// how many original sentences it covers.
let totalSentences = 0;
let sentencesCompleted = 0;

// Our own "a read is in progress" intent, which is true from the moment PLAY
// arrives - before the first <audio> has actually begun. Reporting only the
// element's live state would make the popup think nothing is playing during
// that gap and flip its button back to "Read Selection".
let isPlaying = false;

function stopPlayback() {
  if (audioEl) {
    audioEl.onended = null;
    audioEl.onerror = null;
    audioEl.pause();
    audioEl.src = "";
    audioEl = null;
  }
  queue = [];
  queueIndex = 0;
  isPlaying = false;
}

function playNextChunk() {
  if (queueIndex >= queue.length) {
    audioEl = null;
    isPlaying = false;
    trace("playback-ended", { meta: { outcome: "ended" } });
    chrome.runtime.sendMessage({ type: "TTS_STATE_CHANGED" }).catch(() => {});
    return;
  }
  const item = queue[queueIndex];
  const chunkNumber = queueIndex + 1;
  queueIndex += 1;

  // Constructing the Audio from the data: URL is where a page's
  // Content-Security-Policy used to kill this silently, back when playback
  // lived in the content script. Timing it keeps that visible.
  const decodeStartedAt = Date.now();
  audioEl = new Audio(item.dataUrl);
  audioEl.playbackRate = currentRate;
  const isFirstChunk = chunkNumber === 1;

  audioEl.onplaying = () => {
    if (isFirstChunk) trace("playback-started", { data: { chunk: chunkNumber }, meta: { outcome: "playing" } });
  };
  audioEl.onended = () => {
    sentencesCompleted += item.sentenceCount;
    playNextChunk();
  };
  audioEl.onerror = () => {
    const err = audioEl && audioEl.error;
    console.error("[ReadAloud/offscreen] playback error:", err);
    trace("audio-play-result", {
      ok: false,
      error: err ? `MediaError code ${err.code}: ${err.message || "(no message)"}` : "unknown media error",
      data: { chunk: chunkNumber },
      meta: { outcome: "error" },
    });
    // Count it anyway: leaving the counter behind would make a later language
    // switch resume from a point the listener already heard.
    sentencesCompleted += item.sentenceCount;
    playNextChunk();
  };

  trace("audio-play-call", { data: { chunk: chunkNumber, ofChunks: queue.length } });
  audioEl.play().then(
    () => trace("audio-play-result", { durationMs: Date.now() - decodeStartedAt, data: { chunk: chunkNumber } }),
    (e) => {
      console.error("[ReadAloud/offscreen] play() rejected:", (e && e.message) || e);
      trace("audio-play-result", {
        ok: false, error: e, durationMs: Date.now() - decodeStartedAt,
        data: { chunk: chunkNumber }, meta: { outcome: "error" },
      });
    }
  );
}

function startPlayback(audioChunks, rate, total, traceId) {
  stopPlayback();
  currentTraceId = traceId || currentTraceId;
  if (!audioChunks || !audioChunks.length) {
    trace("audio-decode", { ok: false, error: "no audio chunks supplied", meta: { outcome: "error" } });
    return false;
  }
  const decodeStartedAt = Date.now();
  currentRate = rate || 1;
  totalSentences = total || 0;
  sentencesCompleted = 0;
  queue = audioChunks.map((c) => ({
    dataUrl: `data:audio/wav;base64,${c.audioBase64}`,
    sentenceCount: c.sentenceCount || 0,
  }));
  queueIndex = 0;
  isPlaying = true;
  trace("audio-decode", {
    durationMs: Date.now() - decodeStartedAt,
    data: {
      chunks: queue.length,
      totalBase64Chars: audioChunks.reduce((n, c) => n + (c.audioBase64 || "").length, 0),
      totalSentences: total || 0,
    },
  });
  playNextChunk();
  return true;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== "offscreen") return;
  try {
    if (msg.type === "PLAY") {
      const started = startPlayback(msg.audioChunks, msg.rate, msg.totalSentences, msg.traceId);
      console.log("[ReadAloud/offscreen] PLAY", { chunks: (msg.audioChunks || []).length, started });
      sendResponse({ started });
      return true;
    }
    if (msg.type === "STOP") {
      if (isPlaying) trace("playback-stopped", { meta: { outcome: "stopped" } });
      stopPlayback();
      sendResponse({ ok: true });
      return true;
    }
    if (msg.type === "SET_RATE") {
      currentRate = msg.rate || 1;
      if (audioEl) audioEl.playbackRate = currentRate;
      sendResponse({ ok: true });
      return true;
    }
    if (msg.type === "GET_STATE") {
      sendResponse({ playing: isPlaying });
      return true;
    }
    if (msg.type === "GET_POSITION") {
      sendResponse({ sentenceIndex: sentencesCompleted, totalSentences });
      return true;
    }
  } catch (e) {
    console.error("[ReadAloud/offscreen] handler threw for", msg.type, ":", (e && e.stack) || e);
    sendResponse({ error: String((e && e.message) || e) });
    return true;
  }
});

console.log("[ReadAloud/offscreen] audio player ready");
