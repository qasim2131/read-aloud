import { translateText, findVoiceForLang } from "./translate.js";
import { hasPiperVoice, checkPiperHostAvailable, synthesizeWithPiper, splitIntoSentences } from "./piperTts.js";
import { newTraceId, originOf, traceEvent } from "./trace.js";

const rateInput = document.getElementById("rate");
const rateLabel = document.getElementById("rateLabel");
const voiceSelect = document.getElementById("voice"); // hidden; real source of truth, unchanged by anything below
const voiceCombo = document.getElementById("voiceCombo");
const voiceTrigger = document.getElementById("voiceTrigger");
const voiceTriggerLabel = document.getElementById("voiceTriggerLabel");
const voicePanel = document.getElementById("voicePanel");
const voiceSearch = document.getElementById("voiceSearch");
const voiceList = document.getElementById("voiceList");
const translateTargetSelect = document.getElementById("translateTarget");
const voiceHintEl = document.getElementById("voiceHint");
const piperDownloadHintEl = document.getElementById("piperDownloadHint");
const downloadUrduVoiceBtn = document.getElementById("downloadUrduVoiceBtn");

downloadUrduVoiceBtn.addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("install-urdu-voice.html") });
});
const readBtn = document.getElementById("readBtn");
const statusEl = document.getElementById("status");
let availableVoices = [];

// Bumped on every call so a slow PING from a stale call (e.g. the user
// flipped the dropdown again before the previous check returned) can't
// overwrite a newer selection's hint.
let voiceHintToken = 0;

async function updateVoiceHint() {
  const target = translateTargetSelect.value;
  const token = ++voiceHintToken;
  piperDownloadHintEl.hidden = true;

  if (!target) {
    voiceHintEl.textContent = "";
    return;
  }
  const matched = findVoiceForLang(availableVoices, target);
  if (matched) {
    voiceHintEl.textContent = `Will read using: ${matched}`;
    return;
  }
  if (!hasPiperVoice(target)) {
    // Every other language keeps its existing, unchanged behaviour - the
    // download hint only ever applies to a language Piper actually covers.
    voiceHintEl.textContent = "No voice for this language is installed on your device - it'll read with your default voice/accent instead.";
    return;
  }
  voiceHintEl.textContent = "Checking your local Piper voice...";
  const available = await checkPiperHostAvailable();
  if (token !== voiceHintToken) return; // superseded by a newer selection
  if (available) {
    voiceHintEl.textContent = "No local system voice installed - will use your local Piper voice instead.";
  } else {
    voiceHintEl.textContent = "";
    piperDownloadHintEl.hidden = false;
  }
}

function setStatus(text, isError) {
  statusEl.textContent = text || "";
  statusEl.style.color = isError ? "#dc2626" : "#6b7280";
}

function getActiveTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => resolve(tabs[0]));
  });
}

async function sendToActiveTab(message, isRetry) {
  const tab = await getActiveTab();
  console.log("[ReadAloud/popup] ->", message.type, "tabId:", tab?.id, "url:", tab?.url, message, isRetry ? "(retry)" : "");
  if (!tab?.id) {
    console.error("[ReadAloud/popup] no active tab for", message.type);
    return { error: "No active tab" };
  }
  const result = await new Promise((resolve) => {
    chrome.tabs.sendMessage(tab.id, message, (response) => {
      if (chrome.runtime.lastError) {
        console.error("[ReadAloud/popup] <-", message.type, "chrome.runtime.lastError:", chrome.runtime.lastError.message, "| tab.url:", tab.url);
        resolve({ error: chrome.runtime.lastError.message, tabUrl: tab.url });
      } else {
        console.log("[ReadAloud/popup] <-", message.type, "response:", response);
        resolve(response || {});
      }
    });
  });

  // Chrome's messaging port occasionally reports "closed before a response was
  // received" as a one-off transient hiccup (most often right after the
  // extension or page was reloaded). One silent retry clears that without
  // masking a real, repeatable failure - a second failure still surfaces.
  const isPortClosed = typeof result?.error === "string" && result.error.includes("message port closed");
  if (isPortClosed && !isRetry) {
    console.warn("[ReadAloud/popup] retrying", message.type, "once after port-closed error");
    return sendToActiveTab(message, true);
  }

  // No content script in this tab. This is what happens on any tab that was
  // already open before the extension was (re)loaded - Chrome only injects
  // declared content scripts when a page *loads*. Rather than making every
  // feature fail until the tab is manually refreshed (which is what caused
  // "normal read not working", an empty Voice dropdown, and translation
  // failures all at once), inject it on demand and retry.
  const hasNoReceiver =
    typeof result?.error === "string" &&
    (result.error.includes("Receiving end does not exist") ||
      result.error.includes("Could not establish connection"));
  if (hasNoReceiver && !isRetry) {
    console.warn("[ReadAloud/popup] no content script in tab", tab.id, "- injecting it now");
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
      console.log("[ReadAloud/popup] content.js injected, retrying", message.type);
      traceEvent(currentTraceId, "content-script-injected", {
        data: { forMessage: message.type },
      });
      return sendToActiveTab(message, true);
    } catch (e) {
      console.error("[ReadAloud/popup] could not inject content.js:", e?.message || e);
      return {
        error: `${result.error} (and couldn't inject into this page: ${e?.message || e})`,
        tabUrl: tab.url,
      };
    }
  }
  return result;
}

const ERROR_MESSAGE = "Could not reach the page - refresh it, then reopen this popup.";

async function sendAction(message) {
  const res = await sendToActiveTab(message);
  if (res?.error) {
    setStatus(ERROR_MESSAGE, true);
    applyControlState(null);
    return null;
  }
  return res;
}

// Piper audio plays in the extension's offscreen document, not in the page
// (see offscreen.html), so it's reached through the service worker rather than
// through the content script. Never throws: if the worker is mid-restart the
// caller just gets an empty object and treats it as "nothing playing".
async function sendToPiperPlayer(message) {
  try {
    return (await chrome.runtime.sendMessage(message)) || {};
  } catch (e) {
    console.warn("[ReadAloud/popup] piper player unreachable for", message.type, ":", e?.message || e);
    return {};
  }
}

function applyControlState(state) {
  const speaking = !!state?.speaking;
  readBtn.textContent = speaking ? "Stop Reading" : "Read Selection";
  readBtn.classList.toggle("is-stop", speaking);
}

function stateLabel(state) {
  return state?.speaking ? "Speaking..." : "Idle";
}

// Speech can be coming from either place at once - the page (speechSynthesis)
// or the offscreen document (Piper audio) - so "is it speaking?" is the union
// of the two. Deliberately does NOT go through sendAction(): while Piper audio
// is playing, an unreachable page is not an error worth wiping the UI for.
async function getCurrentState() {
  const [pageState, piperState] = await Promise.all([
    sendToActiveTab({ type: "GET_STATE" }),
    sendToPiperPlayer({ type: "PIPER_STATE" }),
  ]);
  if (pageState?.error && !piperState?.playing) {
    setStatus(ERROR_MESSAGE, true);
    applyControlState(null);
    return null;
  }
  return { speaking: !!pageState?.speaking || !!piperState?.playing };
}

// Stops both sources. Returns the page's response so callers can still tell
// an unreachable page apart from a successful stop.
async function stopEverything() {
  const [pageRes] = await Promise.all([
    sendAction({ type: "STOP" }),
    sendToPiperPlayer({ type: "PIPER_STOP" }),
  ]);
  return pageRes;
}

async function refreshState() {
  const state = await getCurrentState();
  if (!state) return null;
  applyControlState(state);
  setStatus(stateLabel(state), false);
  return state;
}

async function loadSettings() {
  const settings = await new Promise((resolve) =>
    chrome.storage.sync.get({ rate: 1, voiceName: "", translateTarget: "" }, resolve)
  );
  rateInput.value = settings.rate;
  rateLabel.textContent = `${Number(settings.rate).toFixed(1)}x`;
  translateTargetSelect.value = settings.translateTarget;
  return settings;
}

// Voice dropdown display only - UI/labeling/search/sort. None of this
// changes what a voice IS: option.value stays the exact v.name every other
// part of the extension already keys off (pickVoice() in content.js matches
// by that exact string), so SPEAK/AUTO_SPEAK, translation, and Piper are
// completely unaffected by anything below.

// Apple's own long-standing "novelty"/sound-effect voices (chiming, robotic,
// musical-instrument, whispering, etc.) - not useful for reading text aloud.
// Matched by bare name (see voiceBareName), so a normal per-language voice
// that happens to share a common first name is never caught by this list -
// none of these exact names are used for anything but the effect voice.
const NOVELTY_VOICE_NAMES = new Set([
  "Albert", "Bad News", "Bahh", "Bells", "Boing", "Bubbles", "Cellos",
  "Deranged", "Good News", "Hysterical", "Jester", "Junior", "Organ",
  "Pipe Organ", "Princess", "Superstar", "Trinoids", "Whisper", "Wobble",
  "Zarvox",
]);

// Chrome reports some multi-language system voices with the locale baked
// into the name itself, e.g. "Eddy (Chinese (China mainland))" - strip that
// back to the plain character name ("Eddy") so it displays once per
// language as "Country (Language) · Eddy" instead of repeating the locale
// twice. Voices with no such suffix (e.g. "Samantha") pass through as-is.
function voiceBareName(name) {
  return name.replace(/\s*\(.*/, "").trim();
}

// "Country (Language)" using the voice's OWN locale code - never a guessed
// country. Intl.DisplayNames is a built-in Chrome API (needs no library)
// that turns e.g. "ko-KR" into "South Korea"/"Korean". Falls back to just
// "Language" for a voice with no region subtag, and to the bare name alone
// if the locale can't be resolved at all - always favors an honest,
// less-specific label over a wrong guess.
//
// `full` keeps the old "Country (Language) · Voice name" form too - not
// shown, only used for sorting (so same-country-language voices land next
// to each other) and for search, so searching by voice name still works
// even for a voice whose name isn't shown in the visible label.
let languageNames, regionNames;
function voiceLabelParts(v) {
  const name = voiceBareName(v.name);
  const [langCode, regionCode] = (v.lang || "").split("-");
  languageNames ??= new Intl.DisplayNames(["en"], { type: "language" });
  regionNames ??= new Intl.DisplayNames(["en"], { type: "region" });
  let language = null, country = null;
  try { language = langCode ? languageNames.of(langCode) : null; } catch {}
  try { country = regionCode ? regionNames.of(regionCode) : null; } catch {}
  if (country) country = country.replace(/^world$/i, "World"); // ar-001 etc.
  const primary = country && language ? `${country} (${language})` : (language || name);
  const full = country && language ? `${country} (${language}) · ${name}`
    : language ? `${language} · ${name}`
    : name;
  return { primary, name, full };
}

// DEFAULT_VOICE_LABEL is what the trigger button and the list's first row
// show for "no specific voice" - kept as one constant so the button label,
// the <option>, and the <li> can never drift out of sync with each other.
const DEFAULT_VOICE_LABEL = "Default voice";
let voiceEntries = []; // [{value, label}], in on-screen order, incl. Default
let activeVoiceIndex = -1; // keyboard-highlighted row while the panel is open

async function populateVoices(selectedVoiceName) {
  const response = await sendAction({ type: "GET_VOICES" });
  availableVoices = response?.voices || [];

  // The real <select id="voice"> stays in the DOM (display:none, see
  // popup.html) as the actual source of truth: every other read of
  // voiceSelect.value elsewhere in this file, and pickVoice() in content.js
  // matching by that exact string, is completely unaffected by anything
  // below - only how the user PICKS a value changes, never the value itself.
  voiceSelect.innerHTML = "";
  const defaultOption = document.createElement("option");
  defaultOption.value = "";
  defaultOption.textContent = DEFAULT_VOICE_LABEL;
  voiceSelect.appendChild(defaultOption);

  const labeled = availableVoices
    .filter((v) => !NOVELTY_VOICE_NAMES.has(voiceBareName(v.name)))
    .map((v) => ({ voice: v, ...voiceLabelParts(v) }))
    .sort((a, b) => a.full.localeCompare(b.full));

  // A voice's name is only shown at all when it's actually needed to tell
  // voices apart - i.e. when more than one voice shares the same
  // "Country (Language)" label. Everyone else just shows the country/language.
  const primaryCounts = new Map();
  for (const l of labeled) primaryCounts.set(l.primary, (primaryCounts.get(l.primary) || 0) + 1);
  for (const l of labeled) {
    l.secondary = primaryCounts.get(l.primary) > 1 ? l.name : null;
    l.display = l.secondary ? `${l.primary} · ${l.secondary}` : l.primary;
  }

  for (const { voice, display } of labeled) {
    const opt = document.createElement("option");
    opt.value = voice.name; // unchanged: the exact name pickVoice() matches on
    opt.textContent = display;
    voiceSelect.appendChild(opt);
  }
  voiceSelect.value = selectedVoiceName || "";

  voiceEntries = [
    { value: "", primary: DEFAULT_VOICE_LABEL, secondary: null, display: DEFAULT_VOICE_LABEL, full: DEFAULT_VOICE_LABEL },
    ...labeled.map((l) => ({ value: l.voice.name, primary: l.primary, secondary: l.secondary, display: l.display, full: l.full })),
  ];
  renderVoiceList(voiceEntries);
  updateVoiceTriggerLabel();
  updateVoiceHint();
}

function updateVoiceTriggerLabel() {
  const current = voiceEntries.find((e) => e.value === voiceSelect.value);
  voiceTriggerLabel.textContent = current ? current.display : DEFAULT_VOICE_LABEL;
}

function renderVoiceList(entries) {
  voiceList.innerHTML = "";
  if (!entries.length) {
    const empty = document.createElement("li");
    empty.className = "combo-empty";
    empty.textContent = "No voices match your search.";
    voiceList.appendChild(empty);
    activeVoiceIndex = -1;
    return;
  }
  entries.forEach((entry, i) => {
    const li = document.createElement("li");
    li.className = "combo-item";
    li.setAttribute("role", "option");
    li.dataset.value = entry.value;
    const primarySpan = document.createElement("span");
    primarySpan.className = "combo-item-primary";
    primarySpan.textContent = entry.primary;
    li.appendChild(primarySpan);
    if (entry.secondary) {
      const secondarySpan = document.createElement("span");
      secondarySpan.className = "combo-item-secondary";
      secondarySpan.textContent = ` · ${entry.secondary}`;
      li.appendChild(secondarySpan);
    }
    if (entry.value === voiceSelect.value) li.classList.add("is-selected");
    voiceList.appendChild(li);
  });
  activeVoiceIndex = -1;
}

function selectVoiceEntry(value) {
  voiceSelect.value = value;
  voiceSelect.dispatchEvent(new Event("change")); // existing listener below saves it, unchanged
  updateVoiceTriggerLabel();
  closeVoicePanel();
}

// Takes up zero space while closed (the [hidden] attribute), so there is no
// permanent blank gap in the popup - and sizes itself from the popup's real,
// live window.innerHeight each time it opens, rather than a fixed reserved
// height, so it uses whatever room genuinely exists without guessing.
function positionVoicePanel() {
  const top = Math.round(voiceTrigger.getBoundingClientRect().bottom) + 4;
  voicePanel.style.top = `${top}px`;
  voicePanel.style.maxHeight = `${Math.max(120, window.innerHeight - top - 8)}px`;
}

function openVoicePanel() {
  voicePanel.hidden = false;
  voiceTrigger.setAttribute("aria-expanded", "true");
  voiceSearch.value = "";
  renderVoiceList(voiceEntries);
  positionVoicePanel();
  voiceSearch.focus();
}

function closeVoicePanel() {
  voicePanel.hidden = true;
  voiceTrigger.setAttribute("aria-expanded", "false");
}

voiceTrigger.addEventListener("click", () => {
  if (voicePanel.hidden) openVoicePanel();
  else closeVoicePanel();
});

// Filters by substring match against each entry's own visible label - which
// already reads "Country (Language) · Voice name", so one check covers all
// three ways the search box promises to search by. Default voice is
// deliberately excluded from being filtered away by a search term: it isn't
// a language choice, and staying visible keeps it reachable as a safe
// fallback no matter what the user typed.
voiceSearch.addEventListener("input", () => {
  const term = voiceSearch.value.trim().toLowerCase();
  const filtered = term
    ? voiceEntries.filter((e) => e.value === "" || e.full.toLowerCase().includes(term))
    : voiceEntries;
  renderVoiceList(filtered);
});

voiceList.addEventListener("click", (e) => {
  const li = e.target.closest(".combo-item[data-value]");
  if (li) selectVoiceEntry(li.dataset.value);
});

// Minimal keyboard support: type to filter (above), arrows to move the
// highlight, Enter to pick the highlighted row, Escape to close - covers the
// common combobox expectations without a full ARIA roving-tabindex setup.
voiceSearch.addEventListener("keydown", (e) => {
  const items = Array.from(voiceList.querySelectorAll(".combo-item[data-value]"));
  if (e.key === "Escape") {
    closeVoicePanel();
    voiceTrigger.focus();
  } else if (e.key === "ArrowDown" && items.length) {
    e.preventDefault();
    activeVoiceIndex = Math.min(activeVoiceIndex + 1, items.length - 1);
  } else if (e.key === "ArrowUp" && items.length) {
    e.preventDefault();
    activeVoiceIndex = Math.max(activeVoiceIndex - 1, 0);
  } else if (e.key === "Enter" && items.length) {
    e.preventDefault();
    const target = items[activeVoiceIndex] || items[0];
    selectVoiceEntry(target.dataset.value);
    return;
  } else {
    return;
  }
  items.forEach((li, i) => li.classList.toggle("is-active", i === activeVoiceIndex));
  items[activeVoiceIndex]?.scrollIntoView({ block: "nearest" });
});

document.addEventListener("click", (e) => {
  if (!voicePanel.hidden && !voiceCombo.contains(e.target)) closeVoicePanel();
});


let rateDebounceTimer = null;
rateInput.addEventListener("input", () => {
  const rate = Number(rateInput.value);
  rateLabel.textContent = `${rate.toFixed(1)}x`;
  chrome.storage.sync.set({ rate });
  clearTimeout(rateDebounceTimer);
  rateDebounceTimer = setTimeout(() => {
    sendAction({ type: "SET_RATE", rate });
    sendToPiperPlayer({ type: "PIPER_RATE", rate });
  }, 250);
});

voiceSelect.addEventListener("change", () => {
  chrome.storage.sync.set({ voiceName: voiceSelect.value });
});

let isProcessingRead = false;
let currentAbortController = null;
// Id of the run currently being traced. Read by sendToActiveTab() so the
// self-healing injection can be attributed to the run that triggered it.
let currentTraceId = null;
// Sentences of the CURRENTLY active translated read, in the original
// (pre-translation) language - kept so a live language switch mid-read can
// figure out roughly how much is left and re-translate just that remainder,
// instead of restarting the whole selection from the beginning. Null
// whenever nothing is reading, or the current read is untranslated (Off).
let currentReadOriginalSentences = null;

// Handles everything from "have original text + a target language" through
// translating, picking a voice (or falling back to Piper), and speaking -
// shared by a fresh Read Selection click and by a live language switch
// mid-read, so both go through identical logic instead of two copies of it.
async function runTranslatedRead(originalText, targetLang, rate, abortController, traceId) {
  const originalSentences = splitIntoSentences(originalText);
  currentReadOriginalSentences = originalSentences;

  let textOverride;
  let translationFailed = null;

  const translateStartedAt = Date.now();
  traceEvent(traceId, "translate-start", {
    data: { chars: originalText.length, sentences: originalSentences.length, targetLang },
    meta: { targetLang },
  });
  setStatus("Translating...", false);
  console.log("[ReadAloud/popup] calling translateText()", { textLength: originalText.length, targetLang });
  try {
    textOverride = await translateText(originalText, targetLang, traceId, "popup");
    console.log("[ReadAloud/popup] translateText() resolved:", textOverride);
    traceEvent(traceId, "translate-result", {
      durationMs: Date.now() - translateStartedAt,
      data: { chars: (textOverride || "").length },
    });
  } catch (e) {
    console.error("[ReadAloud/popup] translateText() THREW:", e && (e.stack || e.message || e));
    traceEvent(traceId, "translate-result", {
      ok: false, error: e, durationMs: Date.now() - translateStartedAt,
    });
    translationFailed = e?.message || String(e);
    textOverride = originalText;
  }
  if (abortController.signal.aborted) {
    traceEvent(traceId, "cancelled", { data: { after: "translate" }, meta: { outcome: "cancelled" } });
    return;
  }

  const matchedVoice = findVoiceForLang(availableVoices, targetLang);
  const voiceName = matchedVoice || voiceSelect.value;
  console.log("[ReadAloud/popup] voice resolution", { targetLang, matchedVoice, voiceName });
  const engine = (!translationFailed && !matchedVoice && hasPiperVoice(targetLang)) ? "piper" : "speechSynthesis";
  traceEvent(traceId, "voice-selection", {
    data: {
      matchedVoice: matchedVoice || null,
      fallbackVoice: matchedVoice ? null : (voiceSelect.value || "(browser default)"),
      voicesAvailable: availableVoices.length,
      engine,
      translationFailed: !!translationFailed,
    },
    meta: { engine },
  });

  // Local Piper TTS fallback: only when translation succeeded, no local
  // system voice exists for this language, AND a Piper voice is configured
  // for it (currently just Urdu). Every other case - translation failure,
  // or a language with a real local voice - falls through to the normal
  // speechSynthesis SPEAK path below.
  if (!translationFailed && !matchedVoice && hasPiperVoice(targetLang)) {
    console.log("[ReadAloud/popup] no local voice for", targetLang, "- using local Piper fallback");
    setStatus("No local voice - synthesizing with local Piper...", false);
    try {
      // Always synthesize at neutral speed (1x) and apply the actual rate
      // via the <audio> element's playbackRate in offscreen.js instead - that
      // also handles later live rate-slider changes smoothly. Baking rate
      // into synthesis AND applying playbackRate on top would compound
      // (e.g. two separate 1.5x's stacking to 2.25x).
      const audioChunks = await synthesizeWithPiper(textOverride, 1, abortController.signal, traceId, "popup");
      if (abortController.signal.aborted) {
        traceEvent(traceId, "cancelled", { data: { after: "synthesis" }, meta: { outcome: "cancelled" } });
        return;
      }
      // Plays in the offscreen document rather than the page: a content script
      // is bound by the page's Content-Security-Policy, and a site serving
      // "media-src 'self'" silently blocked the data: WAV URL - which is what
      // made Urdu work on some pages and not others.
      const piperRes = await sendToPiperPlayer({
        type: "PIPER_PLAY",
        audioChunks,
        rate,
        totalSentences: originalSentences.length,
        traceId,
      });
      if (piperRes?.error || !piperRes?.started) {
        const reason = piperRes?.error || "the audio player did not start";
        console.error("[ReadAloud/popup] [piper] FAILED to start playback:", reason);
        traceEvent(traceId, "piper-play-dispatch", { ok: false, error: reason, meta: { outcome: "error" } });
        setStatus(`Piper audio could not play (${reason}).`, true);
        applyControlState(null);
        return;
      }
      const state = await getCurrentState();
      if (state) applyControlState(state);
      const preview = textOverride.length > 70 ? `${textOverride.slice(0, 70)}...` : textOverride;
      setStatus(`Reading (${targetLang}, Piper): "${preview}"`, false);
    } catch (e) {
      if (e?.name === "AbortError") {
        console.log("[ReadAloud/popup] Piper synthesis cancelled");
        traceEvent(traceId, "cancelled", { data: { after: "synthesis" }, meta: { outcome: "cancelled" } });
        return;
      }
      console.error("[ReadAloud/popup] Piper TTS failed:", e && (e.stack || e.message || e));
      traceEvent(traceId, "piper-failed", { ok: false, error: e, meta: { outcome: "error" } });
      setStatus(`Piper TTS failed (${e?.message || e}) - not reading with the wrong voice.`, true);
      applyControlState(null);
    }
    return;
  }

  const res = await sendToActiveTab({
    type: "SPEAK",
    text: textOverride,
    rate,
    voiceName,
    totalSentences: originalSentences.length,
    traceId,
  });
  if (res?.error) {
    traceEvent(traceId, "speak-dispatch", { ok: false, error: res.error, meta: { outcome: "error" } });
    console.error("[ReadAloud/popup] FAILED sending SPEAK:", res.error, "| tab.url:", res.tabUrl);
    setStatus(`[send-speak] ${res.error} | tab: ${res.tabUrl || "unknown"}`, true);
    applyControlState(null);
    return;
  }
  if (res.spoke === false) {
    const state = await getCurrentState();
    if (state) applyControlState(state);
    setStatus("Highlight some text on the page first.", true);
    return;
  }

  console.log("[ReadAloud/popup] now speaking text:", JSON.stringify(textOverride), "translationFailed:", translationFailed);
  const state = await getCurrentState();
  if (state) applyControlState(state);
  const preview = textOverride.length > 70 ? `${textOverride.slice(0, 70)}...` : textOverride;
  if (translationFailed) {
    setStatus(`Translation failed (${translationFailed}) - reading original: "${preview}"`, true);
  } else if (!matchedVoice) {
    setStatus(`No ${targetLang} voice installed - audio will be mostly silent/wrong, not "${preview}"`, true);
  } else {
    setStatus(`Reading (${targetLang}): "${preview}"`, false);
  }
}

translateTargetSelect.addEventListener("change", async () => {
  const newTargetLang = translateTargetSelect.value;
  chrome.storage.sync.set({ translateTarget: newTargetLang });
  updateVoiceHint();

  // Live switch only applies while something is actually playing right now.
  // Otherwise this is just saving the setting for next time, exactly as before.
  if (!readBtn.classList.contains("is-stop")) return;

  if (!currentReadOriginalSentences) {
    // The button is on "Stop Reading" for an UNTRANSLATED read - a plain
    // click with Translate=Off, or the auto-read that fires silently when
    // the popup opens with "Translate to" still at its previous value.
    // runTranslatedRead() is the only thing that sets
    // currentReadOriginalSentences, and neither of those paths calls it, so
    // there is no tracked position to resume from here.
    //
    // Without this branch, picking a real language while one of those is
    // playing did nothing: the old (untranslated) read kept going, the
    // button stayed labeled "Stop Reading" for it, and the NEXT click on
    // "Read Selection" was read as Stop - it silenced the old read and
    // returned, never reaching the translate flow at all. That is exactly
    // the sequence that was reported broken: select text, the popup
    // auto-reads the English original, pick Urdu, click Read Selection,
    // nothing happens - confirmed via a live diagnostic capture showing the
    // click sent STOP, not SPEAK, and no translate-start event ever fired.
    if (!newTargetLang) return; // Off -> Off while an untranslated read plays: nothing to do
    if (currentAbortController) currentAbortController.abort();
    await stopEverything();
    const selRes = await sendToActiveTab({ type: "GET_SELECTION_TEXT" });
    const originalText = selRes?.text || "";
    if (!originalText.trim()) {
      await refreshState();
      return;
    }
    const rate = Number(rateInput.value);
    const abortController = new AbortController();
    currentAbortController = abortController;
    const traceId = newTraceId();
    currentTraceId = traceId;
    const tab = await getActiveTab();
    traceEvent(traceId, "click", {
      data: { chars: originalText.length, targetLang: newTargetLang },
      meta: { trigger: "language-switch", origin: originOf(tab?.url), targetLang: newTargetLang },
    });
    applyControlState({ speaking: true });
    setStatus("Working...", false);
    await runTranslatedRead(originalText, newTargetLang, rate, abortController, traceId);
    return;
  }

  console.log("[ReadAloud/popup] language changed mid-read to", newTargetLang || "(Off)", "- resuming near current position");
  if (currentAbortController) currentAbortController.abort();

  // Whichever source is actually playing owns the position: Piper audio tracks
  // it exactly (one chunk = a known number of sentences), the page's
  // speechSynthesis can only approximate it from a character offset.
  const piperState = await sendToPiperPlayer({ type: "PIPER_STATE" });
  const posRes = piperState?.playing
    ? await sendToPiperPlayer({ type: "PIPER_POSITION" })
    : await sendToActiveTab({ type: "GET_PLAYBACK_POSITION" });
  await stopEverything();

  const sentenceIndex = Math.min(Math.max(posRes?.sentenceIndex || 0, 0), currentReadOriginalSentences.length - 1);
  const remainingText = currentReadOriginalSentences.slice(sentenceIndex).join(" ").trim();
  console.log("[ReadAloud/popup] resuming from sentence", sentenceIndex, "of", currentReadOriginalSentences.length);

  if (!remainingText) {
    currentReadOriginalSentences = null;
    await refreshState();
    return;
  }

  const rate = Number(rateInput.value);
  const switchTraceId = newTraceId();
  currentTraceId = switchTraceId;
  const switchTab = await getActiveTab();
  traceEvent(switchTraceId, "click", {
    data: { resumedFromSentence: sentenceIndex, ofSentences: currentReadOriginalSentences.length, chars: remainingText.length },
    meta: { trigger: "language-switch", origin: originOf(switchTab?.url), targetLang: newTargetLang || null },
  });
  applyControlState({ speaking: true });
  setStatus("Working...", false);

  if (!newTargetLang) {
    // Switched to "Off" mid-read: resume with the plain original remainder,
    // no translation, no sentence tracking (matches a normal Off read).
    currentReadOriginalSentences = null;
    traceEvent(switchTraceId, "voice-selection", {
      data: { matchedVoice: null, fallbackVoice: voiceSelect.value || "(browser default)", engine: "speechSynthesis" },
      meta: { engine: "speechSynthesis" },
    });
    const res = await sendToActiveTab({ type: "SPEAK", text: remainingText, rate, voiceName: voiceSelect.value, traceId: switchTraceId });
    if (res?.error) {
      traceEvent(switchTraceId, "speak-dispatch", { ok: false, error: res.error, meta: { outcome: "error" } });
      console.error("[ReadAloud/popup] FAILED sending SPEAK (live switch to Off):", res.error, "| tab.url:", res.tabUrl);
      setStatus(`[send-speak] ${res.error} | tab: ${res.tabUrl || "unknown"}`, true);
      applyControlState(null);
      return;
    }
    await refreshState();
    return;
  }

  const abortController = new AbortController();
  currentAbortController = abortController;
  await runTranslatedRead(remainingText, newTargetLang, rate, abortController, switchTraceId);
});

readBtn.addEventListener("click", async () => {
  if (readBtn.classList.contains("is-stop")) {
    traceEvent(currentTraceId, "stop-requested", { meta: { outcome: "stopped" } });
    if (currentAbortController) currentAbortController.abort();
    const stopped = await stopEverything();
    currentReadOriginalSentences = null;
    currentTraceId = null;
    if (stopped) await refreshState();
    return;
  }

  if (isProcessingRead) {
    console.log("[ReadAloud/popup] ignoring click - a read request is already in flight");
    return;
  }
  isProcessingRead = true;
  // Show a stoppable state immediately, before any network/translation/
  // synthesis work starts - previously this only happened after everything
  // completed, so for a translated read (especially Piper, which can take
  // several seconds across multiple chunks) the button looked stuck on
  // "Read Selection" with no way to stop it the whole time.
  applyControlState({ speaking: true });
  setStatus("Working...", false);

  const abortController = new AbortController();
  currentAbortController = abortController;

  const traceId = newTraceId();
  currentTraceId = traceId;

  try {
    // A new read replaces any Piper audio still playing. The page's own STOP
    // can't do this any more - that audio lives in the offscreen document.
    await sendToPiperPlayer({ type: "PIPER_STOP" });

    const rate = Number(rateInput.value);
    const targetLang = translateTargetSelect.value;
    const activeTab = await getActiveTab();
    traceEvent(traceId, "click", {
      data: { rate, targetLang: targetLang || null },
      meta: {
        trigger: "popup-button",
        origin: originOf(activeTab?.url),
        targetLang: targetLang || null,
      },
    });

    if (targetLang) {
      console.log("[ReadAloud/popup] === translate flow start === target:", targetLang);

      console.log("[ReadAloud/popup] sending PING (diagnostic - isolates transport from getSelection)");
      const pingRes = await sendToActiveTab({ type: "PING" });
      if (pingRes?.error) {
        traceEvent(traceId, "ping", { ok: false, error: pingRes.error, meta: { outcome: "error" } });
        console.error("[ReadAloud/popup] PING failed:", pingRes.error, "| tab.url:", pingRes.tabUrl);
        setStatus(`[ping] ${pingRes.error} | tab: ${pingRes.tabUrl || "unknown"}`, true);
        applyControlState(null);
        return;
      }
      if (abortController.signal.aborted) return;

      console.log("[ReadAloud/popup] requesting selection text");
      const selRes = await sendToActiveTab({ type: "GET_SELECTION_TEXT" });
      if (selRes?.error) {
        traceEvent(traceId, "selection", { ok: false, error: selRes.error, meta: { outcome: "error" } });
        console.error("[ReadAloud/popup] FAILED getting selection:", selRes.error, "| tab.url:", selRes.tabUrl);
        setStatus(`[get-selection] ${selRes.error} | tab: ${selRes.tabUrl || "unknown"}`, true);
        applyControlState(null);
        return;
      }
      const originalText = selRes?.text || "";
      console.log("[ReadAloud/popup] selection captured:", JSON.stringify(originalText));
      // Character counts only - never the text itself. See trace.js.
      traceEvent(traceId, "selection", {
        data: { chars: originalText.length, sentences: splitIntoSentences(originalText).length },
      });
      if (!originalText.trim()) {
        traceEvent(traceId, "empty-selection", { meta: { outcome: "empty" } });
        setStatus("Highlight some text on the page first.", true);
        applyControlState(null);
        return;
      }
      if (abortController.signal.aborted) {
        traceEvent(traceId, "cancelled", { data: { after: "selection" }, meta: { outcome: "cancelled" } });
        return;
      }

      await runTranslatedRead(originalText, targetLang, rate, abortController, traceId);
      return;
    }

    currentReadOriginalSentences = null;
    traceEvent(traceId, "voice-selection", {
      data: { matchedVoice: null, fallbackVoice: voiceSelect.value || "(browser default)", voicesAvailable: availableVoices.length, engine: "speechSynthesis" },
      meta: { engine: "speechSynthesis" },
    });
    // text is undefined here on purpose: content.js reads the live page
    // selection itself, so it - not the popup - reports the character count.
    const res = await sendToActiveTab({ type: "SPEAK", text: undefined, rate, voiceName: voiceSelect.value, traceId });
    if (res?.error) {
      traceEvent(traceId, "speak-dispatch", { ok: false, error: res.error, meta: { outcome: "error" } });
      console.error("[ReadAloud/popup] FAILED sending SPEAK:", res.error, "| tab.url:", res.tabUrl);
      setStatus(`[send-speak] ${res.error} | tab: ${res.tabUrl || "unknown"}`, true);
      applyControlState(null);
      return;
    }
    if (res.spoke === false) {
      traceEvent(traceId, "empty-selection", { meta: { outcome: "empty" } });
      const state = await getCurrentState();
      if (state) applyControlState(state);
      setStatus("Highlight some text on the page first.", true);
      return;
    }
    await refreshState();
  } finally {
    isProcessingRead = false;
  }
});

const tabRead = document.getElementById("tabRead");
const tabDictate = document.getElementById("tabDictate");
const readView = document.getElementById("readView");
const dictateView = document.getElementById("dictateView");
const sttLangSelect = document.getElementById("sttLang");
const recordBtn = document.getElementById("recordBtn");
const transcriptEl = document.getElementById("transcript");
const undoBtn = document.getElementById("undoBtn");
const redoBtn = document.getElementById("redoBtn");
const revertBtn = document.getElementById("revertBtn");
const copyBtn = document.getElementById("copyBtn");
const clearBtn = document.getElementById("clearBtn");
const sttStatusEl = document.getElementById("sttStatus");
const fixMicBtn = document.getElementById("fixMicBtn");

function setSttStatus(text, isError) {
  sttStatusEl.textContent = text || "";
  sttStatusEl.style.color = isError ? "#dc2626" : "#6b7280";
}

fixMicBtn.addEventListener("click", async () => {
  // Chrome cannot show the mic permission prompt inside an extension popup
  // at all - confirmed directly: calling getUserMedia() from here doesn't
  // even fail cleanly, it hangs forever waiting for a dialog the popup can't
  // host. It has to happen on a real page instead. Rather than opening a new
  // tab for that, navigate the user's CURRENT tab there (permission.html
  // carries a "return" URL and navigates back on its own once access is
  // granted) - no extra tab ever appears. That navigation also closes THIS
  // popup (any extension popup closes the instant its tab navigates away or
  // loses focus), so there is no live popup left to notice permission being
  // granted a moment later - only a fresh popup opened afterward can. This
  // flag is the hand-off: it survives the popup closing, and is checked by
  // maybeAutoResumeListening() the next time the popup opens.
  chrome.storage.local.set({ pendingAutoListen: true });
  const permissionUrl = chrome.runtime.getURL("permission.html");
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const canReturnTo = tab?.id != null && /^https?:/.test(tab.url || "");
  if (canReturnTo) {
    chrome.tabs.update(tab.id, {
      url: `${permissionUrl}?return=${encodeURIComponent(tab.url)}`,
    });
  } else {
    // No ordinary page to navigate back to (e.g. a chrome:// tab or the New
    // Tab page) - fall back to a separate tab rather than stranding the user
    // on one they can't return to automatically.
    chrome.tabs.create({ url: permissionUrl });
  }
});

// Runs once at popup startup. If the user previously hit "Allow microphone
// in a new tab" and mic access has since actually been granted (checked via
// permissions.query, which - unlike getUserMedia() - works fine from inside
// a popup without hanging or prompting), switch to Voice to Text and start
// listening immediately, so granting permission is the last manual step
// instead of also having to come back and press Start Listening again.
async function maybeAutoResumeListening() {
  const { pendingAutoListen } = await new Promise((resolve) =>
    chrome.storage.local.get({ pendingAutoListen: false }, resolve)
  );
  if (!pendingAutoListen) return;
  if (!navigator.permissions?.query) return;
  const status = await navigator.permissions.query({ name: "microphone" }).catch(() => null);
  if (status?.state !== "granted") return; // still not granted - leave the flag for next time
  chrome.storage.local.set({ pendingAutoListen: false });
  setMode("dictate");
  recordBtn.click();
}

// Same pattern as the microphone link above: an extension page in a normal
// tab. It has to be a page rather than something in the popup, because only a
// page can offer a real file download - the extension has no "downloads"
// permission.
document.getElementById("diagnosticsBtn").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("trace.html") });
});

function setMode(mode) {
  const isDictate = mode === "dictate";
  if (isDictate) {
    stopEverything();
  } else if (isListening) {
    userStopped = true;
    recognition?.stop();
  }
  readView.hidden = isDictate;
  dictateView.hidden = !isDictate;
  tabRead.classList.toggle("is-active", !isDictate);
  tabDictate.classList.toggle("is-active", isDictate);
  tabRead.setAttribute("aria-selected", String(!isDictate));
  tabDictate.setAttribute("aria-selected", String(isDictate));
}

tabRead.addEventListener("click", () => setMode("read"));
tabDictate.addEventListener("click", () => setMode("dictate"));

async function loadSttLang() {
  const { sttLang } = await new Promise((resolve) =>
    chrome.storage.sync.get({ sttLang: "en-US" }, resolve)
  );
  sttLangSelect.value = sttLang;
}

sttLangSelect.addEventListener("change", () => {
  chrome.storage.sync.set({ sttLang: sttLangSelect.value });
  if (recognition) recognition.lang = sttLangSelect.value;
});

const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;
let isListening = false;
let userStopped = false;
let lastRecognitionError = null;
let finalTranscript = "";
let originalTranscript = "";

let editHistory = [""];
let historyIndex = 0;
let isApplyingHistory = false;
let historyDebounce = null;

function updateEditButtons() {
  undoBtn.disabled = historyIndex <= 0;
  redoBtn.disabled = historyIndex >= editHistory.length - 1;
  revertBtn.disabled = transcriptEl.value === originalTranscript;
}

function pushHistory(value) {
  if (editHistory[historyIndex] === value) return;
  editHistory = editHistory.slice(0, historyIndex + 1);
  editHistory.push(value);
  historyIndex = editHistory.length - 1;
  updateEditButtons();
}

function setTranscriptValue(value) {
  isApplyingHistory = true;
  transcriptEl.value = value;
  isApplyingHistory = false;
  finalTranscript = value ? value + " " : "";
  updateEditButtons();
}

transcriptEl.addEventListener("input", () => {
  updateEditButtons();
  if (isApplyingHistory) return;
  finalTranscript = transcriptEl.value ? transcriptEl.value + " " : "";
  clearTimeout(historyDebounce);
  historyDebounce = setTimeout(() => pushHistory(transcriptEl.value), 400);
});

undoBtn.addEventListener("click", () => {
  if (historyIndex <= 0) return;
  historyIndex -= 1;
  setTranscriptValue(editHistory[historyIndex]);
});

redoBtn.addEventListener("click", () => {
  if (historyIndex >= editHistory.length - 1) return;
  historyIndex += 1;
  setTranscriptValue(editHistory[historyIndex]);
});

revertBtn.addEventListener("click", () => {
  setTranscriptValue(originalTranscript);
  pushHistory(originalTranscript);
});

function createRecognition() {
  const r = new SpeechRecognitionCtor();
  r.continuous = true;
  r.interimResults = true;
  r.lang = sttLangSelect.value;

  r.onresult = (event) => {
    let interim = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const text = event.results[i][0].transcript;
      if (event.results[i].isFinal) finalTranscript += text + " ";
      else interim += text;
    }
    transcriptEl.value = (finalTranscript + interim).trim();
    originalTranscript = finalTranscript.trim();
    updateEditButtons();
  };

  r.onerror = (event) => {
    lastRecognitionError = event.error;
  };

  r.onend = () => {
    const error = lastRecognitionError;
    lastRecognitionError = null;
    const fatal = error === "not-allowed" || error === "network";

    if (!userStopped && !fatal) {
      try {
        r.start();
        return;
      } catch (e) {
        // fall through and stop for real below
      }
    }

    isListening = false;
    recordBtn.textContent = "Start Listening";
    recordBtn.classList.remove("is-recording");
    originalTranscript = transcriptEl.value;
    pushHistory(originalTranscript);

    if (fatal) {
      const messages = {
        "not-allowed": "Microphone blocked - extension popups can't show Chrome's permission prompt.",
        network: "Network error - check your connection.",
      };
      setSttStatus(messages[error], true);
      fixMicBtn.hidden = error !== "not-allowed";
    } else {
      setSttStatus("", false);
    }
  };

  return r;
}

recordBtn.addEventListener("click", () => {
  if (isListening) {
    userStopped = true;
    recognition?.stop();
    return;
  }
  if (!SpeechRecognitionCtor) {
    setSttStatus("Voice typing isn't supported here.", true);
    return;
  }
  userStopped = false;
  lastRecognitionError = null;
  fixMicBtn.hidden = true;
  finalTranscript = transcriptEl.value ? transcriptEl.value + " " : "";
  recognition = createRecognition();
  try {
    recognition.start();
    isListening = true;
    recordBtn.textContent = "Stop";
    recordBtn.classList.add("is-recording");
    setSttStatus("Listening...", false);
  } catch (e) {
    setSttStatus("Could not start listening.", true);
  }
});

clearBtn.addEventListener("click", () => {
  finalTranscript = "";
  originalTranscript = "";
  setTranscriptValue("");
  pushHistory("");
});

copyBtn.addEventListener("click", async () => {
  if (!transcriptEl.value) return;
  try {
    await navigator.clipboard.writeText(transcriptEl.value);
    setSttStatus("Copied.", false);
  } catch (e) {
    setSttStatus("Could not copy.", true);
  }
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "TTS_STATE_CHANGED") refreshState();
});

async function autoReadIfSelected() {
  // Deliberately does not translate: this runs silently the instant the popup
  // opens, with no explicit user action, so it never sends selected text to a
  // translation service on its own. It also avoids racing the network-bound
  // translate flow against a manual click a moment later. Translation only
  // ever runs from an explicit action (the button or the right-click menu).
  //
  // Skipped while Piper audio is playing: content.js only knows whether the
  // PAGE is speaking, so without this, reopening the popup during an Urdu read
  // would start reading the same selection again in English, over the top.
  const piperState = await sendToPiperPlayer({ type: "PIPER_STATE" });
  if (piperState?.playing) {
    await refreshState();
    return;
  }

  // When a translation target IS set, don't auto-read at all. Reading the
  // untranslated original here didn't just play the wrong language - it flipped
  // the button to "Stop Reading" before the user had touched anything, so their
  // very first click on "Read Selection" was taken as Stop and the translation
  // never ran. That is exactly what "I pick Urdu, click the extension, and it
  // never translates" was: the translate flow was never reached at all.
  // Translating here instead is not an option - see the note above about never
  // sending the selection to a translation service without an explicit action.
  if (translateTargetSelect.value) {
    const langLabel = translateTargetSelect.selectedOptions[0]?.textContent || translateTargetSelect.value;
    console.log("[ReadAloud/popup] translate target set - skipping auto-read so the first click still reads");
    setStatus(`Click "Read Selection" to read this in ${langLabel}.`, false);
    return;
  }

  const res = await sendAction({ type: "AUTO_SPEAK", rate: 1, voiceName: voiceSelect.value });
  if (!res) return;
  if (res.restarted) {
    rateInput.value = 1;
    rateLabel.textContent = "1.0x";
  }
  await refreshState();
}

(async function init() {
  const settings = await loadSettings();
  await populateVoices(settings.voiceName);
  const state = await refreshState();
  await loadSttLang();
  await maybeAutoResumeListening();
  if (state) {
    await autoReadIfSelected();
  }
})();
