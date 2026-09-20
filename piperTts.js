// Talks to a local native-messaging host (piper_host.py, installed at
// ~/Library/Application Support/ReadAloudPiperHost/ - see native-host/README.md)
// that runs your own local Piper installation. No network call, no API key,
// no backend - the extension only exchanges messages with a process running
// on this machine, registered via native-host/com.readaloud.piper_tts.json.
import { traceEvent } from "./trace.js";

const NATIVE_HOST_NAME = "com.readaloud.piper_tts";
const NATIVE_HOST_TIMEOUT_MS = 20000;

// Text is split into pieces this small (not just "small enough to be safe")
// because a single native-messaging response bundling multiple chunks
// together was confirmed to fail: one real paragraph produced a 3.3MB
// combined response and Chrome's native messaging transport rejected it
// ("Error when communicating with the native messaging host"). Each chunk
// is now sent as its own separate native-messaging call with its own small
// response, so no single message ever gets close to that ceiling - raw
// 22kHz mono WAV runs about 3KB per character of input text, so 130 chars
// keeps a single response comfortably under ~500KB.
const MAX_CHARS_PER_CHUNK = 130;

// Only languages listed here get a Piper fallback when no local system voice
// exists. Every other language keeps its existing (pre-Piper) behaviour
// untouched - this is the single place that changes if more get added.
const PIPER_VOICE_MAP = {
  ur: true,
};

export function hasPiperVoice(targetLang) {
  return Boolean(PIPER_VOICE_MAP[targetLang]);
}

// Live check for whether the native host is actually installed and reachable
// on THIS machine - hasPiperVoice() above only says a language is mapped to
// Piper, not that Piper itself is set up here. Uses the host's existing PING
// message (piper_host.py already replies {pong:true} to it, cheaply, with no
// model load) rather than a real SYNTHESIZE call, so checking is fast and
// doesn't need real text. chrome.runtime.lastError is what fires when the
// host manifest isn't installed at all - the common case for anyone other
// than a machine that's been through native-host/README.md's setup.
export function checkPiperHostAvailable() {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), 3000);
    try {
      chrome.runtime.sendNativeMessage(NATIVE_HOST_NAME, { type: "PING" }, (response) => {
        clearTimeout(timer);
        finish(!chrome.runtime.lastError && Boolean(response));
      });
    } catch (e) {
      clearTimeout(timer);
      finish(false);
    }
  });
}

function splitOversizedSentence(sentence, maxChars) {
  // Fallback for a "sentence" with no punctuation at all (a long run-on
  // line) - split on whitespace so we still stay under maxChars without
  // cutting a word in half.
  const words = sentence.split(" ");
  const parts = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}`.trim() : word;
    if (candidate.length > maxChars && current) {
      parts.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) parts.push(current);
  return parts;
}

// Plain sentence split with no size packing - shared with popup.js so both
// sides agree on what "one sentence" means (needed for tracking playback
// position at sentence granularity when the language changes mid-read).
export function splitIntoSentences(text) {
  const rawSentences = text.trim().split(/(?<=[۔.!?])\s+/).filter(Boolean);
  return rawSentences.length ? rawSentences : [text.trim()];
}

// Packs sentences into chunks of at most maxChars, returning each chunk
// alongside how many sentences it contains - the caller needs that count to
// track playback position (see content.js's sentencesCompleted counter).
function packIntoChunks(sentences, maxChars) {
  const normalized = [];
  for (const s of sentences) {
    if (s.length > maxChars) normalized.push(...splitOversizedSentence(s, maxChars));
    else normalized.push(s);
  }
  const chunks = [];
  let currentText = "";
  let currentCount = 0;
  for (const sentence of normalized) {
    if (!sentence) continue;
    const candidate = currentText ? `${currentText} ${sentence}`.trim() : sentence;
    if (candidate.length > maxChars && currentText) {
      chunks.push({ text: currentText, sentenceCount: currentCount });
      currentText = sentence;
      currentCount = 1;
    } else {
      currentText = candidate;
      currentCount += 1;
    }
  }
  if (currentText) chunks.push({ text: currentText, sentenceCount: currentCount });
  return chunks;
}

function synthesizeOneChunk(text, rate, traceId) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`Piper native host did not respond within ${NATIVE_HOST_TIMEOUT_MS / 1000}s`));
    }, NATIVE_HOST_TIMEOUT_MS);

    try {
      chrome.runtime.sendNativeMessage(
        NATIVE_HOST_NAME,
        // traceId is echoed back by the host and also written to its own
        // piper_host.log, so a line in that file can be matched to a run here.
        { type: "SYNTHESIZE", text, rate, traceId },
        (response) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);

          if (chrome.runtime.lastError) {
            console.error("[ReadAloud/piper] sendNativeMessage lastError:", chrome.runtime.lastError.message);
            reject(new Error(
              `Could not reach the local Piper host (${chrome.runtime.lastError.message}). ` +
              `Check that native-host/com.readaloud.piper_tts.json is installed in Chrome's ` +
              `NativeMessagingHosts folder and that the extension was reloaded after installing it.`
            ));
            return;
          }
          if (!response) {
            reject(new Error("No response from Piper native host"));
            return;
          }
          if (response.error) {
            reject(new Error(response.error));
            return;
          }
          if (!response.audioBase64) {
            reject(new Error("Piper host returned no audio"));
            return;
          }
          // Whole response, not just the audio: it also carries the host's
          // timings, which are the only view into model load vs synthesis.
          resolve(response);
        }
      );
    } catch (e) {
      clearTimeout(timer);
      settled = true;
      reject(new Error(`Failed to call native messaging host: ${e.message}`));
    }
  });
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw new DOMException("Piper synthesis cancelled", "AbortError");
  }
}

// text should already be the translated text. rate is applied at playback
// time via the <audio> element (see content.js), not baked in here.
// Pass an AbortSignal to let Stop interrupt synthesis between chunks (a
// call already sent to the native host can't be cancelled mid-flight, but
// checking between chunks means Stop takes effect within about one chunk's
// synthesis time instead of waiting for the whole selection to finish).
export async function synthesizeWithPiper(text, rate, signal, traceId, ctx = "popup") {
  const sentences = splitIntoSentences(text);
  const chunks = packIntoChunks(sentences, MAX_CHARS_PER_CHUNK);
  console.log("[ReadAloud/piper] synthesizing", { textLength: text.length, rate, numChunks: chunks.length });

  const result = [];
  for (let i = 0; i < chunks.length; i++) {
    throwIfAborted(signal);
    console.log(`[ReadAloud/piper] chunk ${i + 1}/${chunks.length}`, { length: chunks[i].text.length, sentenceCount: chunks[i].sentenceCount });
    traceEvent(traceId, "piper-request", {
      ctx,
      data: { chunk: i + 1, ofChunks: chunks.length, chars: chunks[i].text.length },
    });

    const startedAt = Date.now();
    let response;
    try {
      response = await synthesizeOneChunk(chunks[i].text, rate, traceId);
    } catch (e) {
      traceEvent(traceId, "native-response", {
        ctx, ok: false, error: e,
        durationMs: Date.now() - startedAt,
        data: { chunk: i + 1, ofChunks: chunks.length },
      });
      throw e;
    }

    const roundTripMs = Date.now() - startedAt;
    const timings = response.timings || null;
    traceEvent(traceId, "native-response", {
      ctx,
      durationMs: roundTripMs,
      data: {
        chunk: i + 1,
        ofChunks: chunks.length,
        base64Chars: (response.audioBase64 || "").length,
        // What the round trip cost beyond the host's own accounting: Chrome
        // fork/exec of a fresh Python process plus native-messaging IPC. A
        // separate process is spawned PER CHUNK, so this is paid every time.
        spawnOverheadMs: timings
          ? Math.max(0, roundTripMs - (timings.hostStartupMs || 0) - (timings.subprocessMs || 0))
          : undefined,
      },
    });
    if (timings) traceEvent(traceId, "host-timings", { ctx: "host", data: timings });

    throwIfAborted(signal);
    result.push({ audioBase64: response.audioBase64, sentenceCount: chunks[i].sentenceCount });
  }
  console.log("[ReadAloud/piper] all chunks synthesized:", result.length);
  return result;
}
