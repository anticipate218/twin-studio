import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { getJSON, postJSON } from '../static/js/api.js';

test('API responses, actionable failures and bounded read requests', async (t) => {
  const server = http.createServer((req, res) => {
    if (req.url === '/slow') return setTimeout(() => res.end('{}'), 150);
    if (req.url === '/bad') { res.writeHead(409); return res.end(JSON.stringify({error:'依赖未就绪'})); }
    if (req.url === '/invalid') return res.end('not-json');
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ok:true, method:req.method}));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await t.test('JSON success and POST semantics', async () => {
      assert.deepEqual(await getJSON(base), {ok:true, method:'GET'});
      assert.deepEqual(await postJSON(base, {}), {ok:true, method:'POST'});
    });
    await t.test('preserves server error messages', async () => {
      await assert.rejects(getJSON(base + '/bad'), /依赖未就绪/);
    });
    await t.test('invalid JSON gives a readable error', async () => {
      await assert.rejects(getJSON(base + '/invalid'), /响应格式异常/);
    });
    await t.test('a stalled read has a timeout and can be retried', async () => {
      await assert.rejects(getJSON(base + '/slow', {timeout:20}), /请求超时/);
      assert.equal((await getJSON(base)).ok, true);
    });
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
