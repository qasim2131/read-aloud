// Update this once the installer is published as a GitHub Release asset -
// see installer/BUILD.md for the exact steps (build the .pkg, create a
// release, upload it, paste its asset URL here). Left as a placeholder so a
// forgotten update fails obviously (a disabled button + a clear message)
// instead of silently 404ing when someone clicks Download.
const INSTALLER_DOWNLOAD_URL = "REPLACE_WITH_GITHUB_RELEASE_ASSET_URL";

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
