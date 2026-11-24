import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { JSDOM } from 'jsdom';

const eventually = async (predicate) => {
  for (let attempt = 0; attempt < 100 && !predicate(); attempt += 1) await delay(20);
  assert.ok(predicate());
};

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
  assert.ok(manifest.permissions.includes('notifications'));
  assert.ok(manifest.permissions.includes('favicon'));
  assert.match(popupBundle.source, /Save note & keep open/);
  assert.match(popupBundle.source, /Save note & close tab/);
  for (const size of [16, 32, 48, 128]) {
    const relative = `icons/icon${size}.png`;
    assert.equal(manifest.icons[String(size)], relative);
    assert.equal(manifest.action.default_icon[String(size)], relative);
    const bytes = await readFile(new URL(relative, dist));
    assert.equal(bytes[0], 0x89);
    assert.equal(bytes.toString('ascii', 1, 4), 'PNG');
    assert.equal(bytes.readUInt32BE(16), size);
    assert.equal(bytes.readUInt32BE(20), size);
  }

  const [missionTab, keptTab, closedTab] = [
    { id: 1, windowId: 10, url: 'https://example.com/work', title: 'Work', active: true },
    { id: 2, windowId: 10, url: 'https://example.com/article', title: 'Fourier transform', active: false },
    { id: 4, windowId: 20, url: 'https://example.com/reference', title: 'Reference guide', active: false },
  ];
  const tabs = new Map([[1, missionTab], [2, keptTab], [4, closedTab]]);
  const changes = new Set();
  const removedHandlers = new Set();
  const updatedHandlers = new Set();
  const tabUpdates = [];
  const windowUpdates = [];
  const notifications = [];
  let stored = {};
  let session = {};
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
      session: {
        get: async (key) => (typeof key === 'string' ? { [key]: session[key] } : structuredClone(session)),
        set: async (data) => { session = { ...session, ...structuredClone(data) }; },
      },
    },
    notifications: {
      create: async (id, options) => {
        notifications.push({ id, ...options });
        return id;
      },
    },
    tabs: {
      query: async (query) => [...tabs.values()]
        .filter((tab) => !query.active || tab.active)
        .map((tab) => ({ ...tab })),
      get: async (id) => {
        if (!tabs.has(id)) throw new Error(`No tab with id: ${id}`);
        return { ...tabs.get(id) };
      },
      update: async (id, properties) => {
        const tab = tabs.get(id);
        if (!tab) throw new Error(`No tab with id: ${id}`);
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
      onRemoved: {
        addListener: (fn) => { removedHandlers.add(fn); },
        removeListener: (fn) => { removedHandlers.delete(fn); },
      },
      onUpdated: {
        addListener: (fn) => { updatedHandlers.add(fn); },
        removeListener: (fn) => { updatedHandlers.delete(fn); },
      },
    },
    windows: {
      update: async (id, properties) => {
        windowUpdates.push({ id, ...properties });
        return { id, ...properties };
      },
    },
  };

  const send = globalThis.chrome.runtime.sendMessage;
  await import(new URL(manifest.background.service_worker, dist));

  const missing = await send({
    type: 'save', tabId: 999, url: 'https://example.com/missing', note: 'Remember why this was open', close: true,
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.error, 'This tab is no longer open. Open FocusAnchor again to save the current page.');
  assert.equal(stored.focusAnchor, undefined);

  const getTab = globalThis.chrome.tabs.get;
  globalThis.chrome.tabs.get = async () => { throw new Error('Tabs are unavailable'); };
  const transient = await send({
    type: 'save', tabId: 2, url: keptTab.url, note: 'Keep this draft', close: false,
  });
  globalThis.chrome.tabs.get = getTab;
  assert.equal(transient.ok, false);
  assert.equal(transient.error, 'Tabs are unavailable');
  assert.equal(stored.focusAnchor, undefined);

  assert.equal((await send({ type: 'start', text: 'Finish my submission' })).ok, true);
  activate(2);
  const activeStored = () => stored.focusAnchor.missions.find((mission) => mission.id === stored.focusAnchor.activeMissionId);
  await eventually(() => activeStored().tabSwitches === 1);

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
    missionId: activeStored().id,
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
  activeStored().startedAt = Date.now() - 12_500;
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    url: 'https://focusanchor.test/?dashboard',
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    location: dom.window.location,
    MutationObserver: dom.window.MutationObserver,
  });
  const openButton = (title) => document.querySelector(`[aria-label="Open ${title}"]`);
  try {
    await import(new URL(`${popupBundle.script}?dashboard-test`, dist));
    await eventually(() => document.body.textContent.includes(updatedNote));
    assert.match(document.body.textContent, /Cite this after the draft/);
    assert.match(document.body.textContent, /Kept open/);
    assert.match(document.body.textContent, /Saved & closed/);
    assert.equal((document.body.textContent.match(/Original mission: Finish my submission/g) ?? []).length, 2);
    assert.match(document.body.textContent, /example\.com/);
    const timer = document.querySelector('time');
    assert.match(timer.textContent.trim(), /^\d+:\d{2}$/);
    assert.match(timer.getAttribute('aria-label'), /\d+ seconds elapsed/);
    assert.doesNotMatch(document.body.textContent, /min elapsed/);
    const beforeTick = timer.textContent.trim();
    await eventually(() => document.querySelector('time').textContent.trim() !== beforeTick);
    assert.match(document.querySelector('time').textContent.trim(), /^\d+:\d{2}$/);
    activeStored().startedAt = Date.now() - 3_723_000;
    for (const fn of changes) fn({ focusAnchor: { newValue: structuredClone(stored.focusAnchor) } }, 'local');
    await eventually(() => /^1:02:\d{2}$/.test(document.querySelector('time')?.textContent.trim() ?? ''));
    assert.match(document.querySelector('time').getAttribute('aria-label'), /1 hour 2 minutes \d+ seconds elapsed/);

    notifications.length = 0;
    openButton(keptTab.title).click();
    await eventually(() => notifications.length === 1 && tabUpdates.some(({ id }) => id === 2));
    assert.equal(notifications[0].title, keptTab.title);
    assert.equal(notifications[0].message, updatedNote);
    assert.equal(createdTabs, 0);
    assert.deepEqual(windowUpdates.at(-1), { id: 10, focused: true });

    await eventually(() => {
      const button = openButton(closedTab.title);
      return button && !button.disabled;
    });
    notifications.length = 0;
    openButton(closedTab.title).click();
    await eventually(() => createdTabs === 1 && notifications.length === 1);
    assert.equal(notifications[0].title, closedTab.title);
    assert.equal(notifications[0].message, 'Cite this after the draft');
    assert.equal(notifications[0].contextMessage, 'Mission: Finish my submission');
    assert.ok(notifications[0].iconUrl.endsWith('icons/icon128.png'));
    const reopened = [...tabs.values()].find((tab) => tab.url === closedTab.url);
    assert.ok(reopened);
    await eventually(() => stored.focusAnchor.parked.find((item) => item.id === closedId).status === 'kept-open');

    await eventually(() => {
      const button = openButton(closedTab.title);
      return button && !button.disabled;
    });
    notifications.length = 0;
    openButton(closedTab.title).click();
    await eventually(() => notifications.length === 1 && tabUpdates.some(({ id }) => id === reopened.id));
    assert.equal(createdTabs, 1);
    await eventually(() => activeStored().tabSwitches === 5);

    tabs.delete(reopened.id);
    for (const handler of removedHandlers) handler(reopened.id, { windowId: reopened.windowId, isWindowClosing: false });
    await eventually(() => stored.focusAnchor.parked.find((entry) => entry.id === closedId).status === 'closed');
    await eventually(() => document.body.textContent.includes('Saved & closed'));

    tabs.set(40, {
      id: 40, windowId: 10, url: closedTab.url, title: 'Leaving', active: false, pendingUrl: 'https://example.com/next',
    });
    const createdBefore = createdTabs;
    notifications.length = 0;
    await eventually(() => {
      const button = openButton(closedTab.title);
      return button && !button.disabled;
    });
    openButton(closedTab.title).click();
    await eventually(() => createdTabs === createdBefore + 1 && notifications.length === 1);
    assert.equal([...tabs.values()].filter((tab) => tab.url === closedTab.url && !tab.pendingUrl).length, 1);

    keptTab.url = 'https://example.com/elsewhere';
    for (const handler of updatedHandlers) handler(keptTab.id, { url: keptTab.url }, { ...keptTab });
    await eventually(() => stored.focusAnchor.parked.find((item) => item.id === keptId).status === 'closed');

    for (const tab of tabs.values()) tab.active = false;
    tabs.set(30, { id: 30, windowId: 10, url: 'https://example.com/twice', title: 'Twice', active: true });
    tabs.set(31, { id: 31, windowId: 10, url: 'https://example.com/twice', title: 'Twice copy', active: false });
    assert.equal((await send({
      type: 'save', tabId: 30, url: 'https://example.com/twice', note: 'Two copies', close: true,
    })).ok, true);
    assert.equal(tabs.has(30), false);
    assert.equal(tabs.has(31), true);
    const duplicate = stored.focusAnchor.parked.find((item) => item.url === 'https://example.com/twice');
    assert.equal(duplicate.status, 'kept-open');

    document.querySelector('.finish').click();
    await eventually(() => stored.focusAnchor.completedSessions === 1);
    assert.equal(stored.focusAnchor.activeMissionId, null);
    assert.equal(stored.focusAnchor.missions.length, 0);
    assert.equal((await send({ type: 'remove', id: keptId })).ok, true);
    assert.equal((await send({ type: 'remove', id: closedId })).ok, true);
    assert.equal((await send({ type: 'remove', id: duplicate.id })).ok, true);
    await eventually(() => document.body.textContent.includes('Your saved tabs and notes'));
    assert.match(document.body.textContent, /Start a mission you want to finish/);
    assert.match(document.body.textContent, /Save a note on a distracting tab/);
    assert.match(document.body.textContent, /Reopen the tab from here when you need the thought back/);
  } finally {
    dom.window.close();
    delete globalThis.chrome;
  }
});

await test('a closed tab does not leave the popup holding a stale id', async () => {
  const dist = new URL('../dist/', import.meta.url);
  const manifest = JSON.parse(await readFile(new URL('manifest.json', dist)));
  const popupScript = await readFile(new URL(manifest.action.default_popup, dist), 'utf8')
    .then((html) => html.match(/src="([^"]+\.js)"/)?.[1]);
  assert.ok(popupScript);

  const work = { id: 1, windowId: 10, url: 'https://example.com/work', title: 'Work', active: false };
  const article = { id: 2, windowId: 10, url: 'https://example.com/article', title: 'Fourier transform', active: true };
  const tabs = new Map([[1, work], [2, article]]);
  const changes = new Set();
  const removedHandlers = new Set();
  let stored = {};
  let session = {};
  let messageHandler;
  const sender = { id: 'focusanchor-stale' };
  globalThis.chrome = {
    runtime: {
      id: sender.id,
      getURL: (path) => `chrome-extension://${sender.id}/${String(path).replace(/^\//, '')}`,
      onMessage: { addListener: (fn) => { messageHandler = fn; } },
      sendMessage: (request) => new Promise((resolve) => messageHandler(request, sender, resolve)),
    },
    storage: {
      onChanged: { addListener: (fn) => changes.add(fn), removeListener: (fn) => changes.delete(fn) },
      local: {
        get: async () => structuredClone(stored),
        set: async (data) => {
          stored = structuredClone(data);
          for (const fn of changes) fn({ focusAnchor: { newValue: stored.focusAnchor } }, 'local');
        },
      },
      session: {
        get: async (key) => (typeof key === 'string' ? { [key]: session[key] } : structuredClone(session)),
        set: async (data) => { session = { ...session, ...structuredClone(data) }; },
      },
    },
    notifications: { create: async () => 'note' },
    tabs: {
      query: async (query) => [...tabs.values()]
        .filter((tab) => !query.active || tab.active)
        .map((tab) => ({ ...tab })),
      get: async (id) => {
        if (!tabs.has(id)) throw new Error(`No tab with id: ${id}`);
        return { ...tabs.get(id) };
      },
      remove: async (id) => {
        tabs.delete(id);
        const next = [...tabs.values()][0];
        for (const tab of tabs.values()) tab.active = next ? tab.id === next.id : false;
        for (const handler of removedHandlers) handler(id, { windowId: 10, isWindowClosing: false });
      },
      onActivated: { addListener: () => {} },
      onUpdated: { addListener: () => {}, removeListener: () => {} },
      onRemoved: {
        addListener: (fn) => { removedHandlers.add(fn); },
        removeListener: (fn) => { removedHandlers.delete(fn); },
      },
    },
  };

  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    url: 'https://focusanchor.test/popup.html',
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    location: dom.window.location,
    MutationObserver: dom.window.MutationObserver,
  });
  const fillNote = (value) => {
    const note = document.querySelector('#note');
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(note, value);
    note.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    return note;
  };

  try {
    await import(new URL(`${manifest.background.service_worker}?stale=1`, dist));
    await import(new URL(`${popupScript}?stale=1`, dist));
    await eventually(() => document.body.textContent.includes('Fourier transform'));
    tabs.delete(2);
    work.active = true;
    fillNote('Remember why this was open');
    const closeButton = () => document.querySelector('button[value="close"]');
    await eventually(() => closeButton() && !closeButton().disabled);
    closeButton().form.requestSubmit(closeButton());
    await eventually(() => document.body.textContent.includes('no longer open'));
    assert.doesNotMatch(document.body.textContent, /No tab with id/);
    assert.equal(stored.focusAnchor, undefined);
    await eventually(() => document.querySelector('.tab-title')?.textContent === 'Work');

    fillNote('Keep the work tab in mind');
    await eventually(() => closeButton() && !closeButton().disabled);
    closeButton().form.requestSubmit(closeButton());
    await eventually(() => document.body.textContent.includes('Note saved and tab closed.'));
    assert.equal(tabs.has(1), false);
    assert.equal(document.querySelector('.parking form'), null);
    assert.match(document.body.textContent, /Open FocusAnchor from a website/);
    assert.doesNotMatch(document.body.textContent, /No tab with id/);
    assert.equal(stored.focusAnchor.parked[0].url, work.url);
    assert.equal(stored.focusAnchor.parked[0].status, 'closed');
    assert.equal(stored.focusAnchor.parked[0].note, 'Keep the work tab in mind');
  } finally {
    dom.window.close();
    delete globalThis.chrome;
  }
});

await test('a saved single mission migrates and more than one mission can stay active', async () => {
  const dist = new URL('../dist/', import.meta.url);
  const manifest = JSON.parse(await readFile(new URL('manifest.json', dist)));
  const startedAt = 1_700_000_000_000;
  const notes = { id: 7, windowId: 1, url: 'https://example.com/notes', title: 'Notes', active: true };
  const tabs = new Map([[7, notes]]);
  let stored = {
    focusAnchor: {
      mission: { text: 'Write the outline', startedAt, tabSwitches: 4, lastTabId: 7 },
      parked: [{
        id: 'parked-notes',
        title: 'Notes',
        url: notes.url,
        note: 'Outline source',
        mission: 'Write the outline',
        status: 'kept-open',
      }],
      completedSessions: 1,
    },
  };
  let session = {};
  let messageHandler;
  const sender = { id: 'focusanchor-missions' };
  globalThis.chrome = {
    runtime: {
      id: sender.id,
      getURL: (path) => `chrome-extension://${sender.id}/${path}`,
      onMessage: { addListener: (fn) => { messageHandler = fn; } },
      sendMessage: (request) => new Promise((resolve) => messageHandler(request, sender, resolve)),
    },
    storage: {
      onChanged: { addListener() {}, removeListener() {} },
      local: {
        get: async () => structuredClone(stored),
        set: async (data) => { stored = structuredClone(data); },
      },
      session: {
        get: async (key) => (typeof key === 'string' ? { [key]: session[key] } : structuredClone(session)),
        set: async (data) => { session = { ...session, ...structuredClone(data) }; },
      },
    },
    notifications: { create: async () => 'note' },
    tabs: {
      query: async () => [...tabs.values()].map((tab) => ({ ...tab })),
      get: async (id) => {
        if (!tabs.has(id)) throw new Error(`No tab with id: ${id}`);
        return { ...tabs.get(id) };
      },
      update: async (id, properties) => ({ ...tabs.get(id), ...properties }),
      remove: async (id) => { tabs.delete(id); },
      create: async ({ url }) => {
        const tab = { id: 8, windowId: 1, url, title: url, active: true };
        tabs.set(tab.id, tab);
        return { ...tab };
      },
      onActivated: { addListener() {} },
      onRemoved: { addListener() {}, removeListener() {} },
      onUpdated: { addListener() {}, removeListener() {} },
    },
    windows: { update: async (id, properties) => ({ id, ...properties }) },
  };

  try {
    await import(new URL(`${manifest.background.service_worker}?missions=1`, dist));
    const send = globalThis.chrome.runtime.sendMessage;
    await eventually(() => stored.focusAnchor.missions?.length === 1);
    const legacy = stored.focusAnchor.missions[0];
    assert.equal(legacy.id, `legacy-${startedAt}`);
    assert.equal(legacy.text, 'Write the outline');
    assert.equal(legacy.tabSwitches, 4);
    assert.equal(stored.focusAnchor.activeMissionId, legacy.id);
    assert.equal(stored.focusAnchor.parked[0].missionId, legacy.id);
    assert.equal(stored.focusAnchor.parked[0].mission, 'Write the outline');
    assert.equal(stored.focusAnchor.completedSessions, 1);

    assert.equal((await send({ type: 'start', text: 'Record the demo' })).ok, true);
    assert.equal(stored.focusAnchor.missions.length, 2);
    const demo = stored.focusAnchor.missions.find((mission) => mission.text === 'Record the demo');
    assert.equal(stored.focusAnchor.activeMissionId, demo.id);
    assert.equal((await send({
      type: 'save', tabId: 7, url: notes.url, note: 'Demo shot list', close: false, missionId: demo.id,
    })).ok, true);
    assert.equal(stored.focusAnchor.parked[0].mission, 'Record the demo');
    assert.equal(stored.focusAnchor.parked[0].missionId, demo.id);

    assert.equal((await send({ type: 'activate', id: legacy.id })).ok, true);
    assert.equal(stored.focusAnchor.activeMissionId, legacy.id);
    assert.equal((await send({ type: 'finish', id: legacy.id })).ok, true);
    assert.equal(stored.focusAnchor.missions.length, 1);
    assert.equal(stored.focusAnchor.missions[0].id, demo.id);
    assert.equal(stored.focusAnchor.activeMissionId, demo.id);
    assert.equal(stored.focusAnchor.completedSessions, 2);
    assert.equal(stored.focusAnchor.parked[0].mission, 'Record the demo');
  } finally {
    delete globalThis.chrome;
  }
});

function installMissionChrome(seed) {
  const tabs = new Map([[1, { id: 1, windowId: 1, url: 'https://example.com/work', title: 'Work', active: true }]]);
  const changes = new Set();
  let stored = { focusAnchor: seed };
  let session = {};
  let messageHandler;
  const sender = { id: `focusanchor-${seed.activeMissionId ?? 'review'}` };
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
          stored = structuredClone(data);
          for (const fn of changes) fn({ focusAnchor: { newValue: stored.focusAnchor } }, 'local');
        },
      },
      session: {
        get: async (key) => (typeof key === 'string' ? { [key]: session[key] } : structuredClone(session)),
        set: async (data) => { session = { ...session, ...structuredClone(data) }; },
      },
    },
    notifications: { create: async () => 'note' },
    tabs: {
      query: async () => [...tabs.values()].map((tab) => ({ ...tab })),
      get: async (id) => {
        if (!tabs.has(id)) throw new Error(`No tab with id: ${id}`);
        return { ...tabs.get(id) };
      },
      update: async (id, properties) => ({ ...tabs.get(id), ...properties }),
      remove: async (id) => { tabs.delete(id); },
      create: async ({ url }) => {
        const tab = { id: 9, windowId: 1, url, title: url, active: true };
        tabs.set(tab.id, tab);
        return { ...tab };
      },
      onActivated: { addListener() {} },
      onRemoved: { addListener() {}, removeListener() {} },
      onUpdated: { addListener() {}, removeListener() {} },
    },
    windows: { update: async (id, properties) => ({ id, ...properties }) },
  };
  return {
    tabs,
    send: (...args) => globalThis.chrome.runtime.sendMessage(...args),
    read: () => stored.focusAnchor,
    cleanup: () => { delete globalThis.chrome; },
  };
}

await test('an explicit mission id is not reassigned when another mission has the same name', async () => {
  const dist = new URL('../dist/', import.meta.url);
  const manifest = JSON.parse(await readFile(new URL('manifest.json', dist)));
  const harness = installMissionChrome({
    missions: [{ id: 'live', text: 'Same', startedAt: 10, activatedAt: 20, tabSwitches: 0, lastTabId: 1 }],
    activeMissionId: 'live',
    parked: [{
      id: 'old-tab',
      title: 'Old notes',
      url: 'https://example.com/old',
      note: 'From the finished mission',
      missionId: 'finished',
      mission: 'Same',
      status: 'closed',
    }],
    completedSessions: 0,
  });
  try {
    await import(new URL(`${manifest.background.service_worker}?explicit-mission=1`, dist));
    assert.equal((await harness.send({ type: 'activate', id: 'live' })).ok, true);
    assert.equal(harness.read().parked[0].missionId, 'finished');
    assert.equal(harness.read().parked[0].mission, 'Same');
  } finally {
    harness.cleanup();
  }
});

await test('a save aimed at a finished mission uses the active mission', async () => {
  const dist = new URL('../dist/', import.meta.url);
  const manifest = JSON.parse(await readFile(new URL('manifest.json', dist)));
  const harness = installMissionChrome({
    missions: [
      { id: 'gone', text: 'Finished', startedAt: 10, activatedAt: 10, tabSwitches: 0, lastTabId: 1 },
      { id: 'live', text: 'Current', startedAt: 20, activatedAt: 30, tabSwitches: 0, lastTabId: 1 },
    ],
    activeMissionId: 'live',
    parked: [],
    completedSessions: 0,
  });
  try {
    await import(new URL(`${manifest.background.service_worker}?fallback-mission=1`, dist));
    assert.equal((await harness.send({ type: 'finish', id: 'gone' })).ok, true);
    assert.equal((await harness.send({
      type: 'save', tabId: 1, url: 'https://example.com/work', note: 'Still current', close: false, missionId: 'gone',
    })).ok, true);
    assert.equal(harness.read().parked[0].missionId, 'live');
    assert.equal(harness.read().parked[0].mission, 'Current');
  } finally {
    harness.cleanup();
  }
});

await test('retrying a start reuses the mission instead of creating another', async () => {
  const dist = new URL('../dist/', import.meta.url);
  const manifest = JSON.parse(await readFile(new URL('manifest.json', dist)));
  const harness = installMissionChrome({ missions: [], activeMissionId: null, parked: [], completedSessions: 0 });
  try {
    await import(new URL(`${manifest.background.service_worker}?idempotent-start=1`, dist));
    const first = await harness.send({ type: 'start', text: 'One mission', id: 'start-1' });
    const second = await harness.send({ type: 'start', text: 'One mission', id: 'start-1' });
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(harness.read().missions.length, 1);
    assert.equal(harness.read().missions[0].id, 'start-1');
    assert.equal(harness.read().missions[0].text, 'One mission');
    assert.equal(harness.read().activeMissionId, 'start-1');
  } finally {
    harness.cleanup();
  }
});

async function renderPopup(search, seed) {
  const dist = new URL('../dist/', import.meta.url);
  const manifest = JSON.parse(await readFile(new URL('manifest.json', dist)));
  const popupScript = await readFile(new URL(manifest.action.default_popup, dist), 'utf8')
    .then((html) => html.match(/src="([^"]+\.js)"/)?.[1]);
  assert.ok(popupScript);
  const harness = installMissionChrome(seed);
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    url: `https://focusanchor.test/popup.html${search}`,
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    location: dom.window.location,
    MutationObserver: dom.window.MutationObserver,
  });
  await import(new URL(`${popupScript}${search}`, dist));
  return { harness, dom };
}

await test('the save mission picker follows the active mission and drops a removed one', async () => {
  const mission = (id, text, activatedAt) => ({
    id, text, startedAt: activatedAt, activatedAt, tabSwitches: 0, lastTabId: 1,
  });
  const { harness, dom } = await renderPopup('?picker=1', {
    missions: [mission('m1', 'First', 10), mission('m2', 'Second', 20)],
    activeMissionId: 'm1',
    parked: [],
    completedSessions: 0,
  });
  try {
    const selected = () => document.querySelector('#save-mission')?.value;
    await eventually(() => selected() === 'm1');
    const next = structuredClone(harness.read());
    next.activeMissionId = 'm2';
    await globalThis.chrome.storage.local.set({ focusAnchor: next });
    await eventually(() => selected() === 'm2');
    const remaining = structuredClone(harness.read());
    remaining.missions = remaining.missions.filter((item) => item.id === 'm1');
    remaining.activeMissionId = 'm1';
    await globalThis.chrome.storage.local.set({ focusAnchor: remaining });
    await eventually(() => selected() === 'm1');
  } finally {
    dom.window.close();
    harness.cleanup();
  }
});

await test('a tab with no mission id stays out of the list when its name matches more than one mission', async () => {
  const mission = (id) => ({ id, text: 'Same', startedAt: 10, activatedAt: 10, tabSwitches: 0, lastTabId: 1 });
  const { harness, dom } = await renderPopup('?ambiguous=1', {
    missions: [mission('a'), mission('b')],
    activeMissionId: 'a',
    parked: [{
      id: 'loose',
      title: 'Ambiguous notes',
      url: 'https://example.com/loose',
      note: 'Unowned',
      mission: 'Same',
      status: 'closed',
    }, {
      id: 'owned',
      title: 'Owned notes',
      url: 'https://example.com/owned',
      note: 'Owned',
      missionId: 'a',
      mission: 'Same',
      status: 'kept-open',
    }],
    completedSessions: 0,
  });
  try {
    await eventually(() => document.body.textContent.includes('Owned notes'));
    assert.equal(document.body.textContent.includes('Ambiguous notes'), false);
  } finally {
    dom.window.close();
    harness.cleanup();
  }
});

await test('finished missions with the same name stay in separate groups', async () => {
  const parked = (id) => ({
    id,
    title: id,
    url: `https://example.com/${id}`,
    note: `Note ${id}`,
    missionId: id,
    mission: 'Notes',
    status: 'closed',
  });
  const { harness, dom } = await renderPopup('?groups=1&dashboard', {
    missions: [],
    activeMissionId: null,
    parked: [parked('finished-a'), parked('finished-b')],
    completedSessions: 2,
  });
  try {
    await eventually(() => document.querySelectorAll('.mission-group').length === 2);
    const titles = [...document.querySelectorAll('.mission-group > h3')].map((heading) => heading.textContent);
    assert.deepEqual(titles, ['Notes', 'Notes']);
    assert.match(document.body.textContent, /Note finished-a/);
    assert.match(document.body.textContent, /Note finished-b/);
  } finally {
    dom.window.close();
    harness.cleanup();
  }
});

await test('a save keeps the page summary and the route that drafted it', async () => {
  const dist = new URL('../dist/', import.meta.url);
  const manifest = JSON.parse(await readFile(new URL('manifest.json', dist)));
  assert.ok(manifest.permissions.includes('scripting'));
  const harness = installMissionChrome({
    missions: [{ id: 'live', text: 'Current', startedAt: 20, activatedAt: 30, tabSwitches: 0, lastTabId: 1 }],
    activeMissionId: 'live',
    parked: [],
    completedSessions: 0,
  });
  try {
    await import(new URL(`${manifest.background.service_worker}?summary=1`, dist));
    assert.equal((await harness.send({
      type: 'save',
      tabId: 1,
      url: 'https://example.com/work',
      note: 'Compare the two APIs',
      close: false,
      summary: '  Docs for the Prompt API  ',
      draftRoute: 'on-device',
    })).ok, true);
    assert.equal(harness.read().parked[0].summary, 'Docs for the Prompt API');
    assert.equal(harness.read().parked[0].draftRoute, 'on-device');
    assert.equal((await harness.send({
      type: 'save',
      tabId: 1,
      url: 'https://example.com/work',
      note: 'Compare the two APIs again',
      close: false,
      draftRoute: 'somewhere',
    })).ok, true);
    assert.equal(harness.read().parked[0].summary, 'Docs for the Prompt API');
    assert.equal(harness.read().parked[0].draftRoute, 'on-device');
    assert.equal(harness.read().parked[0].note, 'Compare the two APIs again');
  } finally {
    harness.cleanup();
  }
});

await test('the refocus banner is bundled for saved tabs', async () => {
  const dist = new URL('../dist/', import.meta.url);
  const manifest = JSON.parse(await readFile(new URL('manifest.json', dist)));
  assert.ok(manifest.permissions.includes('offscreen'));
  assert.ok(manifest.host_permissions.includes('https://*/*'));
  assert.ok(manifest.host_permissions.includes('http://*/*'));
  const banner = await readFile(new URL('refocus.js', dist), 'utf8');
  assert.match(banner, /Back to this/);
  assert.match(banner, /On-device \(Gemini Nano\)/);
  assert.match(banner, /Dismiss/);
  const worker = await readFile(new URL(manifest.background.service_worker, dist), 'utf8');
  assert.match(worker, /refocus-request/);
  const offscreen = await readFile(new URL('offscreen.html', dist), 'utf8');
  assert.match(offscreen, /offscreen/);
});

await test('suggest explains that firebase config is required', async () => {
  const { harness, dom } = await renderPopup('?suggest=1', {
    missions: [],
    activeMissionId: null,
    parked: [],
    completedSessions: 0,
  });
  try {
    const button = () => document.querySelector('.suggest');
    await eventually(() => button() && document.body.textContent.includes('Work'));
    assert.match(document.body.textContent, /On-device keeps page text on this computer/);
    button().click();
    await eventually(() => document.body.textContent.includes('firebase-config.js'));
    assert.match(document.body.textContent, /Cloud fallback sends a short excerpt/);
    const popupSource = await readFile(new URL('../dist/popup.js', import.meta.url), 'utf8');
    assert.match(popupSource, /Use mission/);
    assert.match(popupSource, /Fits "/);
  } finally {
    dom.window.close();
    harness.cleanup();
  }
});
