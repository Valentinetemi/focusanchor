import assert from 'node:assert/strict';
import test from 'node:test';

const core = await import(new URL('../dist/aiCore.js', import.meta.url));

function provider(overrides = {}) {
  return {
    availability: async () => 'available',
    initialize: async (_task, _mode, onProgress) => { onProgress(1); },
    generate: async () => ({
      text: JSON.stringify({
        whyItMatters: 'This reference supports the mission.',
        nextAction: 'Review the examples.',
        contextNote: 'Use the second example in the draft.',
        question: null,
      }),
      source: 'on-device',
    }),
    ...overrides,
  };
}

test('structured Smart Anchor responses are validated', () => {
  assert.deepEqual(core.parseSmartAnchor(JSON.stringify({
    whyItMatters: '  It contains the API details. ',
    nextAction: 'Compare the two examples.',
    contextNote: 'Use the second example.',
    question: 'Does this cover offline behavior?',
  })), {
    whyItMatters: 'It contains the API details.',
    nextAction: 'Compare the two examples.',
    contextNote: 'Use the second example.',
    question: 'Does this cover offline behavior?',
  });
});

test('malformed model output is rejected without a partial anchor', () => {
  assert.throws(
    () => core.parseSmartAnchor('{"whyItMatters":"missing fields"}'),
    (error) => error instanceof core.AiError && error.code === 'malformed-output',
  );
  assert.throws(
    () => core.parseSmartAnchor('certainly not JSON'),
    (error) => error instanceof core.AiError && error.code === 'malformed-output',
  );
});

test('Device Only stops before generation when the device model is unavailable', async () => {
  let generated = false;
  await assert.rejects(core.runAiTask({
    provider: provider({
      availability: async () => 'unavailable',
      generate: async () => { generated = true; return { text: '{}', source: 'cloud-fallback' }; },
    }),
    task: 'smart-anchor',
    prompt: 'test',
    mode: 'device-only',
    cloudConsent: false,
    parse: core.parseSmartAnchor,
  }), (error) => error.code === 'device-unavailable');
  assert.equal(generated, false);
});

test('Hybrid mode reports a real cloud fallback source', async () => {
  const result = await core.runAiTask({
    provider: provider({
      availability: async () => 'downloadable',
      initialize: async () => new Promise(() => {}),
      generate: async () => ({
        text: JSON.stringify({
          whyItMatters: 'Relevant source.', nextAction: 'Read it.', contextNote: 'Review later.', question: null,
        }),
        source: 'cloud-fallback',
      }),
    }),
    task: 'smart-anchor',
    prompt: 'test',
    mode: 'hybrid',
    cloudConsent: true,
    parse: core.parseSmartAnchor,
  });
  assert.equal(result.source, 'cloud-fallback');
});

test('Device Only rejects any provider that returns cloud output', async () => {
  await assert.rejects(core.runAiTask({
    provider: provider({ generate: async () => ({ text: '{}', source: 'cloud-fallback' }) }),
    task: 'smart-anchor',
    prompt: 'test',
    mode: 'device-only',
    cloudConsent: false,
    parse: core.parseSmartAnchor,
  }), (error) => error.code === 'privacy-violation');
});

test('App Check failures are identified', async () => {
  await assert.rejects(core.runAiTask({
    provider: provider({ generate: async () => { throw Object.assign(new Error('request rejected'), { code: 'app-check/token-error' }); } }),
    task: 'smart-anchor',
    prompt: 'test',
    mode: 'hybrid',
    cloudConsent: true,
    parse: core.parseSmartAnchor,
  }), (error) => error.code === 'app-check');
});

test('offline cloud fallback returns a recoverable error', async () => {
  await assert.rejects(core.runAiTask({
    provider: provider({
      availability: async () => 'unavailable',
      generate: async () => { throw new TypeError('Failed to fetch'); },
    }),
    task: 'smart-anchor',
    prompt: 'test',
    mode: 'hybrid',
    cloudConsent: true,
    parse: core.parseSmartAnchor,
  }), (error) => error.code === 'offline');
});

test('user cancellation discards a pending response', async () => {
  const controller = new AbortController();
  const pending = core.runAiTask({
    provider: provider({ generate: async () => new Promise(() => {}) }),
    task: 'smart-anchor',
    prompt: 'test',
    mode: 'device-only',
    cloudConsent: false,
    parse: core.parseSmartAnchor,
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(pending, (error) => error.code === 'cancelled');
});

test('restart briefs can only select a supplied mission tab', () => {
  assert.deepEqual(core.parseRestartBrief(JSON.stringify({
    firstTabRef: 'A2', firstTabReason: 'It has the implementation notes.', nextAction: 'Open it and review the checklist.',
  }), ['A1', 'A2']), {
    firstTabRef: 'A2', firstTabReason: 'It has the implementation notes.', nextAction: 'Open it and review the checklist.',
  });
  assert.throws(
    () => core.parseRestartBrief(JSON.stringify({ firstTabRef: 'A9', firstTabReason: 'Invented.', nextAction: 'Guess.' }), ['A1']),
    (error) => error.code === 'malformed-output',
  );
});
