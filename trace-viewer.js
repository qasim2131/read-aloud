// Renders the diagnostic traces written by background.js. Read-only: the
// service worker is the only writer, so this page never has to worry about
// racing it - it just reads the array and draws it.

const TRACE_KEY = "readAloudTraces";
const runsEl = document.getElementById("runs");
const msgEl = document.getElementById("msg");

let traces = [];

function say(text, isError) {
  msgEl.textContent = text || "";
  msgEl.style.color = isError ? "#dc2626" : "#6b7280";
}

async function load() {
  const stored = await chrome.storage.local.get({ [TRACE_KEY]: [] });
  traces = Array.isArray(stored[TRACE_KEY]) ? stored[TRACE_KEY] : [];
  render();
}

function outcomeBadge(trace) {
  const failed = trace.events?.some((e) => e.ok === false);
  const outcome = trace.outcome || (failed ? "error" : "incomplete");
  const cls = failed || outcome === "error" ? "bad" : outcome === "ended" || outcome === "playing" ? "ok" : "neutral";
  return `<span class="badge ${cls}">${escapeHtml(outcome)}</span>`;
}

function escapeHtml(v) {
  return String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function renderRun(trace, index) {
  const when = new Date(trace.startedAt || Date.now()).toLocaleTimeString();
  const engine = trace.engine || "-";
  const lang = trace.targetLang || "off";
  const rows = (trace.events || [])
    .map((e) => `
      <tr class="${e.ok === false ? "failed" : ""}">
        <td class="t">${e.t}ms</td>
        <td class="stage">${escapeHtml(e.stage)}</td>
        <td class="ctx">${escapeHtml(e.ctx || "")}</td>
        <td class="dur">${e.durationMs !== undefined ? e.durationMs + "ms" : ""}</td>
        <td class="${e.error ? "err" : "data"}">${
          e.error ? escapeHtml(e.error) : e.data ? escapeHtml(JSON.stringify(e.data)) : ""
        }</td>
      </tr>`)
    .join("");

  return `
    <div class="run" data-index="${index}">
      <div class="run-head">
        <span class="when">${escapeHtml(when)}</span>
        <span class="what">${escapeHtml(trace.trigger || "run")} &middot; ${escapeHtml(lang)} &middot; ${escapeHtml(engine)}</span>
        ${outcomeBadge(trace)}
        <span class="meta">${trace.durationMs ?? 0}ms &middot; ${(trace.events || []).length} stages &middot; ${escapeHtml(trace.origin || "-")}</span>
      </div>
      <div class="run-body" ${index === 0 ? "" : "hidden"}>
        <table>
          <thead><tr><th>t</th><th>stage</th><th>where</th><th>took</th><th>detail</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>`;
}

function render() {
  if (!traces.length) {
    runsEl.innerHTML = `<p class="empty">No runs recorded yet. Highlight some text, open the popup and click Read Selection, then come back and hit Refresh.</p>`;
    return;
  }
  // Newest first. The stored array is append-ordered, so reverse a copy.
  const ordered = [...traces].reverse();
  runsEl.innerHTML = ordered.map(renderRun).join("");
  runsEl.querySelectorAll(".run-head").forEach((head) => {
    head.addEventListener("click", () => {
      const body = head.parentElement.querySelector(".run-body");
      body.hidden = !body.hidden;
    });
  });
}

function latest() {
  return traces.length ? traces[traces.length - 1] : null;
}

async function copy(value, label) {
  try {
    await navigator.clipboard.writeText(JSON.stringify(value, null, 2));
    say(`${label} copied to clipboard.`);
  } catch (e) {
    say(`Could not copy: ${e?.message || e}`, true);
  }
}

document.getElementById("copyLatest").addEventListener("click", () => {
  const t = latest();
  if (!t) return say("Nothing recorded yet.", true);
  copy(t, "Latest run");
});

document.getElementById("copyAll").addEventListener("click", () => {
  if (!traces.length) return say("Nothing recorded yet.", true);
  copy(traces, `All ${traces.length} runs`);
});

// A real file, which the popup could not offer: the extension has no
// "downloads" permission, but an extension page can hand the browser a blob
// URL through a normal download link.
document.getElementById("download").addEventListener("click", () => {
  if (!traces.length) return say("Nothing recorded yet.", true);
  const blob = new Blob([JSON.stringify(traces, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `read-aloud-traces-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  say("Downloaded.");
});

document.getElementById("refresh").addEventListener("click", async () => {
  await load();
  say(`${traces.length} run${traces.length === 1 ? "" : "s"} loaded.`);
});

document.getElementById("clear").addEventListener("click", async () => {
  await chrome.storage.local.set({ [TRACE_KEY]: [] });
  await load();
  say("Cleared.");
});

// Live-update while a read is happening in another tab, so the page doesn't
// have to be reloaded to watch a run land.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes[TRACE_KEY]) return;
  traces = Array.isArray(changes[TRACE_KEY].newValue) ? changes[TRACE_KEY].newValue : [];
  render();
});

load();
