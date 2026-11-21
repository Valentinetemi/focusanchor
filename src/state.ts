export const STATE_KEY = 'focusAnchor';
export const MISSION_LIMIT = 100;
export const NOTE_LIMIT = 240;

export interface Mission {
  id: string;
  text: string;
  startedAt: number;
  activatedAt: number;
  tabSwitches: number;
  lastTabId: number | null;
}

export interface SavedTab {
  id: string;
  title: string;
  url: string;
  note: string;
  missionId: string | null;
  mission: string | null;
  status: 'kept-open' | 'closed';
}

export interface State {
  missions: Mission[];
  activeMissionId: string | null;
  parked: SavedTab[];
  completedSessions: number;
}

export const initialState: State = { missions: [], activeMissionId: null, parked: [], completedSessions: 0 };

export type Command =
  | { type: 'start'; text: string }
  | { type: 'finish'; id?: string }
  | { type: 'activate'; id: string }
  | { type: 'save'; tabId: number; url: string; note: string; close: boolean; missionId?: string | null }
  | { type: 'open'; id: string }
  | { type: 'remove'; id: string };

export function activeMission(state: State): Mission | null {
  return state.missions.find((mission) => mission.id === state.activeMissionId) ?? null;
}

export type Reply = { ok: true; notice?: string } | { ok: false; error: string };

export interface Elapsed {
  display: string;
  label: string;
  dateTime: string;
}

export function formatElapsed(startedAt: number, now: number): Elapsed {
  const totalSeconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (value: number) => String(value).padStart(2, '0');
  const display = hours > 0
    ? `${hours}:${pad(minutes)}:${pad(seconds)}`
    : `${minutes}:${pad(seconds)}`;
  const unit = (value: number, name: string) => `${value} ${name}${value === 1 ? '' : 's'}`;
  const spoken = [
    hours > 0 ? unit(hours, 'hour') : '',
    unit(minutes, 'minute'),
    unit(seconds, 'second'),
  ].filter(Boolean).join(' ');
  return {
    display,
    label: `${spoken} elapsed`,
    dateTime: `PT${hours}H${minutes}M${seconds}S`,
  };
}

export function isWebUrl(value: string | undefined): value is string {
  if (!value) return false;
  try {
    const protocol = new URL(value).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

type RawMission = Partial<Mission> | null | undefined;
type RawState = {
  mission?: RawMission;
  missions?: RawMission[];
  activeMissionId?: unknown;
  parked?: Array<Partial<SavedTab> & { reason?: string }>;
  completedSessions?: unknown;
};

function readMission(value: RawMission, fallbackId: string): Mission | null {
  if (!value || typeof value.text !== 'string' || !value.text.trim()) return null;
  const startedAt = typeof value.startedAt === 'number' && Number.isFinite(value.startedAt) ? value.startedAt : 0;
  const activatedAt = typeof value.activatedAt === 'number' && Number.isFinite(value.activatedAt)
    ? value.activatedAt
    : startedAt;
  return {
    id: typeof value.id === 'string' && value.id.trim() ? value.id : fallbackId,
    text: value.text.trim().slice(0, MISSION_LIMIT),
    startedAt,
    activatedAt,
    tabSwitches: typeof value.tabSwitches === 'number' && value.tabSwitches >= 0 ? Math.floor(value.tabSwitches) : 0,
    lastTabId: typeof value.lastTabId === 'number' && Number.isInteger(value.lastTabId) ? value.lastTabId : null,
  };
}

export function normalizeState(value: unknown): State {
  if (!value || typeof value !== 'object') return initialState;
  const stored = value as RawState;
  const seen = new Set<string>();
  const source = Array.isArray(stored.missions) && stored.missions.length > 0
    ? stored.missions
    : stored.mission ? [stored.mission] : [];
  const missions = source.flatMap((item, index) => {
    const startedAt = item && typeof item.startedAt === 'number' ? item.startedAt : index;
    const mission = readMission(item, `legacy-${startedAt}`);
    if (!mission) return [];
    if (seen.has(mission.id)) mission.id = `${mission.id}-${index}`;
    seen.add(mission.id);
    return [mission];
  });
  const requested = typeof stored.activeMissionId === 'string' ? stored.activeMissionId : null;
  const activeMissionId = missions.some((mission) => mission.id === requested)
    ? requested
    : [...missions].sort((a, b) => b.activatedAt - a.activatedAt)[0]?.id ?? null;
  return {
    missions,
    activeMissionId,
    completedSessions: typeof stored.completedSessions === 'number' && stored.completedSessions >= 0
      ? Math.floor(stored.completedSessions)
      : 0,
    parked: (stored.parked ?? []).filter((item) => (
      typeof item.id === 'string' && typeof item.title === 'string' && isWebUrl(item.url)
    )).map((item) => {
      const missionText = typeof item.mission === 'string' ? item.mission : null;
      const explicit = typeof item.missionId === 'string' ? item.missionId : null;
      const matched = explicit && missions.some((mission) => mission.id === explicit)
        ? explicit
        : missions.filter((mission) => mission.text === missionText);
      const missionId = typeof matched === 'string' ? matched : matched.length === 1 ? matched[0].id : null;
      return {
        id: item.id!,
        title: item.title!,
        url: item.url!,
        note: typeof item.note === 'string' ? item.note : item.reason ?? '',
        missionId,
        mission: missionText ?? missions.find((mission) => mission.id === missionId)?.text ?? null,
        status: item.status === 'kept-open' ? 'kept-open' : 'closed',
      };
    }),
  };
}
