// Cloud batch transcription (OpenAI Whisper, Groq, Gemini, Custom) for the
// You and Them channels. Audio is cut at natural pauses by the same
// voice-activity segmenter local Whisper uses, instead of fixed ~1s slices
// that split words, lost accuracy and cost one request per second per channel.
const { UtteranceSegmenter, CHANNEL_VAD_OPTIONS } = require('./utterance-segmenter');

const CHANNELS = Object.freeze(['you', 'them']);
// Long monologues are still sent in bounded pieces so text keeps appearing
// while the interviewer talks.
const BATCH_MAX_UTTERANCE_MS = 15000;

class BatchTranscriber {
  /**
   * @param {object} options
   * @param {(channel: string, pcm: Buffer) => Promise<string>} options.transcribe
   * @param {(channel: string, text: string) => void} [options.onTranscript]
   * @param {(channel: string, speaking: boolean, durationMs?: number) => void} [options.onSpeechState]
   * @param {(error: Error, channel: string) => void} [options.onError]
   */
  constructor({
    transcribe,
    onTranscript = () => {},
    onSpeechState = () => {},
    onError = () => {},
    segmenterFactory = (options) => new UtteranceSegmenter(options),
    maxUtteranceMs = BATCH_MAX_UTTERANCE_MS
  }) {
    if (typeof transcribe !== 'function') throw new Error('BatchTranscriber requires a transcribe function.');
    this.transcribe = transcribe;
    this.onTranscript = onTranscript;
    this.onSpeechState = onSpeechState;
    this.onError = onError;
    this.segmenterFactory = segmenterFactory;
    this.maxUtteranceMs = maxUtteranceMs;
    this.segmenters = new Map();
    // One queue per channel keeps each speaker's turns in spoken order while
    // the two channels transcribe in parallel.
    this.queues = new Map(CHANNELS.map((channel) => [channel, Promise.resolve()]));
    this.acceptingAudio = false;
  }

  start() {
    for (const channel of CHANNELS) {
      this.segmenters.set(channel, this.segmenterFactory({
        channel,
        maxUtteranceMs: this.maxUtteranceMs,
        vadOptions: { ...CHANNEL_VAD_OPTIONS[channel] },
        onSpeechState: (speechChannel, speaking, durationMs) => this.onSpeechState(speechChannel, speaking, durationMs),
        onUtterance: (utteranceChannel, pcm) => { this._enqueue(utteranceChannel, pcm); }
      }));
    }
    this.acceptingAudio = true;
  }

  push(channel, pcm) {
    if (!this.acceptingAudio) return;
    const segmenter = this.segmenters.get(channel);
    if (!segmenter) throw new Error(`Unknown transcription channel: ${channel}`);
    segmenter.push(pcm);
  }

  /** Stop taking audio; the utterance in progress and queued ones still finish. */
  stop() {
    this.acceptingAudio = false;
    for (const segmenter of this.segmenters.values()) segmenter.stop();
    this.segmenters.clear();
  }

  /** Resolves once every queued utterance has been transcribed. */
  drain() {
    return Promise.all([...this.queues.values()]).then(() => undefined);
  }

  _enqueue(channel, pcm) {
    const job = this.queues.get(channel).then(async () => {
      const text = await this.transcribe(channel, pcm);
      if (typeof text === 'string' && text.trim()) this.onTranscript(channel, text.trim());
    });
    this.queues.set(channel, job.catch((error) => this.onError(error, channel)));
    return job;
  }
}

module.exports = { BatchTranscriber, BATCH_MAX_UTTERANCE_MS, CHANNELS };
