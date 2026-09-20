import { translateText, findVoiceForLang } from "./translate.js";
import { hasPiperVoice, synthesizeWithPiper, splitIntoSentences } from "./piperTts.js";
import { TRACE_MESSAGE, newTraceId, originOf, traceEvent } from "./trace.js";

console.log("[ReadAloud/bg] service worker starting");

const MENU_ID = "read-aloud-selection";
const OFFSCREEN_PATH = "offscreen.html";

// Only one offscreen document may exist per extension, and createDocument()
// throws if one already does - including when two calls race, since the
// service worker can handle messages concurrently. A single in-flight promise
// makes concurrent callers await the same creation instead of racing it.
let offscreenCreating = null;

async function hasOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)],
  });
  return contexts.length > 0;
}

async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) return;
  if (offscreenCreating) {
    await offscreenCreating;
    return;
  }
  offscreenCreating = chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ["AUDIO_PLAYBACK"],
    justification: "Plays locally synthesized Piper speech audio outside any web page, so a page's Content-Security-Policy cannot block it.",
  });
  try {
    await offscreenCreating;
  } catch (e) {
    // A parallel caller may have won the race; that's fine as long as one exists.
    if (!(await hasOffscreenDocument())) throw e;
  } finally {
    offscreenCreating = null;
  }
}

// ---------------------------------------------------------------------------
// Diagnostic trace store. The service worker is the SINGLE writer: popup,
// content script and offscreen document all emit events by message rather
// than writing storage themselves, so there is no read-modify-write race
// between four contexts appending to the same array.
const TRACE_KEY = "readAloudTraces";
const MAX_TRACES = 20;

// Writes are chained rather than fired in parallel - two events landing in the
// same tick would otherwise each read the old array and the second would
// clobber the first.
let traceWriteChain = Promise.resolve();

// storage.local, not sync: sync has an 8KB-per-item quota and already carries
// the user's settings. Each event is persisted as it arrives instead of being
// batched in memory, because the MV3 worker is idle-killed after ~30s and an
// in-memory buffer would be lost in the middle of a slow read - which is
// exactly the read worth tracing.
function recordTraceEvent(msg) {
  traceWriteChain = traceWriteChain
    .then(async () => {
      const stored = await chrome.storage.local.get({ [TRACE_KEY]: [] });
      const traces = Array.isArray(stored[TRACE_KEY]) ? stored[TRACE_KEY] : [];

      let trace = traces.find((t) => t.traceId === msg.traceId);
      if (!trace) {
        trace = {
          traceId: msg.traceId,
          startedAt: new Date(msg.tsWall || Date.now()).toISOString(),
          startedAtMs: msg.tsWall || Date.now(),
          events: [],
        };
        traces.push(trace);
        while (traces.length > MAX_TRACES) traces.shift(); // oldest out first
      }
      if (msg.meta) Object.assign(trace, msg.meta);

      // t is derived from the emitter's own clock reading, not from when this
      // write happens to run - the chain above can delay a write by an
      // arbitrary amount and that must not distort the timeline.
      const event = {
        t: Math.max(0, (msg.tsWall || Date.now()) - trace.startedAtMs),
        stage: msg.stage,
        ctx: msg.ctx,
        ok: msg.ok !== false,
      };
      if (msg.durationMs !== undefined) event.durationMs = Math.round(msg.durationMs);
      if (msg.error) event.error = msg.error;
      if (msg.data) event.data = msg.data;

      trace.events.push(event);
      trace.durationMs = event.t;
      await chrome.storage.local.set({ [TRACE_KEY]: traces });
    })
    .catch((e) => {
      // A failed trace write must never surface to the user or break a read.
      console.error("[ReadAloud/bg] trace write failed:", (e && e.message) || e);
    });
  return traceWriteChain;
}

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.type !== TRACE_MESSAGE) return;
  recordTraceEvent(msg);
  // Deliberately no sendResponse and no `return true`: emitters are
  // fire-and-forget, and holding the channel open would serve no one.
});

function sendToOffscreen(message) {
  return chrome.runtime.sendMessage({ ...message, target: "offscreen" });
}

// Bridges the popup to the offscreen audio player. The popup can't assume the
// offscreen document exists (the service worker may have been idle-killed and
// the document torn down with it), so every call goes through here.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg.type !== "string" || !msg.type.startsWith("PIPER_")) return;

  (async () => {
    try {
      if (msg.type === "PIPER_PLAY") {
        await ensureOffscreenDocument();
        const res = await sendToOffscreen({
          type: "PLAY",
          audioChunks: msg.audioChunks,
          rate: msg.rate,
          totalSentences: msg.totalSentences,
          traceId: msg.traceId,
        });
        sendResponse(res || { started: false });
        return;
      }
      // For everything below, no offscreen document means nothing is playing -
      // answer from that fact instead of spawning one just to ask.
      if (!(await hasOffscreenDocument())) {
        sendResponse(msg.type === "PIPER_STATE" ? { playing: false } : { ok: true, sentenceIndex: 0, totalSentences: 0 });
        return;
      }
      const map = { PIPER_STOP: "STOP", PIPER_STATE: "GET_STATE", PIPER_POSITION: "GET_POSITION", PIPER_RATE: "SET_RATE" };
      const res = await sendToOffscreen({ type: map[msg.type], rate: msg.rate, traceId: msg.traceId });
      sendResponse(res || {});
    } catch (e) {
      console.error("[ReadAloud/bg] offscreen bridge failed for", msg.type, ":", (e && e.message) || e);
      sendResponse({ error: String((e && e.message) || e), playing: false });
    }
  })();

  return true; // response is sent asynchronously
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: "Read Selected Text Aloud",
      contexts: ["selection"]
    });
  });
});

// Exported so it can be exercised directly: Chrome gives no way to synthesize
// a contextMenus.onClicked event, and re-importing this module returns the
// already-evaluated instance rather than re-registering anything.
export async function handleContextMenuRead(info, tab) {
  if (info.menuItemId !== MENU_ID || !tab?.id) return;

  // A right-click read is its own run with its own trace - it never goes
  // through the popup, so nothing else would have started one.
  const traceId = newTraceId();
  const selectionChars = (info.selectionText || "").length;
  traceEvent(traceId, "click", {
    ctx: "background",
    meta: { trigger: "context-menu", origin: originOf(tab.url) },
  });
  traceEvent(traceId, "selection", {
    ctx: "background",
    data: { chars: selectionChars },
  });

  // A right-click read replaces whatever is playing, including Piper audio -
  // which now lives in the offscreen document, not in the page, so the page's
  // own STOP can't reach it.
  if (await hasOffscreenDocument()) await sendToOffscreen({ type: "STOP" }).catch(() => {});

  const settings = await chrome.storage.sync.get({ rate: 1, voiceName: "", translateTarget: "" });
  let text = info.selectionText;
  let voiceName = settings.voiceName;

  if (settings.translateTarget) {
    let matchedVoice = null;
    let translated = false;
    const translateStartedAt = Date.now();
    traceEvent(traceId, "translate-start", {
      ctx: "background",
      data: { chars: selectionChars, targetLang: settings.translateTarget },
      meta: { targetLang: settings.translateTarget },
    });
    try {
      text = await translateText(info.selectionText, settings.translateTarget, traceId, "background");
      translated = true;
      traceEvent(traceId, "translate-result", {
        ctx: "background",
        durationMs: Date.now() - translateStartedAt,
        data: { chars: (text || "").length },
      });
      const voicesRes = await chrome.tabs.sendMessage(tab.id, { type: "GET_VOICES" }).catch(() => null);
      matchedVoice = findVoiceForLang(voicesRes?.voices, settings.translateTarget);
      if (matchedVoice) voiceName = matchedVoice;
    } catch (e) {
      console.error("[ReadAloud/bg] translation failed, reading the original:", (e && e.message) || e);
      traceEvent(traceId, "translate-result", {
        ctx: "background", ok: false, error: e,
        durationMs: Date.now() - translateStartedAt,
      });
      text = info.selectionText;
    }
    traceEvent(traceId, "voice-selection", {
      ctx: "background",
      data: { matchedVoice, engine: (!matchedVoice && hasPiperVoice(settings.translateTarget)) ? "piper" : "speechSynthesis" },
      meta: { engine: (translated && !matchedVoice && hasPiperVoice(settings.translateTarget)) ? "piper" : "speechSynthesis" },
    });

    // The same local-Piper fallback the popup uses. Without this the
    // right-click path translated to Urdu and then handed the Urdu text to an
    // English voice, which can't pronounce Arabic script - so it read a couple
    // of digits and went quiet. The README promises "Translate to" applies to
    // the right-click menu too, so it has to take this branch as well.
    if (translated && !matchedVoice && hasPiperVoice(settings.translateTarget)) {
      try {
        const audioChunks = await synthesizeWithPiper(text, 1, undefined, traceId, "background");
        await ensureOffscreenDocument();
        await sendToOffscreen({
          type: "PLAY",
          audioChunks,
          rate: settings.rate,
          totalSentences: splitIntoSentences(info.selectionText).length,
          traceId,
        });
      } catch (e) {
        // Deliberately silent rather than wrong: the context menu has no status
        // line, and reading Urdu with an English voice is worse than nothing.
        // The popup's own flow surfaces this properly.
        console.error("[ReadAloud/bg] Piper failed for the right-click read:", (e && e.message) || e);
        traceEvent(traceId, "piper-failed", { ctx: "background", ok: false, error: e, meta: { outcome: "error" } });
      }
      return;
    }
  }

  chrome.tabs.sendMessage(tab.id, {
    type: "SPEAK",
    text,
    rate: settings.rate,
    voiceName,
    traceId
  });
}

chrome.contextMenus.onClicked.addListener(handleContextMenuRead);

// Also hung on the worker global purely so this path can be exercised for
// real during testing: Chrome offers no way to synthesize a
// contextMenus.onClicked event, and dynamic import() is disallowed inside a
// service worker, so there is otherwise no way to run the right-click flow
// end to end. Only extension contexts (and a DevTools session the user has
// opened themselves) can reach it; it grants nothing to a web page.
self.__readAloudContextMenuRead = handleContextMenuRead;

console.log("[ReadAloud/bg] service worker ready - all listeners registered");
