// End-to-end diagnostic tracing.
//
// A single Read Selection run touches five runtime contexts - popup, content
// script, service worker, offscreen document and a Python native host - each
// with its own console. When a read goes wrong, the only thing visible is a
// one-line status message, and reconstructing what actually happened means
// having the right console open in the right context at the right instant.
// A trace stitches all of that into one timeline under one id.
//
// PRIVACY RULE: only integer counts derived from text are ever recorded. No
// selected text, no translated text, no URL path or query, no transcript.
// Everything added here must keep that true - see originOf() below.

export const TRACE_MESSAGE = "TRACE_EVENT";

export function newTraceId() {
  return `ra-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// Scheme + host only. A full URL routinely carries document names, search
// terms and account ids in its path and query; the origin is enough to tell
// "works on site A, silent on site B" apart, which is the question traces
// most often need to answer.
export function originOf(url) {
  try {
    const u = new URL(url);
    if (u.protocol === "http:" || u.protocol === "https:") return u.origin;
    return u.protocol.replace(":", ""); // chrome:, file:, about: - scheme alone
  } catch {
    return null;
  }
}

// Fire-and-forget. Never awaited, never throws: instrumentation must not be
// able to break, slow, or reorder a read. A dropped event is strictly better
// than a changed behaviour.
export function traceEvent(traceId, stage, fields = {}) {
  if (!traceId) return;
  try {
    const message = {
      type: TRACE_MESSAGE,
      traceId,
      stage,
      ctx: fields.ctx || "popup",
      ok: fields.ok !== false,
      tsWall: Date.now(),
    };
    if (fields.error !== undefined && fields.error !== null) {
      message.error = String(fields.error.message || fields.error).slice(0, 500);
    }
    if (fields.durationMs !== undefined) message.durationMs = fields.durationMs;
    if (fields.data) message.data = fields.data;
    // Trace-level fields (trigger, origin, targetLang, engine, outcome) ride
    // along on whichever event first knows them; the store merges them onto
    // the trace object rather than the event.
    if (fields.meta) message.meta = fields.meta;

    const sent = chrome.runtime.sendMessage(message);
    if (sent && typeof sent.catch === "function") sent.catch(() => {});
  } catch {
    // Context torn down mid-read, or messaging unavailable. Nothing to do.
  }
}
