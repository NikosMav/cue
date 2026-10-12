const test = require('node:test');
const assert = require('node:assert/strict');
const { findSetupSpecificLines } = require('../src/about-me-check');

const setups = [
  { id: 'any', name: 'Any conversation' },
  { id: 'i', name: 'Interview' },
  { id: 'n', name: 'NobleProg intro' },
  { id: 'g', name: 'Συνέντευξη Πειραιώς' }
];

test('a neutral About me raises nothing', () => {
  const aboutMe = {
    resumeText: 'Software engineer in Athens.\nEnglish C2, German B1.\nC, C++, Java, Python.',
    stories: 'Story 1: fixed a memory leak at Canon.',
    workStyle: 'Reproduce first, change one thing at a time.'
  };
  assert.deepEqual(findSetupSpecificLines(aboutMe, setups), []);
});

test('a line naming another setup is flagged, but generic setup words are not', () => {
  const found = findSetupSpecificLines({ stories: 'I had an interview last year.\nAt NobleProg I would teach Python.' }, setups);
  assert.equal(found.length, 1);
  assert.deepEqual({ field: found[0].field, label: found[0].label, line: found[0].line }, { field: 'stories', label: 'Stories', line: 2 });
  assert.match(found[0].reason, /"NobleProg" from the setup "NobleProg intro"/);
});

test('setup names in Greek are matched as whole words', () => {
  assert.equal(findSetupSpecificLines({ resumeText: 'Προετοιμασία για Πειραιώς.' }, setups).length, 1);
  assert.equal(findSetupSpecificLines({ resumeText: 'Πειραιώςxyz' }, setups).length, 0);
});

test('positioning for one opportunity is flagged', () => {
  const lines = [
    'Open to relocating to Germany.',
    'Excited about this role at the bank.',
    'Applying for the senior position.',
    'Day rate EUR 400.'
  ];
  const found = findSetupSpecificLines({ resumeText: lines.join('\n') }, setups);
  assert.deepEqual(found.map((f) => f.line), [1, 2, 3, 4]);
});

test('the built-in setup name never counts', () => {
  assert.deepEqual(findSetupSpecificLines({ workStyle: 'Any conversation is a chance to learn.' }, setups), []);
});
