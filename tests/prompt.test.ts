import assert from 'node:assert/strict';
import test from 'node:test';
import { askOnce, askWithFallback, type HybridModel } from '../src/ask.ts';
import {
  cleanNudge,
  clipText,
  CONFIG_HINT,
  draftPrompt,
  friendlyAiError,
  pageLocation,
  parseDraft,
  refocusPrompt,
  routeFrom,
  routeName,
} from '../src/promptText.ts';

const missions = [
  { id: 'write', text: 'Finish the submission' },
  { id: 'mail', text: 'Reply to mail' },
];

function model(text: string, source?: string, calls?: string[]): HybridModel {
  return {
    initializeDeviceModel: async () => {
      calls?.push('init');
    },
    generateContent: async (prompt) => {
      calls?.push(prompt);
      return { response: { text: () => text, inferenceSource: source } };
    },
  };
}

await test('draft parsing keeps a real mission and drops an unknown one', () => {
  const parsed = parseDraft(`Sure\n\`\`\`json\n${JSON.stringify({
    note: 'Compare the Prompt API notes with the README.',
    summary: 'Docs for the Chrome Prompt API.',
    missionId: 'write',
    reason: 'The page is part of the submission.',
  })}\n\`\`\``, missions, 240);
  assert.equal(parsed?.note, 'Compare the Prompt API notes with the README.');
  assert.equal(parsed?.summary, 'Docs for the Chrome Prompt API.');
  assert.equal(parsed?.missionId, 'write');
  assert.equal(parsed?.reason, 'The page is part of the submission.');

  const byName = parseDraft(JSON.stringify({
    note: 'Answer Maya about the demo time.',
    summary: 'An email thread.',
    missionId: 'Reply to mail',
    reason: 'The subject is the demo.',
  }), missions, 240);
  assert.equal(byName?.missionId, 'mail');

  const loose = parseDraft(JSON.stringify({
    note: 'Skim this later.',
    summary: 'A recipe.',
    missionId: 'cooking',
    reason: 'Not a mission.',
  }), missions, 20);
  assert.equal(loose?.note, 'Skim this later.');
  assert.equal(loose?.missionId, null);
  assert.equal(loose?.reason, '');
  assert.equal(parseDraft('not json', missions, 240), null);
  assert.equal(parseDraft('{"summary":"only"}', missions, 240), null);
});

await test('prompts hide the query string and shorten long pages', () => {
  assert.equal(pageLocation('https://www.example.com/docs/nano?token=secret#top'), 'www.example.com/docs/nano');
  assert.equal(pageLocation('chrome://extensions'), '');
  const clipped = clipText('one two three four', 10);
  assert.equal(clipped.truncated, true);
  assert.equal(clipped.text.includes('three'), false);
  const prompt = draftPrompt({
    title: 'Prompt API',
    location: 'example.com/docs',
    selection: 'Gemini Nano',
    excerpt: 'A long article',
    truncated: true,
    missions,
  });
  assert.match(prompt, /write: Finish the submission/);
  assert.match(prompt, /shortened so it can run on device/);
  assert.doesNotMatch(prompt, /token=secret/);
  const nudge = refocusPrompt({
    title: 'Prompt API',
    note: 'Compare the examples.',
    summary: 'Docs for the Prompt API.',
    mission: 'Finish the submission',
  });
  assert.match(nudge, /Compare the examples/);
  assert.equal(cleanNudge('  "You saved this to compare the examples."  '), 'You saved this to compare the examples.');
  assert.equal(cleanNudge(`x${'y'.repeat(400)}`).endsWith('...'), true);
  assert.throws(() => cleanNudge('   '), /empty/);
});

await test('route labels and friendly errors stay short', () => {
  assert.equal(routeFrom('on_device'), 'on-device');
  assert.equal(routeFrom('in_cloud'), 'cloud');
  assert.equal(routeFrom(undefined), 'cloud');
  assert.equal(routeName('on-device'), 'On-device (Gemini Nano)');
  assert.equal(routeName('cloud'), 'Cloud');
  assert.match(friendlyAiError(new Error('App Check token rejected')), /debug token/);
  assert.match(friendlyAiError(new Error('API key not valid')), /AI Logic/);
  assert.match(friendlyAiError(new Error('Failed to fetch')), /cloud model/);
  assert.match(CONFIG_HINT, /firebase-config\.js/);
});

await test('hybrid asks call the model and fall back after a failure', async () => {
  const calls: string[] = [];
  const direct = await askOnce('hello', model('{"note":"hi"}', 'on_device', calls));
  assert.equal(direct.route, 'on-device');
  assert.deepEqual(calls, ['init', 'hello']);

  const modes: string[] = [];
  const answer = await askWithFallback('short page', 'long page', async (mode) => {
    modes.push(mode);
    if (mode === 'prefer_on_device') throw new Error('context length');
    return model('cloud answer', 'in_cloud');
  });
  assert.deepEqual(modes, ['prefer_on_device', 'only_in_cloud']);
  assert.equal(answer.text, 'cloud answer');
  assert.equal(answer.route, 'cloud');

  await assert.rejects(
    askWithFallback('once', 'twice', async () => {
      throw new Error('App Check blocked the request');
    }),
    /App Check blocked/,
  );
});
