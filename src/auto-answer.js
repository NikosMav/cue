// Auto-answer: when the interviewer finishes a question, start an answer
// without waiting for a key press. "Finished" means a final interviewer turn
// followed by a short quiet period with no more interviewer speech and no
// real answer from the candidate. If the interviewer keeps going after the
// answer started, the next check fires again with the longer question, and
// the caller replaces the earlier answer.
const { currentQuestionTurns } = require('./interview-context');
const { isLikelyCompleteQuestion } = require('./question-detector');

const DEFAULT_DELAY_MS = 1200;
// "Mm-hm", "okay, sure": the candidate acknowledging, not answering.
const ACKNOWLEDGEMENT_MAX_WORDS = 3;

class AutoAnswer {
  /**
   * @param {object} options
   * @param {() => boolean} options.isEnabled
   * @param {() => {channel: string, text: string, ts?: number}[]} options.getTranscript
   * @param {(question: string) => void} options.onFire
   */
  constructor({
    isEnabled,
    getTranscript,
    onFire,
    delayMs = DEFAULT_DELAY_MS,
    isComplete = isLikelyCompleteQuestion,
    timers = { setTimeout, clearTimeout }
  }) {
    this.isEnabled = isEnabled;
    this.getTranscript = getTranscript;
    this.onFire = onFire;
    this.delayMs = delayMs;
    this.isComplete = isComplete;
    this.timers = timers;
    this.timer = null;
    this.pending = false;      // an interviewer turn arrived and has not been answered
    this.speaking = false;     // the interviewer's voice activity, when the caller reports it
    this.lastQuestion = '';
  }

  /** A final transcript turn was published. */
  noteFinal(channel, text) {
    if (channel === 'them') {
      this.pending = true;
      // A transcript can land while the interviewer is already talking again.
      this._schedule(this.speaking ? this._fallbackMs() : this.delayMs);
    } else if (String(text || '').trim().split(/\s+/).length > ACKNOWLEDGEMENT_MAX_WORDS) {
      // The candidate is answering on their own.
      this.pending = false;
      this._cancel();
    }
  }

  /** Interim (not yet final) text: the interviewer is still talking. */
  noteInterim(channel, text) {
    if (channel === 'them' && String(text || '').trim() && this.pending) this._schedule(this._fallbackMs());
  }

  /** Voice activity on a channel. */
  noteSpeech(channel, speaking) {
    if (channel !== 'them') return;
    this.speaking = !!speaking;
    if (!this.pending) return;
    // Speech postpones rather than cancels: background noise on the meeting
    // audio can report "speaking" with no end, and must not block the answer
    // for good. A real continuation arrives as a new final and reschedules.
    this._schedule(speaking ? this._fallbackMs() : this.delayMs);
  }

  reset() {
    this._cancel();
    this.pending = false;
    this.speaking = false;
    this.lastQuestion = '';
  }

  // How long to wait when the interviewer may still be talking.
  _fallbackMs() {
    return this.delayMs * 3;
  }

  _schedule(delayMs) {
    this._cancel();
    this.timer = this.timers.setTimeout(() => {
      this.timer = null;
      this._check();
    }, delayMs);
  }

  _cancel() {
    if (this.timer) this.timers.clearTimeout(this.timer);
    this.timer = null;
  }

  _check() {
    if (!this.pending || !this.isEnabled()) return;
    const question = currentQuestionTurns(this.getTranscript()).map((t) => t.text.trim()).join(' ');
    if (!question || question === this.lastQuestion || !this.isComplete(question)) return;
    this.pending = false;
    this.lastQuestion = question;
    this.onFire(question);
  }
}

module.exports = { AutoAnswer, DEFAULT_DELAY_MS };
