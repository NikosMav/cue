const test = require('node:test');
const assert = require('node:assert');
const { looksLikeHallucination, buildVocabPrompt } = require('../src/stt');
const { DeepgramStreamingSTT } = require('../src/stt-streaming');

test('looksLikeHallucination drops Whisper silence artifacts', () => {
  ['', '   ', 'Thank you for watching.', 'thanks for watching', 'Bye-bye!', '👍👍'].forEach((s) => {
    assert.equal(looksLikeHallucination(s), true, JSON.stringify(s));
  });
});

test('looksLikeHallucination keeps real speech', () => {
  ['Tell me about your experience with Kubernetes.', 'You know, I led the migration.'].forEach((s) => {
    assert.equal(looksLikeHallucination(s), false, JSON.stringify(s));
  });
});

test('buildVocabPrompt seeds base vocab and resume proper nouns, capped', () => {
  const p = buildVocabPrompt({ resumeText: 'Optum EKS Terraform', jobDescription: 'AWS SRE' });
  assert.ok(p.includes('Kubernetes'));
  assert.ok(p.includes('Optum'));
  assert.ok(p.length <= 850);
  assert.ok(buildVocabPrompt(undefined).length > 0);
  assert.ok(buildVocabPrompt({ resumeText: 'Xyzzy '.repeat(4000) }).length <= 850);
});

test('Deepgram accumulates is_final segments into one turn at speech_final', () => {
  const finals = [];
  const d = new DeepgramStreamingSTT('k', { onTranscript: (t) => finals.push(t) });
  d._handleMessage({ type: 'Results', is_final: true, channel: { alternatives: [{ transcript: 'Tell me about' }] } });
  d._handleMessage({ type: 'Results', is_final: true, channel: { alternatives: [{ transcript: 'your experience' }] } });
  d._handleMessage({ type: 'Results', is_final: true, speech_final: true, channel: { alternatives: [{ transcript: 'with Kubernetes.' }] } });
  assert.deepEqual(finals, ['Tell me about your experience with Kubernetes.']);
});

test('Deepgram flushes pending segments on UtteranceEnd when speech_final never arrives', () => {
  const finals = [];
  const d = new DeepgramStreamingSTT('k', { onTranscript: (t) => finals.push(t) });
  d._handleMessage({ type: 'Results', is_final: true, channel: { alternatives: [{ transcript: 'hello there' }] } });
  d._handleMessage({ type: 'UtteranceEnd' });
  assert.deepEqual(finals, ['hello there']);
  d._handleMessage({ type: 'UtteranceEnd' });
  assert.deepEqual(finals, ['hello there'], 'no duplicate emit on a second UtteranceEnd');
});

test('Deepgram drops hallucinated finals', () => {
  const finals = [];
  const d = new DeepgramStreamingSTT('k', { onTranscript: (t) => finals.push(t) });
  d._handleMessage({ type: 'Results', is_final: true, speech_final: true, channel: { alternatives: [{ transcript: 'Thank you.' }] } });
  assert.deepEqual(finals, []);
});

test('vocabulary comes from the candidate profile, job-description terms first', () => {
  const { extractProfileTerms } = require('../src/stt');
  const terms = extractProfileTerms({
    jobDescription: 'The team uses Node.js, gRPC and C++ on k8s. Experience with Stripe is a plus.',
    resumeText: 'Jane Doe\nLed the migration to Kubernetes at PayCo. Built pipelines in Terraform.'
  });
  for (const term of ['Node.js', 'gRPC', 'C++', 'k8s', 'Stripe', 'Kubernetes', 'PayCo', 'Terraform']) {
    assert.ok(terms.includes(term), term);
  }
  assert.ok(terms.indexOf('Stripe') < terms.indexOf('PayCo'), 'job description ranks first');
  for (const noise of ['The', 'Experience', 'Led', 'Built']) assert.ok(!terms.includes(noise), noise);

  const prompt = buildVocabPrompt({ jobDescription: 'Snowflake dbt Airflow' });
  assert.ok(prompt.startsWith('Snowflake'), prompt);
  assert.ok(!/CodeCommit|CodePipeline/.test(prompt), 'no hard-coded DevOps-only list');
});

test('Deepgram receives profile terms as nova-3 keyterms', () => {
  const Module = require('node:module');
  const originalLoad = Module._load;
  let url;
  Module._load = function(request, parent, isMain) {
    if (request === 'ws') return class { constructor(u) { url = u; } on() {} };
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const { createStreamingSTT } = require('../src/stt-streaming');
    const noop = () => {};
    const stt = createStreamingSTT(
      { sttProvider: 'deepgram', apiKeys: { deepgram: 'k' }, jobDescription: 'We use Snowflake and dbt Cloud.' },
      'them', { onTranscript: noop, onInterim: noop, onError: noop, onStatusChange: noop });
    stt.instance.connect();
    const params = new URL(url).searchParams;
    assert.ok(params.getAll('keyterm').includes('Snowflake'));
    assert.ok(params.getAll('keyterm').length <= 40);
  } finally {
    Module._load = originalLoad;
  }
});
