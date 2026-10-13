// Dev-only timings for the answer pipeline, logged to the terminal when cue
// starts with CUE_TRACE_LATENCY=1. One line per answer:
//   commit   the transcriber closed the other side's utterance (it waits for
//            a short silence first, so the speaker stopped a little earlier)
//   final    its final transcript arrived
//   fire     Auto decided the question was complete (Auto answers only)
//   start    the answer request began
//   first    the first answer token arrived
//   done     the answer finished
class LatencyTrace {
  constructor({ enabled = false, now = Date.now, log = console.log, loopDelay = null } = {}) {
    this.enabled = enabled;
    this.now = now;
    this.log = log;
    // perf_hooks event-loop delay histogram: a busy main process delays timers.
    this.loopDelay = loopDelay;
    this.commitAt = 0;
    this.finalAt = 0;
    this.fireAt = 0;
    this.job = null;
  }

  commit(channel) {
    if (this.enabled && channel === 'them') this.commitAt = this.now();
  }

  final(channel) {
    if (this.enabled && channel === 'them') this.finalAt = this.now();
  }

  fire() {
    if (this.enabled) this.fireAt = this.now();
  }

  start(id, mode, auto) {
    if (!this.enabled) return;
    this.job = { id, mode, auto, startAt: this.now(), firstAt: 0 };
    if (!auto) this.fireAt = 0;
  }

  token(id) {
    if (this.enabled && this.job && this.job.id === id && !this.job.firstAt) this.job.firstAt = this.now();
  }

  done(id) {
    if (!this.enabled || !this.job || this.job.id !== id) return;
    const j = this.job;
    const doneAt = this.now();
    const gap = (a, b) => (a && b && b >= a ? (b - a) + 'ms' : '-');
    const parts = [
      j.mode + (j.auto ? ' (auto)' : ' (manual)'),
      'commit>final ' + gap(this.commitAt, this.finalAt),
      j.auto ? 'final>fire ' + gap(this.finalAt, this.fireAt) : 'final>start ' + gap(this.finalAt, j.startAt),
      'start>first ' + gap(j.startAt, j.firstAt),
      'first>done ' + gap(j.firstAt, doneAt),
      'commit>first ' + gap(this.commitAt, j.firstAt)
    ];
    if (this.loopDelay) {
      parts.push('loop max ' + Math.round(this.loopDelay.max / 1e6) + 'ms');
      this.loopDelay.reset();
    }
    this.log('[latency] ' + parts.join(' | '));
    this.job = null;
  }
}

module.exports = { LatencyTrace };
