// Published via installer/BUILD.md's release process - repo
// github.com/qasim2131/read-aloud, release v1.0.
const INSTALLER_DOWNLOAD_URL = "https://github.com/qasim2131/read-aloud/releases/download/v1.0/ReadAloudUrduVoiceInstaller.pkg";

const downloadBtn = document.getElementById("downloadBtn");
const statusEl = document.getElementById("status");

if (INSTALLER_DOWNLOAD_URL.startsWith("REPLACE_WITH_")) {
  downloadBtn.setAttribute("aria-disabled", "true");
  downloadBtn.removeAttribute("href");
  statusEl.textContent = "The installer isn't published yet - check back soon.";
  statusEl.style.color = "#dc2626";
} else {
  downloadBtn.href = INSTALLER_DOWNLOAD_URL;
}
