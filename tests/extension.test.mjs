import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { JSDOM } from 'jsdom';

await test('mission, tab parking, context recovery, and session completion', async () => {
  const dist = new URL('../dist/', import.meta.url);
  const manifest = JSON.parse(await readFile(new URL('manifest.json', dist)));
  const [missionTab, distraction] = [
    { id: 1, url: 'https://example.com/work', title: 'Work', active: true },
    { id: 2, url: 'https://example.com/article', title: 'Fourier transform', active: false },
  ];
  const tabs = new Map([[1, missionTab], [2, distraction]]);
  const changes = new Set();
  let stored = {};
  let messageHandler;
  let activationHandler;
  let rejectWrite = false;
  let saveObservedBeforeClose = false;
  const sender = { id: 'focusanchor-test' };
  const activate = (tabId) => {
    for (const tab of tabs.values()) tab.active = tab.id === tabId;
    activationHandler({ tabId });
  };
  globalThis.chrome = {
    runtime: {
      id: sender.id,
      onMessage: { addListener: (fn) => { messageHandler = fn; } },
      sendMessage: (request) => new Promise((resolve) => messageHandler(request, sender, resolve)),
    },
    storage: {
      onChanged: { addListener: (fn) => changes.add(fn), removeListener: (fn) => changes.delete(fn) },
      local: {
        get: async () => structuredClone(stored),
        set: async (data) => {
          if (rejectWrite) throw new Error('Storage full');
          stored = structuredClone(data);
          for (const fn of changes) fn({ focusAnchor: { newValue: stored.focusAnchor } }, 'local');
        },
      },
    },
    tabs: {
      query: async () => [...tabs.values()].filter((tab) => tab.active),
      get: async (id) => {
        if (!tabs.has(id)) throw new Error('Tab closed');
        return { ...tabs.get(id) };
      },
      remove: async (id) => {
        saveObservedBeforeClose = stored.focusAnchor.parked.some((item) => item.url === tabs.get(id).url);
        tabs.delete(id);
        activate(1);
      },
      create: async ({ url }) => {
        tabs.set(3, { id: 3, url });
        activate(3);
      },
      onActivated: { addListener: (fn) => { activationHandler = fn; } },
    },
  };

  const send = globalThis.chrome.runtime.sendMessage;
  await import(new URL(manifest.background.service_worker, dist));
  assert.equal((await send({ type: 'start', text: 'Finish my submission' })).ok, true);
  activate(2);
  activate(2);

  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://focusanchor.test' });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    location: dom.window.location,
    MutationObserver: dom.window.MutationObserver,
  });
  const eventually = async (predicate) => {
    for (let attempt = 0; attempt < 50 && !predicate(); attempt += 1) await delay(20);
    assert.ok(predicate());
  };
  try {
    const html = await readFile(new URL(manifest.action.default_popup, dist), 'utf8');
    const script = html.match(/src="([^"]+\.js)"/)?.[1];
    assert.ok(script);
    await import(new URL(script, dist));
    await eventually(() => document.body.textContent.includes(distraction.title));
    assert.match(document.body.textContent, /Finish my submission/);

    const park = { type: 'park', tabId: 2, url: distraction.url, reason: 'Read the examples after submitting' };
    const wrongUrl = await send({ ...park, url: 'https://example.com/different' });
    assert.equal(wrongUrl.ok, false);
    assert.equal(tabs.has(2), true);

    rejectWrite = true;
    assert.equal((await send(park)).ok, false);
    assert.equal(tabs.has(2), true);
    rejectWrite = false;

    assert.equal((await send(park)).ok, true);
    assert.equal(saveObservedBeforeClose, true);
    assert.equal(tabs.has(2), false);
    await eventually(() => document.body.textContent.includes(park.reason));
    assert.match(document.body.textContent, /During: Finish my submission/);

    const [{ id }] = stored.focusAnchor.parked;
    assert.equal((await send({ type: 'recover', id })).ok, true);
    assert.equal(tabs.get(3).url, distraction.url);
    await eventually(() => stored.focusAnchor.mission.tabSwitches === 3);

    document.querySelector('.finish').click();
    await eventually(() => stored.focusAnchor.completedSessions === 1);
    assert.equal(stored.focusAnchor.mission, null);
    assert.equal((await send({ type: 'remove', id })).ok, true);
    await eventually(() => document.body.textContent.includes('Your saved tabs and reasons'));
  } finally {
    dom.window.close();
    delete globalThis.chrome;
  }
});
