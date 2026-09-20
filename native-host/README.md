# Piper Native Messaging Host

Lets the extension use your local Piper installation for Urdu speech when no
system voice for Urdu exists, via [Chrome Native
Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging) -
no network call, no account, no API key.

**This document is about the one, specific dev machine this was first set up
on** - hardcoded paths, set up by hand in Terminal. For how any *other* user
installs this with a double-click and no Terminal, see `../installer/BUILD.md`
instead - that's what the popup's own "Download Urdu voice" button uses.

## Why the actual script lives outside this folder

**The real `piper_host.py`, its log, and the Urdu model files are at
`~/Library/Application Support/ReadAloudPiperHost/` - not in this folder.**
This folder (`native-host/`) only keeps a reference copy of the host
manifest and this README.

Reason, confirmed via macOS's own unified log (`log show`), not guessed: when
Chrome spawns a native messaging host, that host runs as a distinct child
process with no relation to Chrome's own file access. This whole project
lives under `~/Desktop/Desktop/code/...` - nested inside `~/Desktop`, one of
macOS's TCC-protected special folders (Desktop, Documents, Downloads,
Pictures, etc.). Chrome itself can read `~/Desktop/...` fine, because you
granted that implicitly through the "Load unpacked" file picker (a
security-scoped bookmark tied to Chrome's own process) - but that grant does
not extend to a separate process Chrome spawns. The result, seen directly in
the log:
```
kernel[0:...] (Sandbox) System Policy: Python(...) deny(1) file-read-data
  .../read-aloud-extension/native-host/piper_host.py
```
The sandbox denies the native host process permission to even *read* the
script - it never executes a single line, which is why a startup log placed
inside the script never got written. The same would happen to the Urdu model
files, which originally lived in `~/Downloads` (also TCC-protected). Moving
both the script and the models to `~/Library/Application Support/` - which
isn't one of the protected special folders - avoids the restriction
entirely, for good, with no macOS permission prompt to grant or maintain.

- `piper_host.py` (at the real location above) - reads a length-prefixed
  JSON message from stdin (`{"type": "SYNTHESIZE", "text": "...", "rate":
  1.0}`), runs your local Piper binary against the Urdu model, and writes
  the resulting audio back the same way.
- `piper_host.log` (next to it, same real location) - written on every run.
  Chrome gives the extension no visibility into *why* a native host process
  died beyond "Native host has exited" - this file has the real reason
  (a Python traceback, or which startup check failed) every time.
- `com.readaloud.piper_tts.json` (in *this* folder) - the host manifest, kept
  here for reference. The one Chrome actually reads is installed at
  `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.readaloud.piper_tts.json`
  (already done for you), and its `"path"` field points at the real
  `piper_host.py` location above.
- The private key behind `manifest.json`'s `"key"` field lives at
  `../../read-aloud-extension-keys/extension_key.pem` - deliberately **outside**
  this extension folder (Chrome itself warns if a `.pem` file sits inside a
  loaded extension's directory). It pins the extension's ID
  (`gpncnfknakbagdfncceheadkndbgpicm`) so it doesn't change if Chrome
  re-derives it differently - the host manifest's `allowed_origins` only
  trusts that exact ID. Moving or deleting that file has no effect on the ID
  itself (which comes from the public key already embedded in
  `manifest.json`); it's only kept around in case the key ever needs
  re-deriving from scratch. You don't need to do anything with it.

Hardcoded paths (edit both the real `piper_host.py` and the installed host
manifest's `path` if any of these change):
- Piper binary: `/Users/m1pro16-1tb/Library/Python/3.9/bin/piper` (unaffected
  by the above - `~/Library` isn't a TCC-protected special folder)
- Model + config: co-located with `piper_host.py` in
  `~/Library/Application Support/ReadAloudPiperHost/`

## Why text gets split into chunks, and why that split happens in the extension, not the host

Piper's `ur_PK-fasih-medium` model outputs 22.05kHz mono 16-bit WAV, which
runs about 3KB per character of input text at normal speed. Chrome native
messaging has a real limit on how large a single message can be.

**Confirmed by an actual failure (2026-09-14):** an earlier version had the
*host* split text into chunks, synthesize each one, and bundle all of them
into a single response. For one real paragraph (~750 characters) that
produced a **3.3MB combined response**, and Chrome's native messaging
transport rejected it with "Error when communicating with the native
messaging host." Bounding each chunk's size wasn't enough - the total after
bundling still blew past the limit.

The fix: `piperTts.js` (in the extension) now does the chunking - splitting
translated text on sentence boundaries (falling back to a word-boundary
split if there's no punctuation at all) into pieces of at most 130
characters - and makes one separate `sendNativeMessage` call per chunk, each
producing its own small response (confirmed comfortably under 1MB per
message in testing). `piper_host.py` synthesizes exactly one chunk per call
and returns a single `audioBase64` string - it no longer does any splitting
itself, and rejects (with a clear error, not a crash) anything longer than
220 characters as a backstop against a caller bug. The extension plays the
resulting chunks back-to-back in **`offscreen.js`** as one continuous read -
you won't hear a gap, but very long selections take a few extra seconds to
start since Piper runs once per chunk, sequentially, before playback can
begin.

Playback deliberately does *not* happen in `content.js` any more. A content
script loads media under the **web page's** Content-Security-Policy, so on any
site sending `media-src 'self'` (or a `default-src` that covers it) the
`data:audio/wav` URL was blocked outright - Chrome logs `Loading media from
'data:audio/wav;base64,...' violates the following Content Security Policy
directive` on the page, and the popup still cheerfully said "Reading". That is
what made Urdu play on some sites and stay silent on others. The offscreen
document is an extension-owned page, so no site's policy applies to it.

## Diagnostic timings in the response (added later)

`piper_host.py` now returns two extra fields alongside `audioBase64`, and
echoes back any `traceId` the extension sent:

```json
{ "audioBase64": "...", "traceId": "ra-...",
  "timings": { "hostStartupMs": 1, "subprocessMs": 894, "exitCode": 0,
               "wavBytes": 100396, "stderrBytes": 0, "piperErrorType": null } }
```

These are **additive** - the `audioBase64` / `error` contract is unchanged, so a
caller that ignores them behaves exactly as before. They feed the extension's
trace viewer (the "Diagnostics" link in the popup).

`subprocessMs` covers spawn + ONNX model load + synthesis together. piper gives
no separate load timing, and its `--debug` output echoes the input text and its
phonemes to stderr - which must never reach a trace - so the split isn't worth
buying. For the same reason the response carries only `stderrBytes` and an
error *type* (`RuntimeError`), never stderr's text: piper can quote the input
back in its messages. Full stderr still goes to `piper_host.log` on failure,
which stays on this machine.

**If you replace this file, don't paste back a pre-timings copy** - the
extension tolerates their absence (the trace simply shows no host row), but
you lose the only view into where Piper's time actually goes.

**If you ever see "Error when communicating with the native messaging
host" again**, check whether `MAX_CHARS_PER_CHUNK` in `piperTts.js` or
`MAX_CHARS_HARD_LIMIT` in `piper_host.py` got changed independently of each
other, or whether something reintroduced bundling multiple chunks into one
response - both were the exact cause here.

## Reload after any change

Chrome only reads the native messaging host manifest when it starts (or
sometimes not until you fully quit and reopen Chrome, not just reload the
extension). If you edit paths here, fully quit and restart Chrome, not just
reload the extension.

## Test the host directly, without Chrome

```bash
python3 -c "
import subprocess, struct, json, sys, base64, os
HOST = os.path.expanduser('~/Library/Application Support/ReadAloudPiperHost/piper_host.py')
proc = subprocess.Popen([HOST], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
msg = json.dumps({'type': 'SYNTHESIZE', 'text': 'یہ ایک ٹیسٹ ہے', 'rate': 1.0}).encode()
proc.stdin.write(struct.pack('<I', len(msg))); proc.stdin.write(msg); proc.stdin.flush()
length = struct.unpack('<I', proc.stdout.read(4))[0]
resp = json.loads(proc.stdout.read(length))
if 'error' in resp:
    print('ERROR:', resp['error'])
else:
    with open('/tmp/piper_test_out.wav', 'wb') as f:
        f.write(base64.b64decode(resp['audioChunksBase64'][0]))
    print('wrote /tmp/piper_test_out.wav - play it to confirm audio')
"
```

If this works but the extension still can't reach Piper, the issue is almost
always the native messaging host manifest (wrong path, wrong extension ID in
`allowed_origins`, or Chrome not yet restarted after it was installed) rather
than Piper itself.

## Troubleshooting

- **"Specified native messaging host not found"** - the host manifest isn't
  in Chrome's `NativeMessagingHosts` folder, or its `name` doesn't match
  `com.readaloud.piper_tts` exactly, or Chrome hasn't been restarted since it
  was added.
- **"Access to the specified native messaging host is forbidden"** - the
  extension's actual ID doesn't match `allowed_origins` in the host manifest.
  Check `chrome://extensions` (with Developer mode on) for the loaded ID and
  compare it to `gpncnfknakbagdfncceheadkndbgpicm`. It should match exactly,
  since `manifest.json` pins it via the `"key"` field - if it doesn't, the
  extension wasn't loaded from this exact `read-aloud-extension` folder, or
  `manifest.json`'s `"key"` field got reverted.
- **"Native host has exited" (host launched but died before responding)** -
  check `~/Library/Application Support/ReadAloudPiperHost/piper_host.log`
  first, not `stderr` - Chrome doesn't surface the host's stderr to the
  extension at all, so that log file is the only place a startup exception
  or crash actually shows up. Every run logs the resolved Python
  interpreter, and whether `PIPER_BIN`/`MODEL_PATH`/`CONFIG_PATH` exist,
  before doing anything else.
  - **Log file is empty or missing entirely** after a failed attempt -
    the process never reached Python code at all. On 2026-09-14 this was
    confirmed (via `log show`, not guessed) to be the macOS Sandbox denying
    the native host process read access to a script living under a
    TCC-protected folder (`~/Desktop`, `~/Documents`, `~/Downloads`, etc.) -
    see "Why the actual script lives outside this folder" above. If this
    ever moves back under one of those folders, the exact same failure
    returns.
  - **Log file has entries but stops partway through** - that's exactly
    where it died; the next line explains why (a Piper error, a missing
    file, an exception with a full traceback).
- Run the direct test above as a sanity check outside Chrome entirely - if
  that also fails, the problem is Piper/paths, not native messaging itself.
