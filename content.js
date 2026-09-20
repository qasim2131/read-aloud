// Guard against being injected twice into the same page. popup.js injects
// this on demand when a tab has no content script yet (a tab that was open
// before the extension loaded); without this guard, landing in a page that
// already has it would throw on the top-level `let` re-declarations below
// and register a second message listener - which would answer every message
// twice and produce exactly the "message port closed" errors this whole
// setup is trying to avoid.
if (window.__readAloudContentLoaded) {
  console.log("[ReadAloud/content] already present in this page - skipping duplicate injection");
} else {
  window.__readAloudContentLoaded = true;

console.log("[ReadAloud/content] content script loaded/injected at", location.href, new Date().toISOString());

// Diagnostic tracing. This is a classic content script and genuinely cannot
// `import` trace.js, so the sender is inlined - see the plan note. Strictly
// fire-and-forget: instrumentation must never be able to break a read.
let currentTraceId = null;
function trace(stage, fields) {
  if (!currentTraceId) return;
  try {
    const sent = chrome.runtime.sendMessage({
      type: "TRACE_EVENT",
      traceId: currentTraceId,
      stage,
      ctx: "content",
      ok: !fields || fields.ok !== false,
      error: fields && fields.error ? String(fields.error).slice(0, 500) : undefined,
      data: fields && fields.data,
      meta: fields && fields.meta,
      tsWall: Date.now(),
    });
    if (sent && typeof sent.catch === "function") sent.catch(() => {});
  } catch (e) {
    // Extension context invalidated (reload mid-read). Nothing to do.
  }
}

function pickVoice(voiceName) {
  if (!voiceName) return null;
  return speechSynthesis.getVoices().find((v) => v.name === voiceName) || null;
}

let fullText = "";
let voiceNameInUse = "";
let spokenOffset = 0;
let utteranceCharIndex = 0;
let lastOriginalSelection = "";

// Sentence-level playback position, for GET_PLAYBACK_POSITION (used when the
// user switches "Translate to" mid-read so the new language can resume near
// the same point instead of restarting from the beginning). 0 whenever the
// current read isn't a translated one - popup.js only sets totalSentences
// for translated reads.
let totalSentencesForRead = 0;

// Our own record of "a read is in progress", as opposed to
// speechSynthesis.speaking, which is the engine's state and lags our command.
// Measured on this machine: after speak() returns, speechSynthesis.speaking is
// still false at +2ms and only turns true around +370ms (50ms of the timer
// below plus engine start-up). popup.js asks for GET_STATE immediately after
// SPEAK, landed squarely in that gap, and concluded nothing was playing - so
// the button never became "Stop Reading", Stop started a second read instead
// of stopping, and the mid-read language switch (which is gated on that same
// button state) never fired at all. Reporting intent fixes all three.
let isReadActive = false;

// Bumped on every new read and on STOP. An utterance's callbacks carry the
// generation they were created in and do nothing once it's stale - otherwise
// the onend that speechSynthesis.cancel() fires for the OLD utterance would
// immediately clear isReadActive for the NEW one (setRate cancels and restarts
// mid-read, so this is a normal path, not an edge case).
let readGeneration = 0;

// Handle for the deferred speechSynthesis.speak() below, so a STOP can cancel
// an utterance that hasn't been handed to the engine yet.
let pendingSpeakTimer = null;

function startUtterance(text, rate, voiceName) {
  readGeneration += 1;
  const generation = readGeneration;
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = rate || 1;
  const voice = pickVoice(voiceName);
  if (voice) utterance.voice = voice;
  console.log("[ReadAloud/content] queuing utterance", {
    voiceRequested: voiceName,
    voiceResolved: voice?.name || "(browser default)",
    lang: voice?.lang,
    textLength: text.length,
  });
  utterance.onstart = () => {
    console.log("[ReadAloud/content] utterance actually started playing");
    if (generation !== readGeneration) return;
    trace("playback-started", { data: { chars: text.length }, meta: { outcome: "playing" } });
  };
  utterance.onerror = (event) => {
    console.error("[ReadAloud/content] utterance error:", event.error);
    if (generation !== readGeneration) return;
    trace("playback-error", { ok: false, error: event.error, meta: { outcome: "error" } });
    isReadActive = false;
    chrome.runtime.sendMessage({ type: "TTS_STATE_CHANGED" }).catch(() => {});
  };
  utterance.onboundary = (event) => {
    utteranceCharIndex = event.charIndex;
  };
  utterance.onend = () => {
    if (generation !== readGeneration) return;
    trace("playback-ended", { meta: { outcome: "ended" } });
    isReadActive = false;
    chrome.runtime.sendMessage({ type: "TTS_STATE_CHANGED" }).catch(() => {});
  };
  // Chrome's speech engine needs a beat after cancel() before a new speak()
  // reliably takes effect - calling them back-to-back can silently drop the
  // new utterance (a known Chrome bug), which looked like "reads the wrong
  // text" or "doesn't read at all" depending on timing.
  //
  // The generation check inside matters: a STOP arriving during those 50ms
  // would call speechSynthesis.cancel() BEFORE this speak() ever runs, so the
  // utterance would start playing anyway - audible speech that Stop can no
  // longer reach, with the button already back on "Read Selection".
  clearTimeout(pendingSpeakTimer);
  pendingSpeakTimer = setTimeout(() => {
    if (generation !== readGeneration) return;
    speechSynthesis.speak(utterance);
  }, 50);
}

function speak(text, rate, voiceName, totalSentences) {
  const toSpeak = (text && text.trim()) || window.getSelection().toString();
  if (!toSpeak.trim()) return "empty";

  // Track the page selection this utterance answers, even for a manual/
  // translated read - otherwise autoSpeak() below has no way to know a
  // manual read is already covering the current selection, and if the popup
  // re-opens mid-read it restarts speech from scratch (in the original
  // language, at the default rate), cutting off whatever was already
  // playing after only a few words.
  lastOriginalSelection = window.getSelection().toString();

  speechSynthesis.cancel();
  fullText = toSpeak;
  voiceNameInUse = voiceName;
  spokenOffset = 0;
  utteranceCharIndex = 0;
  totalSentencesForRead = totalSentences || 0;
  isReadActive = true;
  startUtterance(fullText, rate, voiceName);
  return "started";
}

function autoSpeak(rate, voiceName, text) {
  const selection = window.getSelection().toString();
  if (!selection.trim()) return "empty";
  // isReadActive, not just speechSynthesis.speaking: reopening the popup
  // inside the engine's ~370ms start-up window would otherwise look like
  // "nothing is playing" and restart the same selection from the top.
  console.log("[ReadAloud/content] autoSpeak check", {
    speaking: speechSynthesis.speaking,
    isReadActive,
    selectionMatchesLast: selection.trim() === lastOriginalSelection.trim(),
  });
  if ((speechSynthesis.speaking || isReadActive) && selection.trim() === lastOriginalSelection.trim()) {
    return "unchanged";
  }
  lastOriginalSelection = selection;
  return speak(text || selection, rate, voiceName);
}

function setRate(rate) {
  // isReadActive again: nudging the speed slider right after clicking Read
  // lands in the engine's start-up window, where speechSynthesis.speaking is
  // still false. Treating that as "nothing to do" silently dropped the change
  // for the whole read. When the utterance is still pending, utteranceCharIndex
  // is 0, so the restart below simply re-queues it at the new speed.
  if (!fullText || (!speechSynthesis.speaking && !isReadActive)) return false;
  spokenOffset += utteranceCharIndex;
  const remaining = fullText.slice(spokenOffset);
  utteranceCharIndex = 0;
  speechSynthesis.cancel();
  if (!remaining.trim()) return true;
  startUtterance(remaining, rate, voiceNameInUse);
  return true;
}

function getVoicesAsync() {
  return new Promise((resolve) => {
    const existing = speechSynthesis.getVoices();
    if (existing.length) return resolve(existing);
    speechSynthesis.onvoiceschanged = () => resolve(speechSynthesis.getVoices());
    setTimeout(() => resolve(speechSynthesis.getVoices()), 500);
  });
}

function safeRespond(sendResponse, value) {
  try {
    sendResponse(value);
  } catch (e) {
    // Happens if the sender (popup) already gave up/closed - nothing to do.
    console.error("[ReadAloud/content] sendResponse() threw (port already closed):", e && (e.stack || e.message || e));
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  console.log("[ReadAloud/content] received", msg.type, msg);
  try {
    if (msg.type === "SPEAK") {
      if (msg.traceId) currentTraceId = msg.traceId;
      const result = speak(msg.text, msg.rate, msg.voiceName, msg.totalSentences);
      trace("speak-received", {
        data: {
          chars: fullText.length,
          suppliedByPopup: typeof msg.text === "string",
          voiceRequested: msg.voiceName || null,
          voiceResolved: pickVoice(msg.voiceName)?.name || "(browser default)",
          voiceLang: pickVoice(msg.voiceName)?.lang || null,
          rate: msg.rate,
          result,
        },
      });
      console.log("[ReadAloud/content] SPEAK result:", result, "textLength:", (msg.text || "").length);
      safeRespond(sendResponse, { spoke: result !== "empty" });
      return true;
    }
    if (msg.type === "GET_PLAYBACK_POSITION") {
      let sentenceIndex = 0;
      if (speechSynthesis.speaking && totalSentencesForRead > 0 && fullText.length > 0) {
        // Approximate: speechSynthesis only reports character position, not
        // sentence position, so this maps proportionally through the
        // translated text's length onto the original sentence count. Good
        // enough to "resume roughly here", not an exact word-level position.
        //
        // spokenOffset matters: a rate change mid-read cancels the utterance
        // and restarts it with only the REMAINING text, which resets
        // utteranceCharIndex to 0. Measuring from that alone would report the
        // read as back near the beginning, so a language switch after a speed
        // change would replay text the user already heard.
        const charsSpoken = spokenOffset + utteranceCharIndex;
        sentenceIndex = Math.floor((charsSpoken / fullText.length) * totalSentencesForRead);
      }
      safeRespond(sendResponse, { sentenceIndex, totalSentences: totalSentencesForRead });
      return true;
    }
    if (msg.type === "AUTO_SPEAK") {
      if (msg.traceId) currentTraceId = msg.traceId;
      const result = autoSpeak(msg.rate, msg.voiceName, msg.text);
      safeRespond(sendResponse, { spoke: result !== "empty", restarted: result === "started" });
      return true;
    }
    if (msg.type === "STOP") {
      if (isReadActive || speechSynthesis.speaking) {
        trace("playback-stopped", { meta: { outcome: "stopped" } });
      }
      readGeneration += 1;
      isReadActive = false;
      clearTimeout(pendingSpeakTimer);
      speechSynthesis.cancel();
      totalSentencesForRead = 0;
      safeRespond(sendResponse, { ok: true });
      return true;
    }
    if (msg.type === "SET_RATE") {
      setRate(msg.rate);
      safeRespond(sendResponse, { ok: true });
      return true;
    }
    if (msg.type === "GET_STATE") {
      safeRespond(sendResponse, { speaking: speechSynthesis.speaking || isReadActive });
      return true;
    }
    if (msg.type === "PING") {
      let selectionLength = -1;
      let selErr = null;
      try {
        selectionLength = window.getSelection().toString().length;
      } catch (e) {
        selErr = String((e && e.message) || e);
      }
      safeRespond(sendResponse, { pong: true, selectionLength, selErr });
      return true;
    }
    if (msg.type === "GET_SELECTION_TEXT") {
      const text = window.getSelection().toString();
      console.log("[ReadAloud/content] GET_SELECTION_TEXT ->", JSON.stringify(text).slice(0, 200));
      safeRespond(sendResponse, { text });
      return true;
    }
    if (msg.type === "GET_VOICES") {
      getVoicesAsync()
        .then((voices) => {
          safeRespond(sendResponse, { voices: voices.map((v) => ({ name: v.name, lang: v.lang })) });
        })
        .catch((e) => {
          console.error("[ReadAloud/content] GET_VOICES failed:", e && (e.stack || e.message || e));
          safeRespond(sendResponse, { voices: [] });
        });
      return true;
    }
  } catch (e) {
    console.error("[ReadAloud/content] listener threw handling", msg.type, ":", e && (e.stack || e.message || e));
    safeRespond(sendResponse, { error: String((e && e.message) || e) });
    return true;
  }
});

} // end duplicate-injection guard
