# Read Aloud - Chrome Extension

Reads highlighted text aloud using Chrome's built-in Web Speech API (`speechSynthesis`),
and can also turn your speech into written text using Chrome's built-in speech
recognition. Use the "Read Aloud" / "Voice to Text" switch at the top of the popup to
pick which one you want.

## Features
- **Read Aloud**: right-click any highlighted text -> "Read Selected Text Aloud"
  - One button: "Read Selection" when idle, becomes "Stop Reading" while it's playing
  - Adjustable reading speed (0.5x-2x), remembered between uses, and changes the rate
    of speech that's already playing - no need to click Read Selection again
  - Voice picker, populated from your system's installed voices
  - Fully offline - no network calls, no API keys
  - The button automatically resets when speech finishes on its own, not just when you
    click Stop
  - Optional "Translate to" - pick a language and translates highlighted text before
    reading it (auto-matches an installed voice for that language when one exists -
    shows which voice, or warns if none is installed, right under the picker). Applies
    to "Read Selection" and the right-click menu - both explicit actions. Uses a free
    translation lookup (Google's endpoint, falling back to MyMemory if that one is
    rate-limiting) - needs internet either way. Times out after 8 seconds and reads the
    original text instead of hanging if translation is slow or fails. Off by default.
  - **When "Translate to" is set, the popup does not auto-read on open.** It shows
    `Click "Read Selection" to read this in <language>.` and waits. It deliberately
    never auto-translates - that would send your selected text to a translation service
    with no action from you - but auto-reading the *untranslated* original was worse:
    it flipped the button to "Stop Reading" before you touched anything, so your first
    click was taken as Stop and the translation never ran at all. With "Translate to"
    off, auto-read-on-open behaves as it always did.
  - The voice used for a translated language comes entirely from what your OS has
    installed - if macOS has no voice for that language at all, it falls back to your
    default (usually English) voice, which generally can't pronounce non-Latin scripts
    (Urdu, Arabic, Chinese, etc. use their own script) - only script-independent tokens
    like plain digits ("1914") come through clearly, so it can sound like it reads one
    number and goes silent rather than actually reading the sentence. If macOS *does*
    have a voice for that language but only in a different regional accent, that's what
    you'll hear instead; there's no free way to pick a specific country's accent beyond
    what the OS ships. On macOS: System Settings -> Accessibility -> Spoken Content ->
    System Voice -> Manage Voices to see what's available to add. The popup shows which
    case you're in, live, right under "Translate to."
  - **Urdu specifically** no longer depends on having a local system voice installed:
    when none exists, it automatically synthesizes speech using your own local
    [Piper](https://github.com/OHF-voice/piper1-gpl) installation instead of reading
    with the wrong voice - fully offline, no account, no API key, no server. See
    `native-host/README.md` for how the local integration is set up (it uses Chrome's
    Native Messaging to talk to a small Python host script that runs Piper directly on
    your Mac). If Piper fails (not installed, model files missing, or it errors), the
    popup shows a clear error and does not fall back to reading with the wrong voice.
    **If Piper isn't installed at all**, selecting Urdu shows "Urdu voice needs to be
    installed to use Urdu translation." with a one-click "Download Urdu voice" button -
    this checks live (a cheap ping to the native host) rather than assuming, so it
    never shows for anyone who already has it working. That button downloads a real,
    self-contained macOS installer (no Terminal) - see `installer/BUILD.md` for how
    it's built and published, and `installer/pkgroot/scripts/install_piper_urdu.py`
    for what it actually does on the user's machine.
    This only changes behavior for languages with no local voice *and* a Piper voice
    configured (currently just Urdu) - every other language is unchanged. The
    right-click menu takes the same Piper fallback: before, it translated to Urdu and
    then handed that text to an English voice, which can't pronounce Arabic script, so
    it read a stray digit and went quiet.
    Piper's audio is played from an **offscreen document** (`offscreen.html`), which is
    a page owned by the extension rather than by the website. That matters: a content
    script shares the *page's* Content-Security-Policy when it loads media, so on any
    site that sends something like `media-src 'self'` the generated WAV was silently
    blocked and Urdu simply never played - which is why it used to work on some pages
    and not others, while languages using `speechSynthesis` (which no page policy can
    touch) worked everywhere. Playing it outside the page removes that entirely.
  - Changing "Translate to" *while something is already playing* switches languages
    live: it works out roughly how far in you are and re-reads from the next sentence
    in the new language instead of starting the selection over. Sentence-level, not
    word-level - translations don't preserve word order or count between languages, so
    an exact word position doesn't survive the switch.
- **Diagnostics**: every Read Selection run is traced end to end under a single
  id - button click, selection, translation (including *which* free endpoint
  answered and with what HTTP status), voice choice, each Piper native-host call,
  the host's own timings, audio byte sizes, `play()` and playback start/end/stop -
  each with a timestamp, a duration and the exact error if it failed. The
  "Diagnostics" link at the bottom of the popup opens a page showing the last 20
  runs, with "Copy latest as JSON" and a `.json` download.
  - **It records no text.** Not the selected text, not the translation, not your
    transcript, and no URL path or query - only counts (`"chars": 122`), the
    chosen voice, and the page's bare origin (`https://example.com`), which is
    what makes a per-site failure like the CSP one above diagnosable at all.
  - `subprocessMs` in a trace is the whole Piper process: spawn, loading the
    voice model, and synthesis. Piper reports no separate model-load timing, and
    its only load-related output echoes the input text and phonemes to stderr -
    not something worth putting in a file you might share, so the two stay
    merged. Chrome starts a fresh Piper process per chunk, so that cost is paid
    every chunk, which a trace makes obvious.
  - Always on, rolling buffer of the last 20 runs in `chrome.storage.local`.
    Tracing that has to be switched on first is off the one time the bug happens.
- **Voice to Text**: click "Start Listening", talk, see the words appear live
  - English only for now (US, UK, Australia, Canada, India - pick from the Language menu)
  - Needs an internet connection - unlike Read Aloud, Chrome sends the audio to
    Google's servers to transcribe it. Still free, just not offline.
  - Editable transcript with Undo/Redo, "Revert" (back to exactly what was transcribed,
    discarding your edits), "Clear", and "Copy"
  - Automatically restarts listening if Chrome's recognition session ends on its own
    mid-sentence (a real Chrome quirk on longer recordings) - without this, whatever
    you said during that silent gap would be lost

## Install (Load unpacked)
1. Open `chrome://extensions` in Chrome.
2. Turn on "Developer mode" (top-right toggle).
3. Click "Load unpacked" and select this `read-aloud-extension` folder.
4. Tabs that were already open before you loaded the extension work too - you do
   *not* need to refresh them. Chrome only injects declared content scripts into
   pages loaded after the extension, so the popup detects a tab with no content
   script and injects one on demand before retrying. (Before this, such a tab would
   fail at everything at once - no reading, an empty Voice dropdown, and translation
   errors - which looked like three separate bugs.)

## Usage
- Highlight text, right-click it, choose "Read Selected Text Aloud". Or:
- Highlight text, click the extension icon, then click "Read Selection".
- Moving the Speed slider updates reading speed live, even mid-sentence.
- Voice to Text: click the "Voice to Text" switch, pick your English variant, click
  "Start Listening", talk, then "Copy" the transcript, "Clear" it, or edit it directly
  and use Undo/Redo/Revert as needed.
- **First time using Voice to Text**: Chrome extension popups cannot show the
  microphone permission prompt at all (a Chrome platform limitation, not a bug here).
  If you see "Microphone blocked," click "Allow microphone in a new tab" right below
  that message - it opens a normal tab where Chrome's permission prompt works properly.
  Click "Allow Microphone" there once; after that, the popup works normally, since the
  permission is remembered for the extension regardless of which of its pages asks.
  If that page also says blocked, it shows the exact `chrome://settings/content/microphone`
  steps to allow it manually.

## Notes
- Voices come from your OS. On macOS, more can be added under System Settings ->
  Accessibility -> Spoken Content.
- Won't run on `chrome://` pages or the built-in PDF viewer - that's a Chrome platform
  restriction for all extensions, not specific to this one.
- No icon files are bundled, so Chrome shows a generic icon in the toolbar. Drop in
  `icon16.png` / `icon48.png` / `icon128.png` and add an `"icons"` entry to
  `manifest.json` if you want a custom one.
