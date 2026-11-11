import http from 'node:http';
import { writeFileSync } from 'node:fs';
let n = 0;
http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const auth = req.headers.authorization ?? '';
    const meta = { path: req.url, method: req.method, contentType: req.headers['content-type'], authShape: auth.replace(/[A-Za-z0-9]{6,}/g, '<tok>') };
    writeFileSync(`${process.argv[2]}/${String(++n).padStart(3, '0')}-${req.url.replace(/\W/g, '_')}.json`, JSON.stringify({ meta, body: JSON.parse(Buffer.concat(chunks).toString() || 'null') }, null, 2));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
}).listen(43999, '127.0.0.1');
