<div align="center">

# cue

This is [NikosMav's contribution fork](https://github.com/NikosMav/cue) of
[Blueturboguy07/cue](https://github.com/Blueturboguy07/cue). It focuses on concise,
grounded conversational answers, configurable screen context, and reliable request
handling. Original authorship and the GPL-3.0-or-later license are preserved.
See [fork changes and validation](docs/fork-changes.md).

**An open-source AI copilot that floats over your screen — sees what you see, hears your meetings, and stays hidden from screen shares.**

A free, self-hosted alternative to Cluely. Bring your own AI key (OpenAI · Anthropic · Google Gemini · OpenAI-compatible endpoints).

<img src="docs/tutorial.png" width="620" alt="cue first-run tutorial" />

</div>

---

> [!IMPORTANT]
> **Please read this first.** cue tries to stay out of screen recordings/shares, but this is **best-effort, not guaranteed** — on macOS 15.4+ Apple can let modern capture tools see it anyway, on Windows 10 builds older than 2004 it degrades to a black box instead of true exclusion, and a phone camera always can. Using a hidden assistant during a **proctored exam, job interview, or recorded meeting** may break that platform's rules and, in some places, consent laws. cue is built for legitimate uses — your own notes, studying, accessibility, and practice. **You are responsible for how you use it.**

---

## What it does

cue floats a small glass panel on top of everything. It takes **three separate inputs** — your **screen**, your **microphone**, and your **meeting audio** (what the other person says) — and uses an AI model to help you in real time.

| Feature | How to trigger | What it uses |
|---|---|---|
| **Assist** | `⌘` `↵` (macOS) or `Ctrl` `Enter` (Windows), configurable | your screen + recent conversation |
| **What should I say?** | button | meeting audio + your mic |
| **Follow-up questions** | button | the whole conversation |
| **Recap** | button | the whole conversation |
| **Ask anything** | type + `↵` | your screen + conversation |
| **Solve a coding problem** | `⌘` `H` (macOS) or `Ctrl` `H` (Windows) | your screen only |
| **Smart** toggle | pill in the box | switches to a smarter (slower) model |

It's a copilot for **live meetings** ("what do I say to that?") and **coding problems** (screenshot → full solution), and it's designed to be **invisible in screen shares** so it stays your private assistant.

### Platform support

|  | macOS | Windows 11 / 10 2004+ |
|---|---|---|
| Screen + coding help | ✅ | ✅ |
| Your mic (the **You** channel) | ✅ | ✅ |
| Meeting audio (the **Them** channel) | ✅ macOS 14.4+ | ✅ |
| Hidden from screen shares | ⚠️ best-effort, weaker on macOS 15.4+ | ✅ `WDA_EXCLUDEFROMCAPTURE` |
| Permissions to grant | Microphone **and** Screen Recording | Microphone only |

> [!NOTE]
> **Meeting audio needs macOS 14.4+.** Capturing the *other* person — what powers **What should I say?**, **Follow-up questions**, and **Recap** — uses system-audio loopback. On Windows that works out of the box. On macOS it relies on ScreenCaptureKit, which cue enables through Chromium's `MacLoopbackAudioForScreenShare` and `MacSckSystemAudioLoopbackOverride` switches; on older macOS the *Them* channel stays silent while your screen and the **You** channel keep working.

---

## Install

Option A is the easiest on both platforms. Use Option B if you'd rather run from source.

### Option A — Download the app (easiest)

Go to the [**Releases**](../../releases) page, then choose your platform:

- **Windows 10/11 (x64):** download **`cue-win-x64.exe`**, run it, and launch cue from the Start menu. The installer is unsigned, so Windows SmartScreen may show an **Unknown publisher** warning.
- **macOS (Apple silicon):** download **`cue-…-arm64-mac.zip`**, unzip it, drag **`cue.app`** into **Applications**, and open it.

### Option B — Run from source (macOS or Windows)

You need [Node.js](https://nodejs.org) 22.12+ installed (required by dev dependencies). No Xcode and no Visual Studio build tools required — cue deliberately avoids native modules.

```bash
git clone https://github.com/NikosMav/cue.git
cd cue
npm install
npm start
```

That's the whole setup on Windows. There's no permission dance — grant the mic when Windows asks and you're done.

To build a standalone app:
```bash
npm run pack        # unpacked app in dist/ (either OS)
npm run pack:win    # unpacked Windows app -> dist/win-unpacked/cue.exe
npm run dist:mac    # macOS zip            -> dist/
npm run dist:win    # Windows installer    -> dist/cue-win-x64.exe
npm run dist:linux  # Linux x64 AppImage   -> dist/
```
> **macOS note:** the packaged app is **ad-hoc signed** unless a Developer ID certificate is configured. macOS ties permission grants to the exact build, so **rebuilding resets the mic/screen permissions** — you'll grant them again. For everyday use, build once and keep it. Windows has no equivalent problem.

Packaged builds include a pinned `whisper.cpp` runtime. When running from source, prepare the matching runtime once:

```bash
npm run prepare:whisper
```

Windows x64 and Linux x64/arm64 use checksum-verified binaries from the pinned upstream release. macOS x64/arm64 builds `whisper-server` from the same pinned source tag and requires CMake plus Xcode command-line tools.

---

## First launch — the 1-minute setup

When cue opens the first time, a **built-in tutorial** walks you through everything below. You can reopen it anytime by clicking the **cue logo** (top-left of the pill). Here's the same thing in writing.

### Step 1 — Grant permissions

cue can't help until your OS lets it see and hear. When you first use a feature you'll usually be prompted — click **Allow**. If no prompt appears, grant access manually.

**On macOS — two grants.** System Settings → **Privacy & Security** → **Microphone** and **Screen Recording** → turn on **cue**. macOS may ask you to **quit & reopen** cue — let it. Screen Recording covers both the screenshot features and meeting-audio capture.

**On Windows — one grant.** Only the microphone needs permission: Settings → **Privacy & security** → **Microphone** → turn on **Microphone access** *and* **Let desktop apps access your microphone**. Screenshots and meeting audio need no permission at all — they work immediately, using Windows loopback capture.

### Step 2 — Pick how cue answers: publik API (default) or your own key

The packaged builds from the Releases page run on **publik API** by default: no
account and no key needed. The first-run guide shows a short disclosure — every
request is priced per use at 50% of the model's published list price, from a
publik balance that starts with a small free amount; most people spend under $2
a month; your prompts and screenshots go through publik's servers to a shared
model account, and publik never trains on them. Nothing is set up until you
press **Continue with publik API**. Settings → Keys shows the balance line and a
**Link this computer to your publik account** button (that is where you add
credit once the free balance is used up). **Use my own key instead** switches to
any of the providers below at any time; a key you have already entered is never
replaced.

A build from source has no publik app token unless you export
`PUBLIK_APP_TOKEN`; without one the publik option does not appear and cue works
exactly as before. The release workflow embeds the token from the
`PUBLIK_APP_TOKEN` repository secret (it is a publishable identifier that lets
the gateway attribute installs to cue — it holds no balance and is not a key).

### Step 2 (alternative) — Add your AI key (bring your own)

cue uses **your own** API key, so it's free to run (you only pay your AI provider for what you use). Click the **`...`** button in the input box (or press `⌘` `,` on macOS / `Ctrl` `,` on Windows) to open **Settings**, pick a provider, and paste your key:

| Provider | Get a key | Notes |
|---|---|---|
| **OpenAI** | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) | One key does everything — **but** for the *listening* features the key must have **Whisper / audio** access (a "restricted" project key that only allows chat will give a 403 on transcription). |
| **Anthropic (Claude)** | [console.anthropic.com](https://console.anthropic.com) | Great for screen & coding help. Claude has no speech-to-text, so add an OpenAI or Gemini key too if you want the listening features. |
| **Google Gemini** | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) | One key does chat + transcription. |
| **Azure AI Foundry** | [ai.azure.com](https://ai.azure.com) | Paste your **endpoint** plus your key in Settings. **Azure OpenAI:** `https://&lt;resource&gt;.openai.azure.com/openai` — **AI Foundry:** `https://&lt;host&gt;.cognitiveservices.azure.com` (cue appends `/openai/v1` itself). The **model** fields are your deployment names. No speech-to-text — add an OpenAI or Gemini key for listening. |
| **Custom** | Your endpoint or gateway | Any OpenAI-compatible Chat Completions endpoint. The API key is optional for unauthenticated local servers. |

To use an OpenAI-compatible endpoint, select **Custom** and configure its Base URL, API key, and Fast/Smart model IDs. Custom endpoints handle LLM requests only; listening continues to use Deepgram, OpenAI, or Gemini credentials.

| Example | Base URL | Model |
|---|---|---|
| OpenClaw local gateway | `http://127.0.0.1:18789/v1` | `openclaw/default` |
| Ollama | `http://127.0.0.1:11434/v1` | An installed Ollama model ID |

Your key is stored **only on your computer** (in `cue-data.json`) and is sent **only** to that provider. cue has no server and collects nothing.

### Optional — transcribe locally with whisper.cpp

Open **Settings → Audio**, choose **Local**, and download a model. `base.en` is the recommended English default; all 30 models supported by the official whisper.cpp download script are available, including multilingual, quantized, large, turbo, and TinyDiarize variants.

Local mode is independent from the chat provider, so you can use local speech-to-text with OpenAI, Anthropic, or Gemini chat. The selected model loads once when listening starts, serves both the **You** and **Them** channels, and unloads only after queued speech has been transcribed when listening stops.

- Audio inference stays on your computer and audio is never written to a temporary file.
- Model files are downloaded only when you ask, support cancel/resume, and are checked against pinned byte counts and SHA-256 hashes.
- Local mode never silently sends audio to a cloud fallback. A local failure is reported without sending the audio elsewhere.
- Models are stored under Cue's Electron user-data directory and can be imported or deleted from Settings.

### Optional — tailor answers to your background

All prep material lives on one tab, **Settings → Prep**, in three sections: you and
the role (résumé, job description, knowledge base), prepared answers (STAR stories,
why this company, why leaving, work style) and closing the interview (salary and
start date, questions to ask). The Resume / JD / Stories / Salary / KB indicators
under the input box show what is loaded; click them to open the tab. cue uses the
résumé as the factual reference for career-related answers and says when it does
not provide a detail. You can clear any field anytime.

The **Interview knowledge base** field accepts longer reference notes.
The complete notes are stored locally and sent to the selected chat provider with
each non-coding request. Longer notes increase request size; keep them focused and
mark unknown or conditional personal details clearly. Clearing the field removes
the saved reference.

Every non-coding request includes all of your prep material (résumé, job
description, STAR stories, motivation, work style, compensation preference,
questions to ask and the knowledge base), so the model always has the facts it
needs. Each field is bounded generously (the résumé at 12,000 characters) and
anything cut is marked as truncated. With Anthropic, this block is marked for
prompt caching so repeated questions start answering faster. Names and
technologies from the same material are passed to speech-to-text as vocabulary
hints (Whisper prompt, Deepgram keyterms).

**Settings → Style → Answer length** defaults to **Brief**: usually 2–3 sentences,
with the answer first, one supporting detail, and no repeated conclusion. Choose
Balanced or Detailed for a fuller explanation. Explicit requests for more detail
and complete coding solutions can be longer; these are prompt targets, not hard
output cuts. Existing custom AI rules can override the default style.

For conversation help without an image, set **Settings → Style → Screen context
for Assist and Ask → Conversation only**. This skips screenshot capture and upload.
The dedicated coding solver still uses the screen.

**Settings → Style → Fast first answer** (on by default) sends one tiny request
shortly after launch and when listening starts, beginning with the same prep block
as every answer. That opens the connection and primes the provider's prompt cache,
so the first answer of a session starts in about a second instead of about five
(measured with OpenAI gpt-4.1-mini: 4.7–5.7 s cold, 1.3–1.7 s after a warm-up). It
costs a fraction of a cent, runs at most every 4 minutes, never interrupts a
request, and is never sent on publik API.

When a request fails, cue says what happened in plain words — a rejected key, a
key without access to the model, no credit left, a rate limit, a retired model,
prep notes too long for the model, no connection, or a provider outage — and
offers **Open Settings** when the fix is there.

### Step 3 — The Zoom setting (only needed for Zoom)

cue is hidden from most screen-share tools automatically — **Google Meet, Microsoft Teams, and QuickTime need nothing.** **Zoom** has a specific setting that decides whether it respects cue's "don't capture me" flag:

> **Zoom → Settings → Share Screen → Advanced → Screen capture mode → choose "Advanced capture with window filtering."**

<div align="center"><img src="docs/zoom-setting.png" width="560" alt="Zoom screen capture mode setting" /></div>

**Why:** the *"...with window filtering"* modes tell Zoom to leave out windows that mark themselves as private — which is exactly what cue does. The **"Advanced capture without window filtering"** mode grabs the raw screen and **will show cue**, so avoid it.

---

## How to use it

> On Windows, press **`Ctrl`** wherever **`⌘`** appears below. cue's own UI relabels the keys to match your OS.

- **`⌘` `↵` — Assist.** The do-the-smart-thing key. On a coding problem it solves it; in a conversation it tells you what to say. Works from anywhere. Every shortcut can be changed or cleared under **Settings → ⌨️ Shortcuts**.
- **`⌘` `H` — Solve what's on screen.** Screenshots a coding problem and returns the approach, code, and time/space complexity.
- **`⌘` `⇧` `H` — Add a screenshot.** For a problem longer than one screen: add each part while scrolling (up to 4), then press `⌘` `H` to solve with all of them plus the current screen.
- **Coding follow-ups.** After a solution, type a follow-up ("optimize it", "what if the input is sorted?") and cue continues from its earlier solution.
- **The `▢` button** (top bar) — start/stop **listening** to a meeting. The green dot means it's live.
- **Auto** — while listening, answer each interviewer question as soon as they finish asking, with no key press. Off by default. If the interviewer keeps talking, the answer is replaced with one for the fuller question; if you ask by hand first, your request is kept.
- **Type a question** in the box and press `↵` to ask about your screen or conversation.
- **A new request replaces the answer in progress** — you never wait for an old answer to finish. Press `Esc` to stop an answer.
- **Follow-up questions** such as "why did you choose that?" are answered with the recent conversation and cue's earlier answers in view. **Clear transcript** also clears that memory.
- **Smart** — flip it on for a smarter, more thorough model; off for fast and cheap.
- **Answers are formatted as they stream** (lists, headings, code blocks with a language label). **Copy** buttons copy a code block or a whole answer.
- **Hide** collapses the panel to just the top bar. Drag cue around by the **top pill**. Quit with `⌘` `⇧` `X` on macOS or `Ctrl` `Shift` `X` on Windows.

The panel is see-through and click-through — the empty space around it never blocks the app behind it.

### Sessions, debriefs and practice

Open **Sessions** (the archive icon next to the history button).

- **Save sessions on this computer** (on by default; untick it to stop) keeps every conversation: the interviewer's questions, your answers, and cue's suggestions. A session is saved as it goes, and closed when you **Clear History**, start practice, or quit. Audio is never saved.
- **Markdown copy:** choose a folder and cue keeps a readable `.md` copy of each session there, which works with Obsidian, VS Code, Notion import, Google Docs or any synced folder. Any session can also be exported with **Export .md**.
- **Search** across questions, answers and debriefs, and open a session to read the whole conversation.
- **Debrief** asks your chat model for a review of a session: a summary, the questions asked and how you answered, what went well, what to improve (with stronger versions of the weakest answers, using only your real facts), follow-ups for a thank-you note, and notes to add to your prep material. It is saved with the session.
- **Start a practice interview:** cue plays the interviewer, choosing questions from your job description and background, and reads each one aloud with your system's built-in voice (free and offline; switch it off with **Voice**). Answer out loud, then press **Rate my answer** for quick feedback and a stronger version, or **Next question**. Meeting audio is ignored during practice and the mic is muted while cue speaks. **End** saves the practice run as a session you can debrief.

### Keyboard shortcuts

These work while another app (your meeting or editor) has focus. A global shortcut takes its key combination away from every other app, so change or clear any that clash with your editor under **Settings → ⌨️ Shortcuts**: click a shortcut and press the new keys. A combination another app already holds, or one assigned twice, is flagged there. On Windows, read `⌘` as `Ctrl` and `⌥` as `Alt`.

| Action | Default |
|---|---|
| Assist | `⌘` `↵` |
| What should I say? | `⌘` `⇧` `↵` |
| Solve what's on screen | `⌘` `H` |
| Add a screenshot for the solver | `⌘` `⇧` `H` |
| Start / stop listening | `⌘` `⇧` `L` |
| Auto-answer on / off | not set |
| Stop the current answer | `⌘` `⇧` `⌫` (or `Esc` in the panel) |
| Scroll answers up / down | `⌘` `⌥` `↑` / `⌘` `⌥` `↓` |
| Move the panel | `⌘` `⌥` `⇧` + arrow keys |
| Collapse / expand the panel | `⌘` `⇧` `/` |
| Quit | `⌘` `⇧` `X` |

---

## How it works (under the hood)

cue is an [Electron](https://www.electronjs.org/) app. Everything runs locally except the calls to your chosen AI provider.

**The three inputs are kept completely separate:**
- **Screen** — captured with Electron's `desktopCapturer` (full-resolution screenshots, taken only when a feature needs one).
- **Your mic ("You")** — `getUserMedia` → downsampled to 16 kHz audio → transcribed.
- **Meeting audio ("Them")** — `getDisplayMedia` loopback capture of your system's output audio, kept on its own channel so cue knows *who* said what. Supported on Windows and macOS 14.4+; on macOS, enable meeting audio in Settings and grant Screen Recording permission.

Both audio streams are transcribed by the independently selected speech provider (local whisper.cpp, Deepgram, OpenAI, or Gemini) and fed, with an optional screenshot, to your chat model. Responses **stream** into the panel word-by-word.

When Local transcription is selected, Cue runs one persistent `whisper-server` sidecar bound to `127.0.0.1` on a temporary port with a random request path. Voice activity detection creates bounded in-memory utterances with pre-roll, and both channels share a serialized inference queue because one Whisper context must not process concurrent requests. Stop immediately ends new audio capture, drains the current queue for a bounded period, then terminates the sidecar.

**The invisibility** is a single window flag — `setContentProtection(true)` — which the OS enforces:

- **macOS:** sets `NSWindowSharingNone`, asking the window server to exclude cue from capture streams. On macOS 15.4+ Apple lets some capture tools ignore it, which is why it's best-effort (see the disclaimer at the top).
- **Windows:** sets `WDA_EXCLUDEFROMCAPTURE` via `SetWindowDisplayAffinity`, and the compositor drops the window from every capture path. Windows 10 builds before 2004 fall back to `WDA_MONITOR`, which renders a black box rather than truly excluding.

It's the same mechanism DRM apps and Zoom's own toolbar use. It is **not** a GPU trick or a special overlay layer. Set `CUE_NO_PROTECT=1` to disable it while debugging.

```
main process ──┬─ overlay window (frameless, transparent, always-on-top, content-protected)
               ├─ screenshot capture (desktopCapturer)
               ├─ speech-to-text (local whisper.cpp / Deepgram / OpenAI / Groq / Gemini / Custom)
               │                                          ── "You" + "Them" channels
               ├─ LLM streaming (OpenAI / Anthropic / Gemini / Azure / Groq / Ollama / Custom …)
               └─ saved sessions (opt-in JSON + Markdown copy)
renderer ──────┴─ the glass UI + mic capture + system-audio loopback
```

---

## Troubleshooting

**Local transcription says the runtime is not prepared.**
Packaged releases include the runtime. If you are running from source, run `npm run prepare:whisper` once and restart Cue. On macOS, install CMake and Xcode command-line tools first.

**Local transcription says the model is missing or invalid.**
Open **Settings → Audio**, select the model, and choose **Download**. A cancelled download can be resumed. If verification fails repeatedly, delete the partial/model file from the same screen and download it again.

**A large local model is slow or runs out of memory.**
Try `base.en`, `tiny.en`, or a quantized `q5`/`q8` model. Model size in Settings is the download size, not a guarantee of runtime RAM use; larger models require substantially more memory and CPU/GPU time.

**"It says give access, but I already gave access." (macOS)**
You probably granted an older build. Because the app is ad-hoc signed, a rebuild changes its identity and macOS stops honoring the old grant (the checkmark can linger). Toggle cue **off and on** in System Settings → Screen Recording, or remove and re-add it.

**"What should I say?", "Follow-up questions", or "Recap" never hear the other person (macOS).**
Meeting audio requires macOS 14.4+, Screen Recording permission, and the meeting-audio option enabled in Settings. It is off by default on macOS. Older macOS versions can still use microphone transcription and screenshots.

**cue has no dock or taskbar icon — how do I quit it?**
That's deliberate; it stays out of your way. Press **`Ctrl` `Shift` `X`** (**`⌘` `⇧` `X`** on macOS). If the shortcut didn't register because another app claimed it, end the **cue** (or **electron**) process in Task Manager / Activity Monitor.

**`npm start` crashes with `Cannot read properties of undefined (reading 'getPath')`.**
Something in your environment set **`ELECTRON_RUN_AS_NODE=1`** — some editors and terminals do, notably VS Code's integrated terminal. That makes Electron boot as plain Node, so `require('electron')` returns a path string instead of the real module. Clear it and relaunch: `unset ELECTRON_RUN_AS_NODE` (PowerShell: `Remove-Item Env:\ELECTRON_RUN_AS_NODE`).

**A feature returns "403" / "no access to model."**
Your API key is restricted. Most often it's an OpenAI **project key that only allows chat models** — it works for screen/coding help but 403s on transcription (Whisper). Fix: enable audio/Whisper on the key, use an unrestricted key, or add a Gemini key (cue falls back to it for transcription).

**Listening does nothing / no transcript.**
Check Settings shows a transcription-capable key (OpenAI with Whisper, or Gemini). On macOS, also make sure Screen Recording is granted (meeting audio needs it). On Windows, make sure **Let desktop apps access your microphone** is on — the top-level Microphone toggle alone isn't enough.

**A Custom provider request cannot connect.**
Confirm the Base URL includes the endpoint's `/v1` path when required, the selected model ID exists on that endpoint, and the local gateway is running. Custom provider credentials are intentionally not reused for speech-to-text.

**cue shows up in my Zoom share.**
Set Zoom's **Screen capture mode** to *"Advanced capture with window filtering"* (see Step 3). And remember: on macOS 15.4+ this can still fail — it's best-effort.

**"cue is damaged and can't be opened."**
macOS quarantines unsigned downloads. Run `xattr -cr /Applications/cue.app` in Terminal once, then open cue again.

---

## Privacy

### Local configuration and agent access

Settings → Keys shows the **active settings file** and the provider names with
saved credentials, without displaying their values. Source and locally packaged
builds can share an explicit directory: create an ignored `cue-local.json` in the
repository root containing `{"userDataDirectory":"C:\\Dev\\CueData"}` after
moving the existing user-data files there while Cue is closed. Local packages
include this locator when present. Keep it out of generic public releases.

The directory holds `cue-data.json`, sessions, downloaded speech models, and local
backups. Without a locator, Cue keeps its normal Electron user-data location.
`CUE_DATA_DIR` is an explicit override for isolated tests or another installation;
a configured directory must exist, otherwise startup fails instead of silently
opening an empty profile.

Agents should use `node scripts/cue-config.js status` and compare its path with
Settings → Keys. Do not assume a sandbox's AppData view is the app's configuration.
To import preparation material, quit Cue and run
`node scripts/cue-config.js import-profile <profile.json>`. Imports preserve keys,
provider choices and models, and save a backup. Never paste the entire settings
file into a chat or commit it to Git.

Cue refreshes settings when the panel opens and rejects stale panel saves after
external changes. **Reload saved settings** discards unsaved edits and reloads
the active file. Writes are atomic; read/write failures are reported instead of
silently substituting empty settings. Only one instance uses a given data directory.

- No Cue accounts, hosted service, or telemetry. cue collects nothing.
- Your API keys live in a local file (`cue-data.json`) and are sent only to the provider you chose.
- When Custom is selected, its API key and LLM request data are sent to the Base URL you configured.
- Your optional résumé and prep notes also live in `cue-data.json` and are sent with each non-coding model request to your selected AI provider. They are stored as plain text; clear them in Settings to remove them. Names and technologies extracted from them are sent to your cloud speech provider as vocabulary hints.
- In Local transcription mode, microphone and meeting audio stay on your computer. In cloud transcription modes, audio is sent only to the selected speech provider.
- Cue never writes captured audio to disk. By default each conversation's transcript and cue's answers are saved as plain JSON under cue's user-data folder (and, if you choose a folder, as a Markdown copy there), so you can review and debrief them later. Turn this off under **Sessions → Save sessions on this computer** to keep transcripts in memory only; sessions already saved can be deleted one by one. Downloaded local model files remain on disk until you delete them.
- A debrief sends that session's transcript and your prep notes to your selected chat provider, the same as any other request.
- Screenshots are sent to your selected chat provider only when a feature needs the screen.

## Contributing

Issues and PRs welcome. cue is intentionally small and readable, with no build step (plain HTML/CSS/JS):

- `main.js` — app lifecycle, capture routing, requests, shortcuts, sessions and practice wiring.
- `renderer/` — the UI (`renderer.js`), answer formatting (`markdown.js`), and audio worklets.
- `src/` — providers (`llm.js`, `stt*.js`, local Whisper), prompts (`prompts.js`, `interview-context.js`), and the testable pieces behind each feature (`auto-answer.js`, `batch-transcriber.js`, `sessions.js`, `shortcuts.js`, …).
- `test/` — `npm test` runs the offline suite; no API keys or network needed.

## Credits & license

Built as an open-source study of how tools like **Cluely** and **Interview Coder** work. Modeled on the open-source clones `pickle-com/glass` and `sohzm/cheating-daddy`.

Local transcription uses [whisper.cpp](https://github.com/ggml-org/whisper.cpp), distributed under the MIT License. Its license notice is included in packaged runtimes.

**License: [GPL-3.0-or-later](LICENSE).**
