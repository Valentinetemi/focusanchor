import { isWebUrl, MISSION_LIMIT, normalizeState, NOTE_LIMIT, STATE_KEY } from './state';
import type { Command, Reply, SavedTab, State } from './state';

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

async function apply(command: Command): Promise<Reply> {
  const state = await load();

  switch (command.type) {
    case 'start': {
      const value = command.text.trim();
      if (!value || value.length > MISSION_LIMIT) throw new Error('Enter a mission of up to 100 characters.');
      if (state.mission) throw new Error('Finish the current mission first.');
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      await save({ ...state, mission: {
        text: value,
        startedAt: Date.now(),
        tabSwitches: 0,
        lastTabId: tab?.id ?? null,
      } });
      break;
    }
    case 'finish': {
      if (state.mission) {
        await save({ ...state, mission: null, completedSessions: state.completedSessions + 1 });
      }
      break;
    }
    case 'save': {
      const note = command.note.trim();
      if (!note || note.length > NOTE_LIMIT) throw new Error('Enter a note of up to 240 characters.');
      const tab = await chrome.tabs.get(command.tabId);
      if (!tab.active || !isWebUrl(tab.url) || tab.url !== command.url || tab.pendingUrl) {
        throw new Error('This tab changed. Open FocusAnchor again to save it.');
      }
      const existing = state.parked.find((item) => item.url === tab.url);
      const savedTab: SavedTab = {
        id: existing?.id ?? crypto.randomUUID(),
        title: tab.title || new URL(tab.url).hostname,
        url: tab.url,
        note,
        mission: existing ? existing.mission : state.mission?.text ?? null,
        status: command.close ? 'closed' : 'kept-open',
      };
      await save({
        ...state,
        parked: [savedTab, ...state.parked.filter((item) => item.url !== savedTab.url)],
      });
      if (!command.close) break;
      try {
        const current = await chrome.tabs.get(command.tabId);
        if (!current.active || current.url !== savedTab.url || current.pendingUrl) {
          return { ok: true, notice: 'Saved. The tab changed before it could be closed.' };
        }
        await chrome.tabs.remove(command.tabId);
      } catch {
        return { ok: true, notice: 'Saved. Chrome could not close the original tab.' };
      }
      break;
    }
    case 'open': {
      const item = state.parked.find((tab) => tab.id === command.id);
      if (!item || !isWebUrl(item.url)) throw new Error('This saved tab is unavailable.');
      const openTabs = await chrome.tabs.query({});
      const existing = openTabs.find((tab) => tab.id !== undefined && tab.url === item.url);
      if (existing?.id !== undefined) {
        await chrome.tabs.update(existing.id, { active: true });
        if (existing.windowId !== undefined) {
          await chrome.windows.update(existing.windowId, { focused: true }).catch(() => {});
        }
        break;
      }
      await chrome.tabs.create({ url: item.url });
      break;
    }
    case 'remove': {
      await save({ ...state, parked: state.parked.filter((tab) => tab.id !== command.id) });
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
    const mission = state.mission;
    if (!mission || mission.lastTabId === tabId) return;
    await save({ ...state, mission: {
      ...mission,
      lastTabId: tabId,
      tabSwitches: mission.tabSwitches + 1,
    } });
  }).catch((error: unknown) => console.error('Could not record tab switch.', error));
});
