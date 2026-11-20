export const STATE_KEY = 'focusAnchor';
export const MISSION_LIMIT = 100;
export const NOTE_LIMIT = 240;

export interface Mission {
  text: string;
  startedAt: number;
  tabSwitches: number;
  lastTabId: number | null;
}

export interface SavedTab {
  id: string;
  title: string;
  url: string;
  note: string;
  mission: string | null;
  status: 'kept-open' | 'closed';
}

export interface State {
  mission: Mission | null;
  parked: SavedTab[];
  completedSessions: number;
}

export const initialState: State = { mission: null, parked: [], completedSessions: 0 };

export type Command =
  | { type: 'start'; text: string }
  | { type: 'finish' }
  | { type: 'save'; tabId: number; url: string; note: string; close: boolean }
  | { type: 'open'; id: string }
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

export function normalizeState(value: unknown): State {
  const stored = value as (Partial<Omit<State, 'parked'>> & {
    parked?: Array<Partial<SavedTab> & { reason?: string }>;
  }) | undefined;
  if (!stored) return initialState;
  return {
    mission: stored.mission ?? null,
    completedSessions: stored.completedSessions ?? 0,
    parked: (stored.parked ?? []).filter((item) => (
      typeof item.id === 'string' && typeof item.title === 'string' && isWebUrl(item.url)
    )).map((item) => ({
      id: item.id!,
      title: item.title!,
      url: item.url!,
      note: typeof item.note === 'string' ? item.note : item.reason ?? '',
      mission: typeof item.mission === 'string' ? item.mission : null,
      status: item.status === 'kept-open' ? 'kept-open' : 'closed',
    })),
  };
}
