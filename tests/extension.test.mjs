import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { JSDOM } from 'jsdom';

await test('notes can keep tabs open, close safely, update, and open without duplicates', async () => {
  const dist = new URL('../dist/', import.meta.url);
  const manifest = JSON.parse(await readFile(new URL('manifest.json', dist)));
  const popupBundle = await readFile(new URL(manifest.action.default_popup, dist), 'utf8')
    .then((html) => html.match(/src="([^"]+\.js)"/)?.[1])
    .then(async (script) => {
      assert.ok(script);
      return { script, source: await readFile(new URL(script, dist), 'utf8') };
    });
  assert.ok(manifest.permissions.includes('tabs'));
  assert.match(popupBundle.source, /Save note & keep open/);
  assert.match(popupBundle.source, /Save note & close tab/);

  const [missionTab, keptTab, closedTab] = [
    { id: 1, windowId: 10, url: 'https://example.com/work', title: 'Work', active: true },
    { id: 2, windowId: 10, url: 'https://example.com/article', title: 'Fourier transform', active: false },
    { id: 4, windowId: 20, url: 'https://example.com/reference', title: 'Reference guide', active: false },
  ];
  const tabs = new Map([[1, missionTab], [2, keptTab], [4, closedTab]]);
  const changes = new Set();
  const tabUpdates = [];
  const windowUpdates = [];
  let stored = {};
  let messageHandler;
  let activationHandler;
  let rejectWrite = false;
  let saveObservedBeforeClose = false;
  let createdTabs = 0;
  let nextTabId = 5;
  const sender = { id: 'focusanchor-test' };
  const activate = (tabId) => {
    const selected = tabs.get(tabId);
    for (const tab of tabs.values()) tab.active = tab.id === tabId;
    activationHandler?.({ tabId, windowId: selected?.windowId });
  };
  globalThis.chrome = {
    runtime: {
      id: sender.id,
      getURL: (path) => `chrome-extension://${sender.id}/${path}`,
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
      query: async (query) => [...tabs.values()]
        .filter((tab) => !query.active || tab.active)
        .map((tab) => ({ ...tab })),
      get: async (id) => {
        if (!tabs.has(id)) throw new Error('Tab closed');
        return { ...tabs.get(id) };
      },
      update: async (id, properties) => {
        const tab = tabs.get(id);
        if (!tab) throw new Error('Tab closed');
        tabUpdates.push({ id, ...properties });
        if (properties.active && !tab.active) activate(id);
        Object.assign(tab, properties);
        return { ...tab };
      },
      remove: async (id) => {
        const tab = tabs.get(id);
        saveObservedBeforeClose = stored.focusAnchor.parked.some((item) => item.url === tab.url);
        tabs.delete(id);
        activate(1);
      },
      create: async ({ url }) => {
        const tab = { id: nextTabId++, windowId: 10, url, title: url, active: false };
        tabs.set(tab.id, tab);
        createdTabs += 1;
        activate(tab.id);
        return { ...tab };
      },
      onActivated: { addListener: (fn) => { activationHandler = fn; } },
    },
    windows: {
      update: async (id, properties) => {
        windowUpdates.push({ id, ...properties });
        return { id, ...properties };
      },
    },
  };

  const eventually = async (predicate) => {
    for (let attempt = 0; attempt < 100 && !predicate(); attempt += 1) await delay(20);
    assert.ok(predicate());
  };
  const send = globalThis.chrome.runtime.sendMessage;
  await import(new URL(manifest.background.service_worker, dist));
  assert.equal((await send({ type: 'start', text: 'Finish my submission' })).ok, true);
  activate(2);
  await eventually(() => stored.focusAnchor.mission.tabSwitches === 1);

  const firstNote = 'Read the examples after submitting';
  assert.equal((await send({
    type: 'save', tabId: 2, url: keptTab.url, note: firstNote, close: false,
  })).ok, true);
  assert.equal(tabs.has(2), true);
  assert.equal(stored.focusAnchor.parked.length, 1);
  assert.deepEqual(stored.focusAnchor.parked[0], {
    id: stored.focusAnchor.parked[0].id,
    title: keptTab.title,
    url: keptTab.url,
    note: firstNote,
    mission: 'Finish my submission',
    status: 'kept-open',
  });

  const originalId = stored.focusAnchor.parked[0].id;
  const updatedNote = 'Use the second example in the write-up';
  assert.equal((await send({
    type: 'save', tabId: 2, url: keptTab.url, note: updatedNote, close: false,
  })).ok, true);
  assert.equal(stored.focusAnchor.parked.length, 1);
  assert.equal(stored.focusAnchor.parked[0].id, originalId);
  assert.equal(stored.focusAnchor.parked[0].note, updatedNote);
  assert.equal(stored.focusAnchor.parked[0].mission, 'Finish my submission');

  activate(4);
  const closeCommand = {
    type: 'save', tabId: 4, url: closedTab.url, note: 'Cite this after the draft', close: true,
  };
  const wrongUrl = await send({ ...closeCommand, url: 'https://example.com/different' });
  assert.equal(wrongUrl.ok, false);
  assert.equal(tabs.has(4), true);

  rejectWrite = true;
  assert.equal((await send(closeCommand)).ok, false);
  assert.equal(tabs.has(4), true);
  rejectWrite = false;

  assert.equal((await send(closeCommand)).ok, true);
  assert.equal(saveObservedBeforeClose, true);
  assert.equal(tabs.has(4), false);
  assert.equal(stored.focusAnchor.parked.length, 2);
  assert.deepEqual(stored.focusAnchor.parked.map(({ status }) => status).sort(), ['closed', 'kept-open']);

  const keptId = stored.focusAnchor.parked.find((item) => item.url === keptTab.url).id;
  const closedId = stored.focusAnchor.parked.find((item) => item.url === closedTab.url).id;
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    url: 'https://focusanchor.test/?dashboard',
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    location: dom.window.location,
    MutationObserver: dom.window.MutationObserver,
  });
  try {
    await import(new URL(`${popupBundle.script}?dashboard-test`, dist));
    await eventually(() => document.body.textContent.includes(updatedNote));
    assert.match(document.body.textContent, /Cite this after the draft/);
    assert.match(document.body.textContent, /Kept open/);
    assert.match(document.body.textContent, /Saved & closed/);
    assert.equal((document.body.textContent.match(/Original mission: Finish my submission/g) ?? []).length, 2);

    document.querySelector(`[aria-label="Open ${keptTab.title}"]`).click();
    await eventually(() => tabUpdates.some(({ id }) => id === 2));
    assert.equal(createdTabs, 0);
    assert.deepEqual(windowUpdates.at(-1), { id: 10, focused: true });

    const closedButton = document.querySelector(`[aria-label="Open ${closedTab.title}"]`);
    await eventually(() => !closedButton.disabled);
    closedButton.click();
    await eventually(() => createdTabs === 1);
    const reopened = [...tabs.values()].find((tab) => tab.url === closedTab.url);
    assert.ok(reopened);

    await eventually(() => !closedButton.disabled);
    closedButton.click();
    await eventually(() => tabUpdates.some(({ id }) => id === reopened.id));
    assert.equal(createdTabs, 1);
    await eventually(() => stored.focusAnchor.mission.tabSwitches === 5);

    document.querySelector('.finish').click();
    await eventually(() => stored.focusAnchor.completedSessions === 1);
    assert.equal(stored.focusAnchor.mission, null);
    assert.equal((await send({ type: 'remove', id: keptId })).ok, true);
    assert.equal((await send({ type: 'remove', id: closedId })).ok, true);
    await eventually(() => document.body.textContent.includes('Your saved tabs and notes'));
  } finally {
    dom.window.close();
    delete globalThis.chrome;
  }
});
