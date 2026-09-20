#!/usr/bin/env python3
"""Installs local Urdu text-to-speech support for the Read Aloud extension.

Run by the .pkg installer's postinstall script, as the logged-in user (not
root) - see ../../BUILD.md for why. Safe to run more than once: every step
either overwrites its own output or skips work that's already done.

What it does, in order:
  1. pip-installs piper-tts (the TTS engine itself) for this user.
  2. Downloads the Urdu voice model from its official Hugging Face repo.
  3. Writes a portable native-messaging host script next to the model.
  4. Registers that host with Chrome via the NativeMessagingHosts manifest.

No text ever leaves this machine at any step - the model is a static file
download, and the host script it writes talks to Chrome only over stdio.
"""
import json
import os
import shutil
import subprocess
import sys
import urllib.request

EXTENSION_ID = "gpncnfknakbagdfncceheadkndbgpicm"  # fixed by manifest.json's "key"
HOST_NAME = "com.readaloud.piper_tts"

INSTALL_DIR = os.path.expanduser("~/Library/Application Support/ReadAloudPiperHost")
LOG_PATH = os.path.join(INSTALL_DIR, "install.log")

MODEL_BASE_URL = "https://huggingface.co/rhasspy/piper-voices/resolve/main/ur/ur_PK/fasih/medium"
# Hugging Face's actual filenames (verified against the live repo) - note no
# "-model" in either. The LOCAL filenames below deliberately keep "-model" to
# match what native-host/piper_host.py (the dev copy) and the generic
# PIPER_HOST_SCRIPT below both already expect on disk - only the download
# source differs from the on-disk name.
MODEL_REMOTE_FILENAME = "ur_PK-fasih-medium.onnx"
CONFIG_REMOTE_FILENAME = "ur_PK-fasih-medium.onnx.json"
MODEL_FILENAME = "ur_PK-fasih-medium-model.onnx"
CONFIG_FILENAME = "ur_PK-fasih-medium-model.onnx.json"

NATIVE_HOST_MANIFEST_DIR = os.path.expanduser(
    "~/Library/Application Support/Google/Chrome/NativeMessagingHosts"
)

# Written to INSTALL_DIR as piper_host.py. Kept in sync BY HAND with the
# repo's own native-host/piper_host.py - see BUILD.md. The one difference
# from that dev copy: PIPER_BIN is resolved at runtime (find_piper_binary())
# instead of a hardcoded path, since this copy has to work on any machine.
PIPER_HOST_SCRIPT = r'''#!/usr/bin/env python3
import sys
import struct
import json
import subprocess
import base64
import tempfile
import os
import datetime
import re
import time
import shutil
import glob
import traceback

HOST_START = time.time()
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
LOG_PATH = os.path.join(SCRIPT_DIR, "piper_host.log")

MODEL_PATH = os.path.join(SCRIPT_DIR, "ur_PK-fasih-medium-model.onnx")
CONFIG_PATH = os.path.join(SCRIPT_DIR, "ur_PK-fasih-medium-model.onnx.json")

SYNTH_TIMEOUT_SECONDS = 30
MAX_CHARS_HARD_LIMIT = 220


def log(msg):
    try:
        with open(LOG_PATH, "a", encoding="utf-8") as f:
            f.write(f"[{datetime.datetime.now().isoformat()}] {msg}\n")
    except Exception:
        pass


def find_piper_binary():
    """Locates the piper executable pip installed for this user. Not a fixed
    path (unlike the dev copy of this file) because this copy has to work on
    whatever machine the installer ran on - pip's user-install bin directory
    differs by Python version and OS."""
    on_path = shutil.which("piper")
    if on_path:
        return on_path
    home = os.path.expanduser("~")
    candidates = [
        os.path.join(home, ".local", "bin", "piper"),
        *glob.glob(os.path.join(home, "Library", "Python", "*", "bin", "piper")),
    ]
    for c in candidates:
        if os.path.isfile(c) and os.access(c, os.X_OK):
            return c
    return None


def log_startup_diagnostics():
    log("=== piper_host.py starting (portable/installed copy) ===")
    log(f"sys.executable: {sys.executable}")
    log(f"sys.version: {sys.version.replace(chr(10), ' ')}")
    piper_bin = find_piper_binary()
    log(f"resolved PIPER_BIN={piper_bin}")
    log(f"MODEL_PATH={MODEL_PATH} exists={os.path.isfile(MODEL_PATH)}")
    log(f"CONFIG_PATH={CONFIG_PATH} exists={os.path.isfile(CONFIG_PATH)}")


def read_message():
    raw_length = sys.stdin.buffer.read(4)
    if len(raw_length) == 0:
        log("stdin closed (EOF) - exiting normally")
        sys.exit(0)
    message_length = struct.unpack("<I", raw_length)[0]
    message_bytes = sys.stdin.buffer.read(message_length)
    return json.loads(message_bytes.decode("utf-8"))


def send_message(message_dict):
    encoded = json.dumps(message_dict).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(encoded)))
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()


def _error_type(stderr):
    for match in re.finditer(r"\b([A-Za-z_][A-Za-z0-9_]*(?:Error|Exception))\b", stderr or ""):
        return match.group(1)
    return None


def synthesize_chunk(text, length_scale, piper_bin):
    fd, wav_path = tempfile.mkstemp(suffix=".wav")
    os.close(fd)
    try:
        subprocess_started = time.time()
        result = subprocess.run(
            [piper_bin, "-m", MODEL_PATH, "-c", CONFIG_PATH,
             "--length-scale", str(length_scale), "-f", wav_path],
            input=text.encode("utf-8"),
            capture_output=True,
            timeout=SYNTH_TIMEOUT_SECONDS,
        )
        subprocess_ms = int((time.time() - subprocess_started) * 1000)
        stderr = result.stderr.decode("utf-8", "replace")
        if result.returncode != 0:
            raise RuntimeError(f"Piper exited with code {result.returncode}: {stderr[:500]}")
        with open(wav_path, "rb") as f:
            audio_bytes = f.read()
        if not audio_bytes:
            raise RuntimeError("Piper produced no audio output")
        timings = {
            "subprocessMs": subprocess_ms,
            "exitCode": result.returncode,
            "wavBytes": len(audio_bytes),
            "stderrBytes": len(stderr),
            "piperErrorType": _error_type(stderr),
        }
        return audio_bytes, timings
    finally:
        try:
            os.remove(wav_path)
        except OSError:
            pass


def handle_synthesize(msg, startup_ms):
    text = (msg.get("text") or "").strip()
    if not text:
        return {"error": "Empty text"}
    if len(text) > MAX_CHARS_HARD_LIMIT:
        return {"error": f"Text too long for one native-messaging call ({len(text)} chars, max {MAX_CHARS_HARD_LIMIT})"}
    rate = msg.get("rate") or 1.0
    try:
        rate = float(rate)
    except (TypeError, ValueError):
        rate = 1.0
    if rate <= 0:
        rate = 1.0
    length_scale = 1.0 / rate

    piper_bin = find_piper_binary()
    if not piper_bin:
        return {"error": "Piper executable not found - run the Read Aloud Urdu voice installer again"}
    if not os.path.isfile(MODEL_PATH) or not os.path.isfile(CONFIG_PATH):
        return {"error": f"Piper model files not found ({MODEL_PATH})"}

    try:
        audio_bytes, timings = synthesize_chunk(text, length_scale, piper_bin)
    except subprocess.TimeoutExpired:
        return {"error": f"Piper timed out after {SYNTH_TIMEOUT_SECONDS}s"}
    except Exception as e:
        return {"error": str(e)}

    timings["hostStartupMs"] = startup_ms
    response = {"audioBase64": base64.b64encode(audio_bytes).decode("ascii"), "timings": timings}
    trace_id = msg.get("traceId")
    if trace_id:
        response["traceId"] = trace_id
    return response


def main():
    log_startup_diagnostics()
    while True:
        try:
            msg = read_message()
        except SystemExit:
            raise
        except Exception as e:
            log("Failed to read/parse message:\n" + traceback.format_exc())
            send_message({"error": f"Failed to read message: {e}"})
            continue

        try:
            msg_type = msg.get("type") if isinstance(msg, dict) else None
            trace_id = msg.get("traceId") if isinstance(msg, dict) else None
            log(f"received message type={msg_type!r} traceId={trace_id!r}")
            if msg_type == "SYNTHESIZE":
                startup_ms = int((time.time() - HOST_START) * 1000)
                response = handle_synthesize(msg, startup_ms)
                send_message(response)
                if "error" in response:
                    log(f"SYNTHESIZE returned error: {response['error']}")
            elif msg_type == "PING":
                send_message({"pong": True})
            else:
                send_message({"error": f"Unknown message type: {msg_type}"})
        except Exception as e:
            log("Uncaught exception while handling message:\n" + traceback.format_exc())
            try:
                send_message({"error": f"Internal host error: {e}"})
            except Exception:
                log("Also failed to send the error response:\n" + traceback.format_exc())


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception:
        log("FATAL uncaught exception at top level:\n" + traceback.format_exc())
        raise
'''


def log(msg):
    print(msg, flush=True)
    try:
        os.makedirs(INSTALL_DIR, exist_ok=True)
        with open(LOG_PATH, "a", encoding="utf-8") as f:
            f.write(msg + "\n")
    except Exception:
        pass


def run_step(name, fn):
    log(f"--- {name} ---")
    try:
        fn()
        log(f"OK: {name}")
    except Exception as e:
        log(f"FAILED: {name}: {e}")
        raise


def install_piper_package():
    subprocess.run(
        [sys.executable, "-m", "pip", "install", "--user", "--upgrade", "piper-tts"],
        check=True,
    )


def download(url, dest):
    if os.path.isfile(dest) and os.path.getsize(dest) > 0:
        log(f"already have {dest}, skipping download")
        return
    tmp = dest + ".part"
    urllib.request.urlretrieve(url, tmp)
    os.replace(tmp, dest)


def download_model():
    os.makedirs(INSTALL_DIR, exist_ok=True)
    download(f"{MODEL_BASE_URL}/{MODEL_REMOTE_FILENAME}", os.path.join(INSTALL_DIR, MODEL_FILENAME))
    download(f"{MODEL_BASE_URL}/{CONFIG_REMOTE_FILENAME}", os.path.join(INSTALL_DIR, CONFIG_FILENAME))


def write_host_script():
    os.makedirs(INSTALL_DIR, exist_ok=True)
    host_path = os.path.join(INSTALL_DIR, "piper_host.py")
    with open(host_path, "w", encoding="utf-8") as f:
        f.write(PIPER_HOST_SCRIPT)
    os.chmod(host_path, 0o755)


def write_native_messaging_manifest():
    os.makedirs(NATIVE_HOST_MANIFEST_DIR, exist_ok=True)
    manifest = {
        "name": HOST_NAME,
        "description": "Read Aloud - local Piper TTS for Urdu",
        "path": os.path.join(INSTALL_DIR, "piper_host.py"),
        "type": "stdio",
        "allowed_origins": [f"chrome-extension://{EXTENSION_ID}/"],
    }
    manifest_path = os.path.join(NATIVE_HOST_MANIFEST_DIR, f"{HOST_NAME}.json")
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)


def main():
    log(f"Read Aloud Urdu voice installer starting as {os.environ.get('USER')}, HOME={os.path.expanduser('~')}")
    run_step("Installing Piper TTS engine (pip install --user piper-tts)", install_piper_package)
    run_step("Downloading Urdu voice model", download_model)
    run_step("Writing native-messaging host script", write_host_script)
    run_step("Registering host with Chrome", write_native_messaging_manifest)
    log("Done. Quit and reopen Chrome, then Urdu translation will use this voice automatically.")


if __name__ == "__main__":
    main()
