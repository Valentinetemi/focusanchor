export const DEVICE_EXCERPT = 3200;
export const CLOUD_EXCERPT = 10000;
export const SELECTION_LIMIT = 800;
export const SUMMARY_LIMIT = 160;
export const NUDGE_LIMIT = 320;

export const CONFIG_HINT = 'Copy firebase-config.example.js to firebase-config.js, add the Firebase web app and App Check values, then rebuild.';

export type RouteLabel = 'on-device' | 'cloud';

export interface MissionChoice {
  id: string;
  text: string;
}

export interface DraftIdea {
  note: string;
  summary: string;
  missionId: string | null;
  reason: string;
}

export interface ClippedText {
  text: string;
  truncated: boolean;
}

export function routeName(route: RouteLabel): string {
  return route === 'on-device' ? 'On-device (Gemini Nano)' : 'Cloud';
}

export function routeFrom(source: string | undefined): RouteLabel {
  return source === 'on_device' ? 'on-device' : 'cloud';
}

export function clipText(value: string, max: number): ClippedText {
  const clean = value.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return { text: clean, truncated: false };
  const sliced = clean.slice(0, max);
  const boundary = sliced.lastIndexOf(' ');
  const text = (boundary > max * 0.6 ? sliced.slice(0, boundary) : sliced).trim();
  return { text, truncated: true };
}

export function pageLocation(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    const path = parsed.pathname === '/' ? '' : parsed.pathname;
    return `${parsed.hostname}${path}`;
  } catch {
    return '';
  }
}

export function draftPrompt(input: {
  title: string;
  location: string;
  selection: string;
  excerpt: string;
  truncated: boolean;
  missions: MissionChoice[];
}): string {
  const missions = input.missions.length
    ? input.missions.map((mission) => `${mission.id}: ${mission.text}`).join('\n')
    : 'None';
  return [
    'You help someone remember why they opened a browser tab.',
    'Return JSON only with keys note, summary, missionId, reason.',
    'note is first person, specific, at most 140 characters, the reason they opened the page.',
    'summary is one sentence, at most 120 characters, describing the page.',
    'missionId is the id of the mission this tab best fits, or an empty string if none fit.',
    'reason is at most 80 characters explaining the mission match, or an empty string.',
    'Do not invent personal facts that the page and missions do not support.',
    `Missions:\n${missions}`,
    `Title: ${input.title || 'Untitled'}`,
    `Page: ${input.location || 'unknown'}`,
    `Selected text: ${input.selection || 'none'}`,
    `Visible text: ${input.excerpt || 'none'}`,
    input.truncated ? 'The visible text was shortened so it can run on device.' : '',
  ].filter(Boolean).join('\n');
}

export function refocusPrompt(input: {
  title: string;
  note: string;
  summary: string;
  mission: string | null;
}): string {
  return [
    'Write one or two short sentences reminding someone what they were doing when they return to a saved tab.',
    'Use only the note, summary, mission, and title. Do not invent extra tasks.',
    'No JSON. No bullet list. At most 280 characters.',
    `Mission: ${input.mission || 'None'}`,
    `Note: ${input.note}`,
    `Summary: ${input.summary || 'None'}`,
    `Title: ${input.title}`,
  ].join('\n');
}

export function parseDraft(raw: string, missions: MissionChoice[], noteLimit: number): DraftIdea | null {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const record = parsed as Record<string, unknown>;
  const note = typeof record.note === 'string'
    ? record.note.replace(/\s+/g, ' ').trim().slice(0, noteLimit)
    : '';
  if (!note) return null;
  const summary = typeof record.summary === 'string'
    ? record.summary.replace(/\s+/g, ' ').trim().slice(0, SUMMARY_LIMIT)
    : '';
  const claimed = typeof record.missionId === 'string' ? record.missionId.trim() : '';
  const known = missions.find((mission) => mission.id === claimed)
    ?? missions.find((mission) => mission.text === claimed);
  const reason = typeof record.reason === 'string'
    ? record.reason.replace(/\s+/g, ' ').trim().slice(0, 120)
    : '';
  return {
    note,
    summary,
    missionId: known?.id ?? null,
    reason: known ? reason : '',
  };
}

export function cleanNudge(raw: string): string {
  const text = raw.replace(/^["'\s]+|["'\s]+$/g, '').replace(/\s+/g, ' ').trim();
  if (!text) throw new Error('The refocus nudge was empty.');
  return text.length > NUDGE_LIMIT ? `${text.slice(0, NUDGE_LIMIT - 3).trim()}...` : text;
}

export function friendlyAiError(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (/app ?check/i.test(message)) {
    return 'App Check rejected the request. Register the debug token in the Firebase console, then try again.';
  }
  if (/api key|API_KEY|permission denied|unauthenticated|401|403/i.test(message)) {
    return 'Firebase rejected the request. Check the web app config and that AI Logic is enabled.';
  }
  if (/failed to fetch|network|offline/i.test(message)) {
    return 'The cloud model could not be reached. You can still write the note yourself.';
  }
  if (!message) return 'Suggestion unavailable. You can still write the note yourself.';
  const clean = message.replace(/\s+/g, ' ').trim();
  return clean.length > 180 ? `${clean.slice(0, 177).trim()}...` : clean;
}
