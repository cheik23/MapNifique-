import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { CheerioCrawler } from 'crawlee';

const visited = new Set();
const server = createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  if (request.url === '/') {
    response.end('<!doctype html><html><body><a href="/next">next</a></body></html>');
  } else if (request.url === '/next') {
    response.end('<!doctype html><html><body><h1>next page</h1></body></html>');
  } else {
    response.writeHead(404);
    response.end('not found');
  }
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});

try {
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const crawler = new CheerioCrawler({
    maxConcurrency: 1,
    maxRequestsPerCrawl: 2,
    requestHandlerTimeoutSecs: 20,
    async requestHandler({ request, enqueueLinks }) {
      const pathname = new URL(request.url).pathname;
      visited.add(pathname);
      if (pathname === '/') {
        await enqueueLinks({
          strategy: 'same-domain',
          globs: [`${baseUrl}/**`],
        });
      }
    },
  });

  await crawler.run([`${baseUrl}/`]);
  assert.deepEqual([...visited].sort(), ['/', '/next']);
  console.log('CRAWLEE_MINIMATCH_ENQUEUE_LINKS=PASS');
  console.log(`PAGES_VISITED=${visited.size}`);
} finally {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
