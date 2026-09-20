import { traceEvent } from "./trace.js";

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

async function translateWithFallback(text, targetLang, isRetry, traceId, ctx) {
  // sl=en (not "auto") to match the sourceLanguage: "en" already assumed by
  // the built-in Translator calls above. Auto-detection can misfire on text
  // that's heavy with foreign/Latin loan-words (e.g. "Cicero", "Lorem
  // Ipsum" itself) and decide the source isn't English, returning it
  // largely unchanged instead of translating it.
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=${encodeURIComponent(targetLang)}&dt=t&q=${encodeURIComponent(text)}`;
  console.log("[ReadAloud/translate] fetching fallback endpoint", isRetry ? "(retry)" : "", url);
  let res;
  try {
    res = await fetch(url);
  } catch (e) {
    console.error("[ReadAloud/translate] fetch() itself THREW (network/CSP/offline):", e && (e.stack || e.message || e));
    traceEvent(traceId, "translate-endpoint", {
      ctx, ok: false, error: e, data: { endpoint: "google", isRetry: !!isRetry, threw: true },
    });
    if (!isRetry) return translateWithFallback(text, targetLang, true, traceId, ctx);
    throw e;
  }
  console.log("[ReadAloud/translate] fetch response status:", res.status, res.ok);
  traceEvent(traceId, "translate-endpoint", {
    ctx, ok: res.ok, data: { endpoint: "google", httpStatus: res.status, isRetry: !!isRetry },
  });
  if (!res.ok) {
    if (!isRetry) return translateWithFallback(text, targetLang, true, traceId, ctx);
    throw new Error(`Translation request failed with HTTP ${res.status}`);
  }
  const data = await res.json();
  console.log("[ReadAloud/translate] raw response JSON:", data);
  const result = data[0].map((chunk) => chunk[0]).join("");
  console.log("[ReadAloud/translate] fallback translation result:", result);
  return result;
}

async function translateWithMyMemory(text, targetLang, traceId, ctx) {
  // A second, independent free/no-signup translation service - used only
  // when the primary (Google) fallback above fails, e.g. while its endpoint
  // is rate-limiting this network (HTTP 429), so translation can still work
  // instead of the whole feature going down with it.
  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=en|${encodeURIComponent(targetLang)}`;
  console.log("[ReadAloud/translate] fetching MyMemory fallback:", url);
  const res = await fetch(url);
  console.log("[ReadAloud/translate] MyMemory response status:", res.status, res.ok);
  traceEvent(traceId, "translate-endpoint", {
    ctx, ok: res.ok, data: { endpoint: "mymemory", httpStatus: res.status },
  });
  if (!res.ok) throw new Error(`MyMemory request failed with HTTP ${res.status}`);
  const data = await res.json();
  console.log("[ReadAloud/translate] MyMemory raw response:", data);
  const result = data?.responseData?.translatedText;
  if (!result || /MYMEMORY WARNING/i.test(result)) {
    throw new Error(`MyMemory could not translate this (${result || "empty response"})`);
  }
  console.log("[ReadAloud/translate] MyMemory translation result:", result);
  return result;
}

// Deliberately does NOT use Chrome's experimental built-in Translator API.
// That path existed here before and could return a truthy-but-wrong result
// (an incomplete/unsupported on-device model still resolves to *a* string),
// which this code then accepted as success and never fell through to the
// endpoints below - the ones actually verified working, repeatedly, against
// real requests. One less unverifiable moving part in the chain.
// traceId/ctx are diagnostic only - they change nothing about which endpoint
// is tried or in what order. They exist so a trace can say WHICH service
// answered and with what HTTP status, which is the difference between "the
// network is down" and "Google is rate-limiting this address" (a real HTTP 429
// seen on this network before) - indistinguishable from the outside otherwise.
export async function translateText(text, targetLang, traceId, ctx) {
  console.log("[ReadAloud/translate] translateText() called", { targetLang, textLength: text.length });
  return withTimeout(
    (async () => {
      try {
        return await translateWithFallback(text, targetLang, false, traceId, ctx);
      } catch (e) {
        console.error("[ReadAloud/translate] Google endpoint failed, trying MyMemory:", e && (e.stack || e.message || e));
        return await translateWithMyMemory(text, targetLang, traceId, ctx);
      }
    })(),
    8000,
    "Translation"
  );
}

export function findVoiceForLang(voices, langCode) {
  if (!langCode) return null;
  const prefix = langCode.split("-")[0].toLowerCase();
  const match = (voices || []).find((v) => v.lang.toLowerCase().startsWith(prefix));
  return match ? match.name : null;
}
