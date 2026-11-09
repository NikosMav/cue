// The real @anthropic-ai/sdk against a local server that speaks Anthropic's
// streaming format, so an SDK upgrade that changes the wire, the headers or
// cancellation shows up here (the other Anthropic tests stub the SDK).
const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('http');

const sse = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withServer(handler, fn) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      seen.push({ url: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : null });
      handler(req, res);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const previous = process.env.ANTHROPIC_BASE_URL;
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(seen);
  } finally {
    if (previous === undefined) delete process.env.ANTHROPIC_BASE_URL; else process.env.ANTHROPIC_BASE_URL = previous;
    server.closeAllConnections && server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
}

function stream(res, events) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  for (const [event, data] of events) res.write(sse(event, data));
  res.end();
}

const { createLLM, LENGTH_CUT_NOTE } = require('../src/llm');
const settings = (model) => ({ provider: 'anthropic', apiKeys: { anthropic: 'sk-ant-test' }, models: { anthropic: { fast: model } } });
const start = { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'x', content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } };
const block = { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
const delta = (text) => ({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
const stop = (reason) => ({ type: 'message_delta', delta: { stop_reason: reason, stop_sequence: null }, usage: { output_tokens: 5 } });

test('real SDK: a streamed answer, the cached system prefix and the thinking-model shape reach the wire', async () => {
  await withServer((_req, res) => stream(res, [
    ['message_start', start], ['content_block_start', block],
    ['content_block_delta', delta('Hello ')], ['content_block_delta', delta('there.')],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', stop('end_turn')], ['message_stop', { type: 'message_stop' }]
  ]), async (seen) => {
    const tokens = [];
    const result = await createLLM(settings('claude-sonnet-5-5')).stream({
      system: 'REFERENCE\n\nRules.', cachePrefix: 'REFERENCE', turns: [{ role: 'user', text: 'q' }], effort: 'low', onToken: (t) => tokens.push(t)
    });
    assert.equal(result, 'Hello there.');
    assert.deepEqual(tokens, ['Hello ', 'there.']);
    const { body, headers, url } = seen[0];
    assert.equal(url, '/v1/messages');
    // SDK 1.x: API version 2026-10-21, and the key as a bearer token (the
    // Claude API accepts either header).
    assert.equal(headers['anthropic-version'], '2026-10-21');
    assert.equal(headers.authorization, 'Bearer sk-ant-test');
    assert.equal(headers['x-api-key'], undefined);
    assert.match(headers['anthropic-beta'] || '', /server-side-fallback/);
    assert.equal(body.stream, true);
    assert.deepEqual(body.output_config, { effort: 'low' });
    assert.equal(body.system[0].cache_control.type, 'ephemeral');
  });
});

test('real SDK: max_tokens after some text keeps it with the cut-off note', async () => {
  await withServer((_req, res) => stream(res, [
    ['message_start', start], ['content_block_start', block], ['content_block_delta', delta('Partial')],
    ['message_delta', stop('max_tokens')], ['message_stop', { type: 'message_stop' }]
  ]), async () => {
    assert.equal(await createLLM(settings('claude-haiku-4-5')).stream({ system: 's', turns: [{ role: 'user', text: 'q' }], onToken: () => {} }), 'Partial' + LENGTH_CUT_NOTE);
  });
});

test('real SDK: cancelling closes the connection', async () => {
  let closed = false;
  await withServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(sse('message_start', start));
    const timer = setInterval(() => res.write(sse('ping', { type: 'ping' })), 30);
    res.on('close', () => { closed = true; clearInterval(timer); });
  }, async () => {
    const controller = new AbortController();
    const answer = createLLM(settings('claude-haiku-4-5')).stream({ system: 's', turns: [{ role: 'user', text: 'q' }], onToken: () => {}, signal: controller.signal });
    answer.catch(() => {});
    await sleep(150);
    controller.abort();
    await assert.rejects(answer);
    for (let i = 0; i < 40 && !closed; i++) await sleep(25);
    assert.equal(closed, true);
  });
});
