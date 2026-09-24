const test = require('node:test');
const assert = require('node:assert/strict');
const { streamWithWatchdog } = require('../src/stream-watchdog');

test('timeout aborts an unresponsive request and suppresses late output', async () => {
  let request;
  let aborted = false;
  const tokens = [];
  const stream = params => {
    request = params;
    return new Promise((_resolve, reject) => {
      params.signal.addEventListener('abort', () => {
        aborted = true;
        reject(new Error('provider aborted'));
      }, { once: true });
    });
  };
  await assert.rejects(streamWithWatchdog(stream, { onToken: t => tokens.push(t) }, 20), /timed out/);
  assert.equal(aborted, true);
  request.onToken('late answer from abandoned request');
  assert.deepEqual(tokens, []);
  assert.equal(await streamWithWatchdog(async p => { p.onToken('next'); return 'next'; },
    { onToken: t => tokens.push(t) }, 1000), 'next');
  assert.deepEqual(tokens, ['next']);
});

test('completed and failed streams close their request and cannot emit late tokens', async () => {
  for (const fails of [false, true]) {
    let request;
    const tokens = [];
    const result = streamWithWatchdog(async params => {
      request = params;
      params.onToken('partial');
      if (fails) throw new Error('connection lost');
      return 'partial';
    }, { onToken: t => tokens.push(t) });
    if (fails) await assert.rejects(result, /connection lost/);
    else assert.equal(await result, 'partial');
    assert.equal(request.signal.aborted, true);
    request.onToken('late');
    assert.deepEqual(tokens, ['partial']);
  }
});
