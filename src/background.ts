import { activeMission, isWebUrl, MISSION_LIMIT, normalizeState, NOTE_LIMIT, STATE_KEY } from './state';
import type { Command, Mission, Reply, SavedTab, State } from './state';

const CLOSED_TAB_ERROR = 'This tab is no longer open. Open FocusAnchor again to save the current page.';
const TAB_KEY = 'focusAnchorTabs';

let pending: Promise<unknown> = Promise.resolve();

function enqueue<T>(work: () => Promise<T>): Promise<T> {
  const result = pending.then(work);
  pending = result.catch(() => {});
  return result;
}

async function load(): Promise<State> {
  const stored = await chrome.storage.local.get(STATE_KEY);
  return normalizeState(stored[STATE_KEY]);
}

function save(state: State) {
  return chrome.storage.local.set({ [STATE_KEY]: state });
}

function missingTab(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /No tab with id/i.test(message);
}

async function readTab(tabId: number) {
  try {
    return await chrome.tabs.get(tabId);
  } catch (error) {
    if (missingTab(error)) throw new Error(CLOSED_TAB_ERROR);
    throw error instanceof Error ? error : new Error('Could not read this tab.');
  }
}

type TabMap = Record<string, number>;

async function loadTabMap(): Promise<TabMap> {
  if (!chrome.storage?.session) return {};
  const stored = await chrome.storage.session.get(TAB_KEY);
  const value = stored[TAB_KEY];
  if (!value || typeof value !== 'object') return {};
  const map: TabMap = {};
  for (const [id, tabId] of Object.entries(value as Record<string, unknown>)) {
    if (typeof tabId === 'number' && Number.isInteger(tabId) && tabId >= 0) map[id] = tabId;
  }
  return map;
}

function saveTabMap(map: TabMap) {
  if (!chrome.storage?.session) return Promise.resolve();
  return chrome.storage.session.set({ [TAB_KEY]: map });
}

function showsSavedPage(tab: chrome.tabs.Tab, url: string): boolean {
  return tab.id !== undefined && tab.url === url && (!tab.pendingUrl || tab.pendingUrl === url);
}

function findOpenTab(tabs: chrome.tabs.Tab[], url: string, exceptId?: number) {
  return tabs.find((tab) => tab.id !== exceptId && showsSavedPage(tab, url));
}

function needsMigration(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const stored = value as { mission?: unknown; missions?: unknown };
  return stored.mission != null && !Array.isArray(stored.missions);
}

async function reconcile() {
  const raw = await chrome.storage.local.get(STATE_KEY);
  const [state, openTabs] = [normalizeState(raw[STATE_KEY]), await chrome.tabs.query({})];
  const nextMap: TabMap = {};
  let changed = needsMigration(raw[STATE_KEY]);
  const parked = state.parked.map((item) => {
    const match = findOpenTab(openTabs, item.url);
    if (match?.id !== undefined) {
      nextMap[item.id] = match.id;
      if (item.status === 'kept-open') return item;
      changed = true;
      return { ...item, status: 'kept-open' as const };
    }
    if (item.status !== 'kept-open') return item;
    changed = true;
    return { ...item, status: 'closed' as const };
  });
  await saveTabMap(nextMap);
  if (changed) await save({ ...state, parked });
}

async function showSavedNote(item: SavedTab) {
  if (!chrome.notifications?.create) return;
  try {
    await chrome.notifications.create(`focusanchor-note-${item.id}`, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: item.title,
      message: item.note.trim() || 'Saved tab',
      contextMessage: item.mission ? `Mission: ${item.mission}` : undefined,
      requireInteraction: true,
    });
  } catch (error) {
    console.error('Could not show the saved note.', error);
  }
}

function chosenMission(state: State, existing: SavedTab | undefined, requested: string | null | undefined) {
  if (requested === null) return { missionId: null, mission: null };
  if (requested === undefined && existing) return { missionId: existing.missionId, mission: existing.mission };
  const mission = state.missions.find((item) => item.id === (requested ?? state.activeMissionId));
  return mission ? { missionId: mission.id, mission: mission.text } : { missionId: null, mission: null };
}

function mostRecent(missions: Mission[]): string | null {
  return [...missions].sort((a, b) => b.activatedAt - a.activatedAt)[0]?.id ?? null;
}

function markOpen(state: State, id: string): State {
  return {
    ...state,
    parked: state.parked.map((item) => (
      item.id === id ? { ...item, status: 'kept-open' } : item
    )),
  };
}

async function apply(command: Command): Promise<Reply> {
  const state = await load();

  switch (command.type) {
    case 'start': {
      const value = command.text.trim();
      if (!value || value.length > MISSION_LIMIT) throw new Error('Enter a mission of up to 100 characters.');
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      const now = Date.now();
      const mission: Mission = {
        id: crypto.randomUUID(),
        text: value,
        startedAt: now,
        activatedAt: now,
        tabSwitches: 0,
        lastTabId: tab?.id ?? null,
      };
      await save({ ...state, missions: [...state.missions, mission], activeMissionId: mission.id });
      break;
    }
    case 'activate': {
      if (!state.missions.some((mission) => mission.id === command.id)) {
        throw new Error('That mission is no longer active.');
      }
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      const now = Date.now();
      await save({
        ...state,
        activeMissionId: command.id,
        missions: state.missions.map((mission) => mission.id === command.id
          ? { ...mission, activatedAt: now, lastTabId: tab?.id ?? mission.lastTabId }
          : mission),
      });
      break;
    }
    case 'finish': {
      const id = command.id ?? state.activeMissionId;
      if (!id || !state.missions.some((mission) => mission.id === id)) break;
      const missions = state.missions.filter((mission) => mission.id !== id);
      await save({
        ...state,
        missions,
        activeMissionId: state.activeMissionId === id ? mostRecent(missions) : state.activeMissionId,
        completedSessions: state.completedSessions + 1,
      });
      break;
    }
    case 'save': {
      const note = command.note.trim();
      if (!note || note.length > NOTE_LIMIT) throw new Error('Enter a note of up to 240 characters.');
      const tab = await readTab(command.tabId);
      if (!tab.active || !isWebUrl(tab.url) || tab.url !== command.url || tab.pendingUrl) {
        throw new Error('This tab changed. Open FocusAnchor again to save it.');
      }
      const existing = state.parked.find((item) => item.url === tab.url);
      const belongs = chosenMission(state, existing, command.missionId);
      const savedTab: SavedTab = {
        id: existing?.id ?? crypto.randomUUID(),
        title: tab.title || new URL(tab.url).hostname,
        url: tab.url,
        note,
        missionId: belongs.missionId,
        mission: belongs.mission,
        status: 'kept-open',
      };
      await save({
        ...state,
        parked: [savedTab, ...state.parked.filter((item) => item.url !== savedTab.url)],
      });
      const map = await loadTabMap();
      map[savedTab.id] = command.tabId;
      await saveTabMap(map);
      if (!command.close) break;
      try {
        const current = await chrome.tabs.get(command.tabId);
        if (!current.active || current.url !== savedTab.url || current.pendingUrl) {
          return { ok: true, notice: 'Saved. The tab changed before it could be closed.' };
        }
        await chrome.tabs.remove(command.tabId);
      } catch {
        await reconcile();
        return { ok: true, notice: 'Saved. Chrome could not close the original tab.' };
      }
      await reconcile();
      break;
    }
    case 'open': {
      const item = state.parked.find((tab) => tab.id === command.id);
      if (!item || !isWebUrl(item.url)) throw new Error('This saved tab is unavailable.');
      const openTabs = await chrome.tabs.query({});
      const existing = findOpenTab(openTabs, item.url);
      let tabId: number;
      if (existing?.id !== undefined) {
        tabId = existing.id;
        await chrome.tabs.update(existing.id, { active: true });
        if (existing.windowId !== undefined) {
          await chrome.windows.update(existing.windowId, { focused: true }).catch(() => {});
        }
      } else {
        const created = await chrome.tabs.create({ url: item.url });
        if (created.id === undefined) throw new Error('Chrome could not open this saved tab.');
        tabId = created.id;
      }
      const map = await loadTabMap();
      map[item.id] = tabId;
      await saveTabMap(map);
      await save(markOpen(state, item.id));
      await showSavedNote(item);
      break;
    }
    case 'remove': {
      await save({ ...state, parked: state.parked.filter((tab) => tab.id !== command.id) });
      const map = await loadTabMap();
      delete map[command.id];
      await saveTabMap(map);
      break;
    }
    default:
      throw new Error('Unknown FocusAnchor action.');
  }
  return { ok: true };
}

chrome.runtime.onMessage.addListener((command: Command, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return;
  void enqueue(() => apply(command)).then(respond, (error: unknown) => {
    respond({ ok: false, error: error instanceof Error ? error.message : 'Something went wrong.' } satisfies Reply);
  });
  return true;
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  void enqueue(async () => {
    const state = await load();
    const mission = activeMission(state);
    if (!mission || mission.lastTabId === tabId) return;
    await save({
      ...state,
      missions: state.missions.map((item) => item.id === mission.id
        ? { ...item, lastTabId: tabId, tabSwitches: item.tabSwitches + 1 }
        : item),
    });
  }).catch((error: unknown) => console.error('Could not record tab switch.', error));
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void enqueue(async () => {
    const map = await loadTabMap();
    if (!Object.values(map).includes(tabId)) return;
    await reconcile();
  }).catch((error: unknown) => console.error('Could not update a saved tab.', error));
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url === undefined && tab.pendingUrl === undefined) return;
  void enqueue(async () => {
    const [map, state, openTabs] = await Promise.all([loadTabMap(), load(), chrome.tabs.query({})]);
    const tracked = Object.values(map).includes(tabId);
    const tab = openTabs.find((item) => item.id === tabId);
    const arrived = tab !== undefined && state.parked.some((item) => showsSavedPage(tab, item.url));
    if (!tracked && !arrived) return;
    await reconcile();
  }).catch((error: unknown) => console.error('Could not update a saved tab.', error));
});

void enqueue(reconcile).catch((error: unknown) => console.error('Could not sync saved tabs.', error));
