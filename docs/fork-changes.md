# Contribution fork

This fork tracks Blueturboguy07/cue and preserves its license and history. Its
focus is interview preparation, grounded conversational assistance and practical
desktop reliability. General fixes are suitable for separate upstream PRs.

## Changes

- Brief spoken answers by default, with Balanced and Detailed options under
  Settings → Style. The model should answer first, give one supporting detail,
  then stop. Removed conflicting mandatory STAR expansion and generic role pitches.
- The current question is the interviewer's latest turn plus the directly
  preceding interviewer turns spoken within 20 seconds (a short acknowledgement
  such as "mm-hm" does not split it). Speech providers end turns at short
  pauses, so a question used to be classified and answered from its last
  fragment. Say and Assist restate the joined question to the model. Prompt
  construction happens before screen capture so a new transcript event cannot
  change an already-started request.
- All prep material is sent with every non-coding request instead of a subset
  chosen by a keyword guess at the question type. The old selection clipped the
  résumé to a few regex-parsed sections of at most 800 characters (a six-job
  résumé lost half its jobs and its education on technical questions) and hid
  stories, work style or compensation preferences whenever a question was
  misclassified. The category now only labels the answer in the UI. The block
  is a stable prompt prefix and is marked for Anthropic prompt caching.
- Batch transcription (OpenAI Whisper, Groq, Gemini, Custom) sends one request
  per utterance, cut at pauses by the voice-activity segmenter local Whisper
  uses, instead of a fixed 900 ms slice. In an end-to-end run with a synthetic
  3 s + 2 s speech pattern this went from 28 requests of 0.8–1.0 s audio to 8
  requests of whole utterances, so words are no longer split across requests.
- Speech-to-text vocabulary hints come from the job description, résumé and
  notes (job-description terms first) instead of a fixed DevOps list, and are
  also sent to Deepgram Nova-3 as keyterms.
- The coding solver may use up to 4,096 output tokens; the 700-token fast-mode
  budget for spoken answers could cut a solution off mid-code.
- A new request cancels the answer in progress (its provider request is
  aborted and its late tokens are dropped) instead of being silently ignored
  while an answer streams. Events carry a request id so a cancelled answer can
  never write into its replacement. `Esc` stops an answer.
- Optional auto-answer (the **Auto** pill, off by default): after an interviewer
  turn that reads as a complete question and 1.2 s without more interviewer
  speech, "Answer this" runs on the joined question. Interviewer speech only
  postpones it (up to 3.6 s), because meeting-audio noise can report speech
  with no end. A substantive reply from the candidate, or a request made by
  hand after the question, prevents it.
- "Answer this" includes the last six transcript turns so follow-up questions
  resolve, and spoken modes see up to three of cue's earlier answers this
  session, for consistency and "tell me more about that".
- Coding: up to four screenshots can be queued (`Ctrl/⌘+Shift+H`) and are sent
  in order with the current screen. A typed question right after a coding
  answer continues that thread: earlier solutions are sent as conversation
  history, still without personal notes or AI rules.
- Global shortcuts are configurable in Settings → Shortcuts (they were
  hard-coded although the README said otherwise). New actions: start/stop
  listening, auto-answer toggle, stop the answer, scroll answers, and move the
  panel, so nothing requires clicking the overlay mid-interview. Each shortcut
  reports whether another app holds it or it is assigned twice, and global
  shortcuts are released while a new combination is recorded.
- Answers render as markdown while they stream (numbered lists, headings,
  italics and labelled code blocks were added), with copy buttons for each
  code block and each answer. The renderer lives in `renderer/markdown.js`
  and is unit-tested.
- Saved sessions (on by default, switched off in the Sessions panel): transcript turns and cue's answers
  are saved per conversation as JSON under the user-data folder (atomic
  writes, debounced while live, flushed on clear, practice start and quit),
  with an optional Markdown copy in a chosen folder. Sessions can be searched,
  read, exported and deleted. The unused `meetings.js`/`notes.js` modules are
  superseded by `src/sessions.js`.
- Debrief: a grounded review of a saved session (questions and how they were
  answered, strengths, improvements with stronger answers built only from the
  transcript and prep notes, follow-ups, and gaps to add to the prep notes).
  Very long transcripts keep their beginning and end.
- Practice interviews: cue asks one question at a time from the job
  description and background (read aloud with the free, offline system voice
  via the Web Speech API), then rates the spoken answer. Meeting audio is
  ignored and the mic is muted while the question is spoken, so cue does not
  hear itself.
- Cleanup: removed modules and scripts nothing used (`context.js`, `meetings.js`,
  `notes.js`, `resume-context.js` with its regex résumé parser, the unused
  résumé helper in `profile-context.js`, `rms16`, unused batch helpers in
  `stt-streaming.js`, the never-read pre-speech ring buffers in `main.js`, and
  the root `verify.js` / `probe-anthropic*.cjs` probes); duplicate `app:quit`,
  `will-quit` and `window-all-closed` handlers; "FIX #n" comment prefixes; and
  duplicated or garbled README sections.
- Default models for new installs: OpenAI `gpt-4.1-mini` / `gpt-4.1`,
  Anthropic `claude-haiku-4-5` / `claude-opus-5`, Gemini `gemini-2.5-flash`
  for both tiers. Existing settings keep the models already saved. Requests
  carry an effort hint (low for spoken answers, medium for coding and
  debriefs, one level higher with Smart). Claude models that think by default
  get that effort level, room in `max_tokens` for thinking, and server-side
  refusal fallbacks; a refusal or an answer lost to the output limit is shown
  as a clear error. Gemini 2.5 gets an explicit thinking budget (none for fast
  spoken answers on Flash), so thinking can no longer leave a short answer
  empty.
- OpenAI requests send `max_completion_tokens` (OpenAI's reasoning models,
  the o-series and GPT-5, reject `max_tokens`). Reasoning models also get
  room for their hidden reasoning tokens and a `reasoning_effort` from the
  effort hint; an answer lost entirely to reasoning is reported as an error.
  OpenAI-compatible servers (Custom, Groq, publik, MiniMax) still receive
  `max_tokens`.
- Persistent reference notes with factual-grounding instructions. Full notes are
  preserved, including qualifications near the end. No retrieval service or new
  dependency is introduced. Very large notes can still exceed a provider's context
  limit; the app does not silently discard them.
- Optional conversation-only Assist/Ask avoids screenshot capture and image input.
  Coding solves retain screenshots and exclude personal references.
- The 25-second inactivity watchdog cancels the client request and suppresses late
  output. Cancellation is forwarded to every chat provider adapter. Whether remote
  computation or billing stops is provider-dependent.
- Source startup clears `ELECTRON_RUN_AS_NODE` in its child environment. Installation
  no longer automatically renames Electron or claims Microsoft identity.
- Fixed the ignore pattern for `cue-data.json` and contradictory macOS audio docs.
- Dragging works on the first grab. Click-through (transparent areas pass the
  mouse to the app behind) used to be switched in the renderer from mousemove
  events Windows forwards while the window ignores the mouse; they arrive
  unreliably and never over the `-webkit-app-region: drag` toolbar, so a direct
  grab of Drag went to the app behind. The renderer now reports its UI
  rectangles and the main process polls the cursor against them
  (`src/click-through.js`). A position saved on a secondary monitor is restored
  there instead of being clamped to the primary display, the window is re-sized
  after creation on a monitor with another scale factor (it came out 1.5x too
  large), and it returns to its exact size after being dragged between monitors
  with different scaling (it briefly shrank to 467x401 entering a 150% screen).
- Screen-share hiding decides from the Windows session of the cue process
  (`tasklist`), not only the inherited `SESSIONNAME`, which launchers can drop or
  leave stale after a Remote Desktop reconnect.
- The panel always fits its fixed-size window: the answer list is the only part
  that shrinks when practice controls or status messages need room, and a new
  answer scrolls only the answer list (`scrollIntoView` also scrolled the page,
  pushing the toolbar out of the window). The answer being written stays in view
  until the user scrolls, and scrolled edges fade instead of cutting text.
- No sample answer on launch: an empty state says what to do next, or offers
  Open Settings when no provider key is set. The listening label reads
  "listening" / "not listening" instead of transport names.
- Settings: Profile, Interview Prep and Q&A merged into one Prep tab (5 tabs,
  one row); slim dark scrollbars everywhere; provider buttons wrap; muted text
  raised to at least 4.5:1 contrast; styled import buttons; prep indicators open
  the Prep tab. Settings saves are queued: overlapping saves from quick tab
  switches were rejected as "changed outside this window".
- Plain-language provider errors for rejected keys, keys without model access,
  exhausted credit, prep notes over the context window, network failures and
  provider outages, with an Open Settings button when the fix is there.
- Optional warm-up (on by default, never on publik): a tiny request after launch
  and when listening starts primes the connection and prompt cache. With OpenAI
  gpt-4.1-mini the first answer's first token went from 4.7–5.7 s to 1.3–1.7 s.

## Validation and limits

Run `npm test` for offline regression tests. They cover topic changes, selected and
typed questions, immutable request construction, style selection, reference
preservation, settings persistence, timeouts, late tokens and adapter cancellation.
These checks verify application behavior and prompt composition; they do not prove
that a model always follows instructions or establish a latency improvement.

Use a synthetic profile for the following answer-quality check, keeping the same
provider and model before and after the change. Example facts: Alex moved from
support to development after building internal tools; fixed duplicate imports with
an idempotency check; wants to deepen technical expertise. No measured business
impact, management ambitions, salary target or notice period is confirmed.

| Question | Expected behavior in Brief mode |
| --- | --- |
| How did you change to this position? | State the transition and one documented reason; do not recite the whole career. |
| How do you see yourself in five years? | Use the documented technical direction; do not invent a leadership ambition. |
| What was your biggest decision? | Flag that no ranked decision is documented; do not invent a life event. |
| What was the most important bug you fixed? | Use the import example, with no fabricated metric or claim that it was definitively the biggest. |
| Explain how an idempotency key works. | A short conceptual explanation; no invented personal implementation details. |
| Walk me through the fix in detail. | Respect the explicit request for depth while keeping unsupported facts out. |

For each response, check relevance, factual support, natural wording, repetition,
and whether it finishes after the useful detail. Record word count, time to first
text and completion time separately. No paid live-model evaluation is part of the
offline test suite. Use synthetic notes rather than private interview transcripts
in public issues, examples and test fixtures.
