# Contribution fork

This fork tracks Blueturboguy07/cue and preserves its license and history. Its
focus is interview preparation, grounded conversational assistance and practical
desktop reliability. General fixes are suitable for separate upstream PRs.

## Changes

- Brief spoken answers by default, with Balanced and Detailed options under
  Settings → Style. The model should answer first, give one supporting detail,
  then stop. Removed conflicting mandatory STAR expansion and generic role pitches.
- Current-question classification replaces matching against five concatenated
  interviewer turns. Typed and selected questions choose their own reference
  context. Prompt construction happens before screen capture so a new transcript
  event cannot change an already-started request.
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
