import { initialState, isWebUrl, MISSION_LIMIT, REASON_LIMIT, STATE_KEY } from './state';
import type { Command, Reply, State } from './state';

let pending: Promise<unknown> = Promise.resolve();

function enqueue<T>(work: () => Promise<T>): Promise<T> {
  const result = pending.then(work);
  pending = result.catch(() => {});
  return result;
}

async function load(): Promise<State> {
  const stored = await chrome.storage.local.get(STATE_KEY);
  return (stored[STATE_KEY] as State | undefined) ?? initialState;
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
    case 'park': {
      const reason = command.reason.trim();
      if (!reason || reason.length > REASON_LIMIT) throw new Error('Enter a reason of up to 240 characters.');
      const tab = await chrome.tabs.get(command.tabId);
      if (!tab.active || !isWebUrl(tab.url) || tab.url !== command.url || tab.pendingUrl) {
        throw new Error('This tab changed. Open FocusAnchor again to park it.');
      }
      const parked = {
        id: crypto.randomUUID(),
        title: tab.title || new URL(tab.url).hostname,
        url: tab.url,
        reason,
        mission: state.mission?.text ?? null,
      };
      await save({ ...state, parked: [parked, ...state.parked] });
      try {
        const current = await chrome.tabs.get(command.tabId);
        if (!current.active || current.url !== parked.url || current.pendingUrl) {
          return { ok: true, notice: 'Saved. The tab changed before it could be closed.' };
        }
        await chrome.tabs.remove(command.tabId);
      } catch {
        return { ok: true, notice: 'Saved. Chrome could not close the original tab.' };
      }
      break;
    }
    case 'recover': {
      const item = state.parked.find((tab) => tab.id === command.id);
      if (!item || !isWebUrl(item.url)) throw new Error('This parked tab is unavailable.');
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
