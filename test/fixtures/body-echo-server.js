'use strict';

/**
 * HTTP handler for the large-body tests: it never holds a body in memory.
 *
 *   GET /bytes/<n>   responds with n bytes of "x" (Content-Length set),
 *                    written block by block with backpressure.
 *   anything else    reads the request body and responds with a JSON summary:
 *                    { method, bytes, sha256, head, tail, contentLength,
 *                      transferEncoding, expect }
 *                    head / tail are the first 32 / last 64 bytes as latin1.
 *
 * It is self-contained (no closure variables) so that the kubectl e2e suite can
 * run the very same function in a node:slim pod via `bodyEchoHandler.toString()`.
 */
function bodyEchoHandler(req, res) {
  const crypto = require('crypto');

  const bytesRoute = /^\/bytes\/(\d+)$/.exec(req.url);
  if (req.method === 'GET' && bytesRoute) {
    let left = Number(bytesRoute[1]);
    const block = Buffer.alloc(64 * 1024, 'x');
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': left });
    const write = () => {
      while (left > 0) {
        const chunk = left >= block.length ? block : block.subarray(0, left);
        left -= chunk.length;
        if (!res.write(chunk)) {
          res.once('drain', write);
          return;
        }
      }
      res.end();
    };
    write();
    return;
  }

  const hash = crypto.createHash('sha256');
  let bytes = 0;
  let head = Buffer.alloc(0);
  let tail = Buffer.alloc(0);
  req.on('data', (chunk) => {
    hash.update(chunk);
    bytes += chunk.length;
    if (head.length < 32) head = Buffer.concat([head, chunk.subarray(0, 32 - head.length)]);
    tail = Buffer.concat([tail, chunk.subarray(-64)]).subarray(-64);
  });
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      method: req.method,
      bytes,
      sha256: hash.digest('hex'),
      head: head.toString('latin1'),
      tail: tail.toString('latin1'),
      contentLength: req.headers['content-length'] || null,
      transferEncoding: req.headers['transfer-encoding'] || null,
      expect: req.headers.expect || null,
    }));
  });
}

module.exports = { bodyEchoHandler };
