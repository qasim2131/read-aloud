const grantBtn = document.getElementById("grantBtn");
const statusEl = document.getElementById("status");
const manualSteps = document.getElementById("manualSteps");

// Set by popup.js when it sends the user here instead of opening a new tab:
// the page they were on, so this tab can return to it once access is
// granted instead of leaving them stranded on this permission page.
const returnUrl = new URLSearchParams(location.search).get("return");

grantBtn.addEventListener("click", async () => {
  statusEl.textContent = "Requesting...";
  statusEl.style.color = "#6b7280";
  manualSteps.hidden = true;

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((track) => track.stop());

    // Best-effort: reopen the extension's own popup right away so Voice to
    // Text can pick up (via popup.js's pendingAutoListen flag) and start
    // listening with no extra click. Only works within the user gesture that
    // started this click, and only on Chrome versions that support it - if
    // it's unavailable or refused, the user just clicks the extension icon
    // themselves, exactly as before.
    let popupOpened = false;
    if (chrome.action?.openPopup) {
      try {
        await chrome.action.openPopup();
        popupOpened = true;
      } catch (e) {
        popupOpened = false;
      }
    }

    statusEl.textContent = popupOpened
      ? "Microphone allowed. Starting Voice to Text..."
      : "Microphone allowed. Click the extension icon to use Voice to Text.";
    statusEl.style.color = "#16a34a";

    if (returnUrl) {
      setTimeout(() => { location.href = returnUrl; }, popupOpened ? 400 : 1600);
    }
  } catch (e) {
    statusEl.textContent = "Still blocked. Allow it manually instead:";
    statusEl.style.color = "#dc2626";
    manualSteps.hidden = false;
  }
});
