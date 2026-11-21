import test from 'node:test';
import assert from 'node:assert/strict';
import { isSameOrigin } from './url-policy.js';

test('same-origin policy permits same protocol, host and port', () => {
  assert.equal(isSameOrigin('https://shop.example.test/products/1', 'https://shop.example.test'), true);
  assert.equal(isSameOrigin('https://shop.example.test:8443/products/1', 'https://shop.example.test:8443'), true);
});

test('same-origin policy rejects cross-host, cross-port and cross-scheme navigation', () => {
  assert.equal(isSameOrigin('https://other.example.test/p/1', 'https://shop.example.test'), false);
  assert.equal(isSameOrigin('https://shop.example.test:8443/p/1', 'https://shop.example.test'), false);
  assert.equal(isSameOrigin('http://shop.example.test/p/1', 'https://shop.example.test'), false);
});

test('same-origin policy rejects embedded credentials and unsupported protocols', () => {
  assert.equal(isSameOrigin('https://user:pass@shop.example.test/p/1', 'https://shop.example.test'), false);
  assert.equal(isSameOrigin('ftp://shop.example.test/p/1', 'ftp://shop.example.test'), false);
  assert.equal(isSameOrigin('https://shop.example.test/p/1', 'https://user:pass@shop.example.test'), false);
  assert.equal(isSameOrigin('not a URL', 'https://shop.example.test'), false);
});
