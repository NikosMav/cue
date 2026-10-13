const test = require('node:test');
const assert = require('node:assert/strict');
const { buildEnrichRequest, parseEnrichResponse, extractJson } = require('../src/presentation-prompts');

test('enrich system prompt forbids new facts and asks for JSON only', () => {
  const r = buildEnrichRequest({ conversation: '2nd-year CS', notes: '', titles: ['A', 'B'], batch: [{ n: 1, title: 'A', body: 'x', notes: '' }] });
  assert.match(r.system, /must not add facts, figures, dates, product names, prices, limits or citations/);
  assert.match(r.system, /\(image slide: add your own points\)/);
  assert.match(r.turns[0].text, /1\. A\n2\. B/);
  assert.equal(r.maxTokens, 5000);
  assert.equal(r.effort, 'medium');
});
test('parseEnrichResponse tolerates fences, caps fields and drops unknown slides', () => {
  const text = '```json\n[{"n":1,"points":["' + 'p'.repeat(200) + '","b","c","d","e"],"questions":["q1","q2","q3","q4"],"keyIdea":"k"},{"n":9,"points":["x"]}]\n```';
  const [s, ...rest] = parseEnrichResponse(text, [1, 2]);
  assert.equal(rest.length, 0);
  assert.equal(s.points.length, 5);
  assert.equal(s.points[0].length, 160);
  assert.equal(s.questions.length, 3);
});
test('parseEnrichResponse returns [] for prose', () => assert.deepEqual(parseEnrichResponse('Sorry, I cannot.', [1]), []));
test('parseEnrichResponse keeps single-point image slides and drops items with no points', () => {
  const out = parseEnrichResponse('[{"n":1,"points":["(image slide: add your own points)"],"questions":[]},{"n":2,"points":[]}]', [1, 2]);
  assert.equal(out.length, 1);
  assert.equal(out[0].keyIdea, '');
});
test('extractJson finds an object embedded in prose', () => {
  assert.deepEqual(extractJson('Sure! Here: {"slide": 3} hope that helps'), { slide: 3 });
});
test('extractJson is string-aware about brackets', () => {
  assert.deepEqual(extractJson('[{"a":"x ] } y \\" ["}] trailing ]'), [{ a: 'x ] } y " [' }]);
  assert.equal(extractJson('no json here'), null);
  assert.equal(extractJson('[1, 2'), null);
});

const {
  buildCoverageRequest, parseCoverageResponse, coverageFlag, coverageInput, COVERAGE_MIN_WORDS
} = require('../src/presentation-prompts');

const covSlide = { n: 4, title: 'Hash tables', keyIdea: 'Amortized O(1) inserts', points: ['Resize doubles capacity', 'Load factor'] };

test('coverage request carries key idea and points and accepts paraphrase', () => {
  const r = buildCoverageRequest({ slide: covSlide, transcript: 'we double the table' });
  assert.match(r.turns[0].text, /Amortized O\(1\) inserts/);
  assert.match(r.turns[0].text, /Load factor/);
  assert.match(r.turns[0].text, /we double the table/);
  assert.match(r.system, /paraphrase/i);
  assert.equal(r.maxTokens, 80);
  assert.equal(r.effort, 'low');
});
test('coverage transcript is capped at 4000 chars keeping the end', () => {
  const t = 'a'.repeat(1000) + 'b'.repeat(4000);
  const r = buildCoverageRequest({ slide: covSlide, transcript: t });
  assert.ok(r.turns[0].text.includes('b'.repeat(4000)));
  assert.ok(!r.turns[0].text.includes('aaaa'));
});
test('parseCoverageResponse handles json, prose and unknown status', () => {
  assert.deepEqual(parseCoverageResponse('{"status":"partial","missing":"amortized cost"}'), { status: 'partial', missing: 'amortized cost' });
  assert.deepEqual(parseCoverageResponse('```json\n{"status":"covered"}\n```'), { status: 'covered', missing: '' });
  assert.equal(parseCoverageResponse('They covered it well.'), null);
  assert.equal(parseCoverageResponse('{"status":"great"}'), null);
  const long = parseCoverageResponse('{"status":"missed","missing":"one two three four five six seven eight nine ten eleven twelve"}');
  assert.equal(long.missing.split(' ').length, 10);
});
test('coverageFlag text', () => {
  assert.equal(coverageFlag(4, { status: 'partial', missing: 'amortized cost' }), "Slide 4: didn't mention amortized cost");
  assert.equal(coverageFlag(4, { status: 'missed', missing: 'amortized cost' }), "Slide 4: didn't mention amortized cost");
  assert.equal(coverageFlag(4, { status: 'covered', missing: '' }), null);
  assert.equal(coverageFlag(4, null), null);
});
// 19 words: enough on its own to clear COVERAGE_MIN_WORDS.
const SPOKEN = 'so the formula has four parts: role, context, task and format, and each one narrows what Claude will guess';

test('coverageInput needs at least COVERAGE_MIN_WORDS spoken words', () => {
  const left = { n: 4, enterTs: 1000, leaveTs: 30000, dwellMs: 29000 };
  const few = Array.from({ length: COVERAGE_MIN_WORDS - 1 }, () => 'word').join(' ');
  assert.equal(coverageInput({ left, slide: covSlide, transcript: [{ channel: 'you', text: few, ts: 2000 }] }), null);
  assert.ok(coverageInput({ left, slide: covSlide, transcript: [{ channel: 'you', text: few + ' more', ts: 2000 }] }));
});

test('coverageInput selects You turns inside the visit and gates on dwell and key idea', () => {
  const left = { n: 4, enterTs: 1000, leaveTs: 30000, dwellMs: 29000 };
  const transcript = [
    { channel: 'you', text: 'before', ts: 500 },
    { channel: 'you', text: SPOKEN, ts: 1000 },
    { channel: 'them', text: 'question', ts: 2000 },
    { channel: 'you', text: 'two', ts: 30000 },
    { channel: 'you', text: 'after', ts: 31000 }
  ];
  assert.deepEqual(coverageInput({ left, slide: covSlide, transcript }), { slide: covSlide, transcript: SPOKEN + '\ntwo' });
  assert.equal(coverageInput({ left: { ...left, dwellMs: 5000 }, slide: covSlide, transcript }), null);
  assert.equal(coverageInput({ left, slide: { ...covSlide, keyIdea: '' }, transcript }), null);
  assert.equal(coverageInput({ left: null, slide: covSlide, transcript }), null);
  assert.equal(coverageInput({ left, slide: null, transcript }), null);
});

test('coverageInput is null when the presenter said nothing during the visit', () => {
  const left = { n: 4, enterTs: 1000, leaveTs: 30000, dwellMs: 29000 };
  assert.equal(coverageInput({ left, slide: covSlide, transcript: [] }), null);
  assert.equal(coverageInput({ left, slide: covSlide, transcript: [{ channel: 'them', text: 'hi', ts: 2000 }] }), null);
  assert.equal(coverageInput({ left, slide: covSlide, transcript: [{ channel: 'you', text: '   ', ts: 2000 }] }), null);
});

test('coverageInput graceMs takes You turns finalised shortly after leaving the slide', () => {
  const left = { n: 4, enterTs: 1000, leaveTs: 30000, dwellMs: 29000 };
  const transcript = [
    { channel: 'you', text: SPOKEN, ts: 2000 },
    { channel: 'you', text: 'late', ts: 32500 },
    { channel: 'you', text: 'next slide', ts: 33500 }
  ];
  assert.equal(coverageInput({ left, slide: covSlide, transcript }).transcript, SPOKEN, 'default grace is 0');
  assert.equal(coverageInput({ left, slide: covSlide, transcript, graceMs: 3000 }).transcript, SPOKEN + '\nlate');
  assert.deepEqual(coverageInput({ left, slide: covSlide, transcript: [{ channel: 'you', text: SPOKEN, ts: 32000 }], graceMs: 3000 }),
    { slide: covSlide, transcript: SPOKEN });
});

test('enrichment asks for a full speaker script that covers the whole slide', () => {
  const r = buildEnrichRequest({ conversation: 'engineers', notes: '', titles: ['A', 'B'], batch: [{ n: 1, title: 'A', body: 'x', notes: 'say the analogy', next: 'B' }] });
  assert.match(r.system, /"script"/);
  assert.match(r.system, /Cover the items on the slide/);
  assert.match(r.system, /speaker notes/);
  assert.match(r.system, /leads into the next slide/);
  assert.match(r.system, /must not add facts, figures/);
  assert.match(r.system, /3 to 5/);
  assert.ok(r.maxTokens >= 4000, 'room for four scripts');
});

test('parseEnrichResponse keeps the script, capped, and five points', () => {
  const long = 'w '.repeat(1200).trim();
  const [s] = parseEnrichResponse(JSON.stringify([{ n: 1, points: ['a', 'b', 'c', 'd', 'e', 'f'], questions: [], keyIdea: 'k', script: long }]), [1]);
  assert.equal(s.points.length, 5);
  assert.ok(s.script.length <= 2400 && s.script.length > 1000);
  const sentences = Array.from({ length: 40 }, (_, i) => 'Sentence number ' + i + ' explains one more thing for the room.').join(' ');
  const [u] = parseEnrichResponse(JSON.stringify([{ n: 1, points: ['a'], script: sentences }]), [1]);
  assert.ok(u.script.length <= 2400);
  assert.match(u.script, /\.$/, 'a long script is cut at the end of a sentence, never mid-sentence');
  const [t] = parseEnrichResponse(JSON.stringify([{ n: 1, points: ['a'], keyIdea: 'k' }]), [1]);
  assert.equal(t.script, '', 'a missing script is empty, not an error');
});

test('a script over its word limit is cut at a sentence end', () => {
  const sentences = Array.from({ length: 25 }, (_, i) => 'Point ' + i + ' is said once and clearly here.').join(' ');
  const words = (s) => s.split(/\s+/).filter(Boolean).length;
  const cut = (scriptLength) => parseEnrichResponse(JSON.stringify([{ n: 1, points: ['a'], script: sentences }]), [1], { scriptLength })[0].script;
  assert.ok(words(cut('short')) <= 92 && words(cut('short')) >= 80, 'short allows 15% over 80 words');
  assert.ok(words(cut('standard')) <= 150 && words(cut('standard')) >= 135);
  assert.equal(words(cut('detailed')), 200, 'within the detailed limit nothing is cut');
  assert.match(cut('short'), /here\.$/);
  const one = 'word '.repeat(300).trim() + '.';
  assert.equal(parseEnrichResponse(JSON.stringify([{ n: 1, points: ['a'], script: one }]), [1], { scriptLength: 'short' })[0].script, one, 'a single long sentence is kept rather than emptied');
});

test('script length sets a hard word range', () => {
  const req = (scriptLength) => buildEnrichRequest({ conversation: '', notes: '', titles: ['A'], batch: [{ n: 1, title: 'A', body: 'x', notes: '', next: '' }], scriptLength }).system;
  assert.match(req('short'), /about 65 words \(50 to 80, never more than 80\)/);
  assert.match(req('standard'), /about 105 words \(80 to 130, never more than 130\)/);
  assert.match(req('detailed'), /about 165 words \(130 to 200, never more than 200\)/);
  assert.match(req(undefined), /80 to 130/, 'standard by default');
  assert.match(req('short'), /one short sentence/);
  assert.match(req('standard'), /leave the rest to the key points/);
});
