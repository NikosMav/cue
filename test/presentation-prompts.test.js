const test = require('node:test');
const assert = require('node:assert/strict');
const { buildEnrichRequest, parseEnrichResponse, extractJson } = require('../src/presentation-prompts');

test('enrich system prompt forbids new facts and asks for JSON only', () => {
  const r = buildEnrichRequest({ conversation: '2nd-year CS', notes: '', titles: ['A', 'B'], batch: [{ n: 1, title: 'A', body: 'x', notes: '' }] });
  assert.match(r.system, /must not add facts, figures or citations/);
  assert.match(r.system, /\(image slide: add your own points\)/);
  assert.match(r.turns[0].text, /1\. A\n2\. B/);
  assert.equal(r.maxTokens, 2500);
  assert.equal(r.effort, 'medium');
});
test('parseEnrichResponse tolerates fences, caps fields and drops unknown slides', () => {
  const text = '```json\n[{"n":1,"points":["' + 'p'.repeat(200) + '","b","c","d","e"],"questions":["q1","q2","q3","q4"],"keyIdea":"k"},{"n":9,"points":["x"]}]\n```';
  const [s, ...rest] = parseEnrichResponse(text, [1, 2]);
  assert.equal(rest.length, 0);
  assert.equal(s.points.length, 4);
  assert.equal(s.points[0].length, 140);
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
