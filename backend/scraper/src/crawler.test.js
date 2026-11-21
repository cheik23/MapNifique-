import assert from 'node:assert/strict';
import test from 'node:test';
import { bindLeaseAbortSignal } from './crawler-control.js';

test('lease loss pauses active crawler handlers before aborting the pool', async () => {
  const calls = [];
  const controller = new AbortController();
  const crawler = {
    running: true,
    autoscaledPool: {
      async pause() { calls.push('pause'); },
      async abort() { calls.push('abort'); },
    },
  };

  const unbind = bindLeaseAbortSignal(crawler, controller.signal);
  controller.abort(new Error('Lease perdue.'));
  await unbind();

  assert.deepEqual(calls, ['pause', 'abort']);
});

test('lease loss waits for Crawlee to initialize its pool', async () => {
  const calls = [];
  const controller = new AbortController();
  const crawler = { running: true, autoscaledPool: undefined };
  const unbind = bindLeaseAbortSignal(crawler, controller.signal);

  controller.abort();
  await new Promise(resolve => setTimeout(resolve, 20));
  crawler.autoscaledPool = {
    async pause() { calls.push('pause'); },
    async abort() { calls.push('abort'); },
  };
  await unbind();

  assert.deepEqual(calls, ['pause', 'abort']);
});
