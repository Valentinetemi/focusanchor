export const STATE_KEY = 'focusAnchor';
export const MISSION_LIMIT = 100;
export const REASON_LIMIT = 240;

export interface Mission {
  text: string;
  startedAt: number;
  tabSwitches: number;
  lastTabId: number | null;
}

export interface ParkedTab {
  id: string;
  title: string;
  url: string;
  reason: string;
  mission: string | null;
}

export interface State {
  mission: Mission | null;
  parked: ParkedTab[];
  completedSessions: number;
}

export const initialState: State = { mission: null, parked: [], completedSessions: 0 };

export type Command =
  | { type: 'start'; text: string }
  | { type: 'finish' }
  | { type: 'park'; tabId: number; url: string; reason: string }
  | { type: 'recover'; id: string }
  | { type: 'remove'; id: string };

export type Reply = { ok: true; notice?: string } | { ok: false; error: string };

export function isWebUrl(value: string | undefined): value is string {
  if (!value) return false;
  try {
    const protocol = new URL(value).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}
