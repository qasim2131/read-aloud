# Urdu Voice Installer

Lets someone who has never touched this project self-install local Urdu
text-to-speech (Piper) with no Terminal - download a `.pkg`, double-click it,
done. This is what the popup's "Download Urdu voice" button (shown only when
Urdu is selected and Piper isn't detected - see `checkPiperHostAvailable()`
in `piperTts.js`) sends people to, via `install-urdu-voice.html`.

## Why this exists as a separate installer, not just a copy of native-host/

`native-host/README.md` documents how Piper was set up **on this specific
dev machine** - hardcoded paths under this one username, files kept outside
this repo, and a `pip install piper-tts` the developer ran by hand in
Terminal. That's fine for one machine one developer controls. It's not
something to hand a random user of the extension - they don't have Terminal
open, don't know what a native messaging host is, and shouldn't need to.

This installer automates that exact setup for **any** Mac:
- `pip3 install --user piper-tts` (real PyPI package, prebuilt wheels for
  both Intel and Apple Silicon Mac, Python >=3.9 - verified against PyPI's
  own release metadata, not assumed)
- downloads the Urdu voice model directly from its official home,
  `https://huggingface.co/rhasspy/piper-voices` - not redistributed by us,
  so there's no copy of a 62MB model file sitting in this git repo
- writes a **portable** copy of `piper_host.py` (this directory's own copy,
  not `native-host/`'s) that finds the `piper` binary at runtime instead of
  a hardcoded path
- registers it with Chrome via the standard NativeMessagingHosts manifest,
  with `allowed_origins` pinned to this extension's fixed ID
  (`gpncnfknakbagdfncceheadkndbgpicm`, from `manifest.json`'s `"key"` -
  stable for anyone who loads this exact repo, unpacked or packed)

Once installed, the extension's own live check
(`checkPiperHostAvailable()` in `piperTts.js`, a cheap `PING` to the host -
see that file) picks it up automatically - no extension code needs to know
or care that Piper was set up by this installer rather than by hand.

**One step this can't remove:** Chrome only reads the NativeMessagingHosts
manifest at its own startup, so the user has to quit and reopen Chrome once
after installing. `install-urdu-voice.html` says this explicitly.

## Verified, not assumed

Before wiring this into the extension, the actual script was run end to end
against an isolated fake `$HOME` (so it never touched this dev machine's real,
already-working Piper setup) and confirmed to:
- genuinely `pip install` piper-tts (prebuilt wheel, no compile step)
- genuinely download both the Urdu model and its config from Hugging Face
  (the download step originally used the wrong remote filename -
  `ur_PK-fasih-medium-model.onnx` doesn't exist on Hugging Face, the real
  name is `ur_PK-fasih-medium.onnx` - caught by actually running it, not by
  reading the code)
- write a working, portable `piper_host.py` and a correct native messaging
  manifest
- and that the resulting `piper_host.py`, run standalone exactly as Chrome
  would invoke it, responds to `PING` and to a real `SYNTHESIZE` call with a
  valid, playable WAV file

What this harness **cannot** verify (same category as the mic-permission
native dialog elsewhere in this project - no CDP/automation can reach it):
running the actual `.pkg` through macOS's real Installer.app UI, the
Gatekeeper right-click-Open bypass, and the admin password prompt. Those need
a real person clicking through a real installer on a real Mac.

## Building the `.pkg`

```bash
./build.sh
```

Produces `ReadAloudUrduVoiceInstaller.pkg` in this directory. It's a
`--nopayload` package - it installs no files to any hardcoded location itself
- everything happens in `postinstall`, which runs `install_piper_urdu.py`.

### Why `postinstall` re-runs as a different user

macOS always runs `.pkg` postinstall scripts as **root**. Our actual work -
`pip install --user`, writing into `~/Library/...` - has to happen as the
**logged-in user**, or everything lands under `/var/root` where the user's
own Chrome will never see it. `postinstall` looks up the console user via
`stat -f%Su /dev/console` and re-runs the Python installer as them with
`sudo -u`, explicitly setting `HOME` (root's `sudo -u` does not reliably fix
`$HOME` on its own).

### Unsigned installer - the one manual step that's unavoidable for now

This `.pkg` is **not code-signed or notarized** (no Apple Developer ID yet -
that's a $99/year account). Any unsigned software downloaded through a
browser gets a `com.apple.quarantine` flag, and Gatekeeper blocks a plain
double-click with "cannot be opened because it is from an unidentified
developer." The fix is one click, not Terminal: **right-click the file,
choose Open, click Open again in the dialog that follows.** This is standard
for any unsigned Mac software, not specific to this installer -
`install-urdu-voice.html` already says so.

**Once there's a Developer ID:** sign and notarize with
```bash
codesign --sign "Developer ID Installer: NAME (TEAMID)" ReadAloudUrduVoiceInstaller.pkg
xcrun notarytool submit ReadAloudUrduVoiceInstaller.pkg --apple-id ... --team-id ... --wait
xcrun stapler staple ReadAloudUrduVoiceInstaller.pkg
```
after which the Gatekeeper warning disappears entirely and step 2 in
`install-urdu-voice.html` can be deleted.

## Publishing

1. `./build.sh` to produce `ReadAloudUrduVoiceInstaller.pkg`.
2. Create a GitHub Release on the project's repo (any tag, e.g. `v1.0`) and
   upload the `.pkg` as a release asset.
3. Copy that asset's direct download URL (the one under
   `github.com/<owner>/<repo>/releases/download/<tag>/...`, not the release
   page itself).
4. Paste it into `INSTALLER_DOWNLOAD_URL` at the top of
   `../install-urdu-voice.js`, replacing the `REPLACE_WITH_...` placeholder.
   Until that placeholder is replaced, the page correctly shows "The
   installer isn't published yet" instead of a broken link - verified live.
5. Reload the extension. No other file needs to change.

## If the Urdu model or Piper's PyPI package ever move

- Model URL is `MODEL_BASE_URL` / `MODEL_REMOTE_FILENAME` /
  `CONFIG_REMOTE_FILENAME` at the top of `pkgroot/scripts/install_piper_urdu.py`.
- `pip install piper-tts` has no version pinned deliberately - Piper's own
  releases already handle backward compatibility for the model format.
