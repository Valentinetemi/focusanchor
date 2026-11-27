import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { activeMission, formatElapsed, isWebUrl, MISSION_LIMIT, normalizeState, NOTE_LIMIT, STATE_KEY } from './state';
import type { Command, Reply, SavedTab, State } from './state';
import {
  buildRestartPrompt,
  buildSmartAnchorPrompt,
  normalizeAiError,
  parseRestartBrief,
  parseSmartAnchor,
  restartCloudFields,
  runAiTask,
  SELECTED_TEXT_LIMIT,
  smartAnchorCloudFields,
} from './ai/core';
import type { AiPhase, AiTask, InferenceMode, InferenceSource, RestartBrief, SmartAnchor } from './ai/core';
import './style.css';

const dashboard = new URLSearchParams(location.search).has('dashboard');
type ActiveTab = { id: number; url: string; title: string };
type RestartResult = RestartBrief & { item: SavedTab; source: InferenceSource };

const phaseLabels: Record<AiPhase, string> = {
  'checking-device': 'Checking on-device AI…',
  'initializing-device': 'Preparing the on-device model…',
  generating: 'Creating a focused draft…',
  validating: 'Checking the response…',
};

function sourceLabel(source: InferenceSource): string {
  return source === 'on-device' ? 'Created on device' : 'Created with cloud fallback';
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function faviconSrc(pageUrl: string): string | null {
  try {
    const favicon = new URL(chrome.runtime.getURL('/_favicon/'));
    favicon.searchParams.set('pageUrl', pageUrl);
    favicon.searchParams.set('size', '32');
    return favicon.toString();
  } catch {
    return null;
  }
}

async function readActiveTab(ignoreId?: number): Promise<ActiveTab | null> {
  try {
    const [current] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (current?.id === undefined || current.id === ignoreId || current.pendingUrl || !isWebUrl(current.url)) {
      return null;
    }
    return {
      id: current.id,
      url: current.url,
      title: current.title || new URL(current.url).hostname,
    };
  } catch {
    return null;
  }
}

function Favicon({ url, domain }: { url: string; domain: string }) {
  const src = faviconSrc(url);
  const letter = (domain || '?').slice(0, 1).toUpperCase();
  return (
    <span className="favicon">
      <span className="favicon-letter" aria-hidden="true">{letter}</span>
      {src && <img src={src} alt="" width={16} height={16} onError={(event) => event.currentTarget.remove()} />}
    </span>
  );
}

function AnchorIcon() {
  return (
    <svg className="anchor" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <circle cx="12" cy="5.2" r="2.1" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path d="M12 7.4v11M8.2 10.4h7.6M7.2 18.2c1.1 1.5 2.7 2.3 4.8 2.3s3.7-.8 4.8-2.3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function SavedCard({ item, busy, onOpen, onRemove }: {
  item: SavedTab;
  busy: boolean;
  onOpen: () => void;
  onRemove: () => void;
}) {
  const domain = domainOf(item.url);
  return (
    <li className="tab-row">
      <Favicon url={item.url} domain={domain} />
      <div className="tab-copy">
        <p className="tab-title">{item.title}</p>
        <p className="note-preview">{item.note}</p>
        {item.anchor && <span className="anchor-badge">Smart Anchor</span>}
      </div>
      <details className="row-menu">
        <summary aria-label={`Actions for ${item.title}`}>⋯</summary>
        <div className="menu-panel">
          <p className="domain">{domain}</p>
          <p className={`saved-status ${item.status}`}>{item.status === 'closed' ? 'Saved & closed' : 'Kept open'}</p>
          <p>{`Original mission: ${item.mission ?? 'None'}`}</p>
          {item.anchor && <div className="saved-anchor">
            <p><strong>Why:</strong> {item.anchor.whyItMatters}</p>
            <p><strong>Next:</strong> {item.anchor.nextAction}</p>
            {item.anchor.question && <p><strong>Question:</strong> {item.anchor.question}</p>}
          </div>}
          <button type="button" className="reopen" disabled={busy} aria-label={`Open ${item.title}`} onClick={onOpen}>Open</button>
          <button type="button" className="quiet" disabled={busy} aria-label={`Remove ${item.title}`} onClick={onRemove}>Remove</button>
        </div>
      </details>
    </li>
  );
}

function missionGroups(state: State) {
  const grouped = new Map<string, { title: string; items: SavedTab[] }>();
  const loose: SavedTab[] = [];
  for (const item of state.parked) {
    const mission = state.missions.find((entry) => entry.id === item.missionId);
    const key = item.missionId || (item.mission ? `name:${item.mission}` : '');
    const title = mission?.text ?? item.mission ?? (item.missionId ? 'Finished mission' : '');
    if (!key || !title) {
      loose.push(item);
      continue;
    }
    const group = grouped.get(key) ?? { title, items: [] };
    group.items.push(item);
    grouped.set(key, group);
  }
  const ordered = [...state.missions]
    .sort((a, b) => b.activatedAt - a.activatedAt)
    .flatMap((mission) => {
      const group = grouped.get(mission.id);
      return group ? [{ key: mission.id, ...group }] : [];
    });
  const named = [...grouped.entries()]
    .filter(([key]) => !ordered.some((group) => group.key === key))
    .map(([key, group]) => ({ key, ...group }));
  return [
    ...ordered,
    ...named,
    ...(loose.length ? [{ key: 'none', title: 'No mission', items: loose }] : []),
  ];
}

function EmptyState() {
  return (
    <div className="empty">
      <p>Your saved tabs and notes will appear here.</p>
      <ol>
        <li><span aria-hidden="true">1</span><span>Start a mission you want to finish.</span></li>
        <li><span aria-hidden="true">2</span><span>Save a note on a distracting tab, then keep it open or close it.</span></li>
        <li><span aria-hidden="true">3</span><span>Reopen the tab from here when you need the thought back.</span></li>
      </ol>
    </div>
  );
}

function App() {
  const [state, setState] = useState<State | null>(null);
  const [tab, setTab] = useState<ActiveTab | null>(null);
  const [missionText, setMissionText] = useState('');
  const [saveMissionId, setSaveMissionId] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [note, setNote] = useState('');
  const [selectedText, setSelectedText] = useState('');
  const [smartAnchor, setSmartAnchor] = useState<SmartAnchor | null>(null);
  const [anchorSource, setAnchorSource] = useState<InferenceSource | null>(null);
  const [restartResult, setRestartResult] = useState<RestartResult | null>(null);
  const [aiMode, setAiMode] = useState<InferenceMode>('device-only');
  const [cloudConsent, setCloudConsent] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiPhase, setAiPhase] = useState<AiPhase | null>(null);
  const [aiProgress, setAiProgress] = useState(0);
  const [aiMessage, setAiMessage] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  const noteLoadedFor = useRef<string | null>(null);
  const missionLoadedFor = useRef<string | null>(null);
  const activeMissionSeen = useRef<string | null>(null);
  const startId = useRef<string | null>(null);
  const tabRef = useRef<ActiveTab | null>(null);
  const aiAbort = useRef<AbortController | null>(null);
  tabRef.current = tab;

  useEffect(() => {
    let active = true;
    let changed = false;
    const onChange: Parameters<typeof chrome.storage.onChanged.addListener>[0] = (changes, area) => {
      if (area === 'local' && changes[STATE_KEY]) {
        changed = true;
        setState(normalizeState(changes[STATE_KEY].newValue));
      }
    };
    chrome.storage.onChanged.addListener(onChange);
    void chrome.storage.local.get(STATE_KEY).then((data) => {
      if (active && !changed) setState(normalizeState(data[STATE_KEY]));
    }, () => { if (active) setMessage('Could not load your dashboard. Try reopening FocusAnchor.'); });
    const onRemoved = (tabId: number) => {
      if (tabRef.current?.id !== tabId) return;
      noteLoadedFor.current = null;
      missionLoadedFor.current = null;
      setTab(null);
      setNote('');
      setSelectedText('');
      setSmartAnchor(null);
      setAnchorSource(null);
      void readActiveTab(tabId).then((next) => { if (active) setTab(next); });
    };
    if (!dashboard) {
      void readActiveTab().then((current) => {
        if (active) setTab(current);
      }, () => { if (active) setMessage('Could not read the active tab.'); });
      chrome.tabs.onRemoved.addListener(onRemoved);
    }
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    const onVisible = () => { if (!document.hidden) setNow(Date.now()); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      active = false;
      chrome.storage.onChanged.removeListener(onChange);
      if (!dashboard) chrome.tabs.onRemoved.removeListener(onRemoved);
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  useEffect(() => {
    if (!state || !tab || noteLoadedFor.current === tab.url) return;
    const saved = state.parked.find((item) => item.url === tab.url);
    setNote(saved?.note ?? '');
    setSmartAnchor(saved?.anchor ?? null);
    setAnchorSource(null);
    setSelectedText('');
    setAiMessage('');
    noteLoadedFor.current = tab.url;
  }, [state, tab]);

  useEffect(() => () => aiAbort.current?.abort(), []);

  useEffect(() => {
    setRestartResult(null);
  }, [state?.activeMissionId]);

  useEffect(() => {
    if (!state) return;
    const ids = new Set(state.missions.map((mission) => mission.id));
    const activeId = state.activeMissionId && ids.has(state.activeMissionId) ? state.activeMissionId : null;
    const saved = tab ? state.parked.find((item) => item.url === tab.url) : undefined;
    const tabChanged = missionLoadedFor.current !== (tab?.url ?? null);
    const activeChanged = activeMissionSeen.current !== state.activeMissionId;
    missionLoadedFor.current = tab?.url ?? null;
    activeMissionSeen.current = state.activeMissionId;
    setSaveMissionId((current) => {
      if (tabChanged) return saved?.missionId && ids.has(saved.missionId) ? saved.missionId : activeId;
      if (activeChanged || !current || !ids.has(current)) return activeId;
      return current;
    });
  }, [state, tab]);

  async function send(command: Command) {
    setBusy(true);
    setMessage('');
    try {
      const reply: Reply = await chrome.runtime.sendMessage(command);
      if (!reply?.ok) {
        const error = reply?.error ?? 'Something went wrong.';
        setMessage(error);
        if (command.type === 'save' && /no longer open/i.test(error)) {
          noteLoadedFor.current = null;
          missionLoadedFor.current = null;
          setNote('');
          setSelectedText('');
          setSmartAnchor(null);
          setAnchorSource(null);
          setTab(await readActiveTab(command.tabId));
        }
        return;
      }
      if (command.type === 'start') {
        setMissionText('');
        startId.current = null;
      }
      if (command.type === 'save') {
        setMessage(reply.notice ?? (command.close ? 'Note saved and tab closed.' : 'Note saved. Tab kept open.'));
        if (command.close) {
          noteLoadedFor.current = null;
          missionLoadedFor.current = null;
          setNote('');
          setSelectedText('');
          setSmartAnchor(null);
          setAnchorSource(null);
          setTab(await readActiveTab(command.tabId));
        }
      }
    } catch {
      setMessage('Could not reach FocusAnchor. Try reopening it.');
    } finally {
      setBusy(false);
    }
  }

  function start(event: FormEvent) {
    event.preventDefault();
    if (!startId.current) startId.current = crypto.randomUUID();
    void send({ type: 'start', text: missionText, id: startId.current });
  }

  function saveTab(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    if (!tab || !state) return;
    const ids = new Set(state.missions.map((mission) => mission.id));
    const missionId = saveMissionId && ids.has(saveMissionId)
      ? saveMissionId
      : state.activeMissionId && ids.has(state.activeMissionId)
        ? state.activeMissionId
        : null;
    void send({
      type: 'save',
      tabId: tab.id,
      url: tab.url,
      note,
      close: submitter?.value === 'close',
      ...(missionId ? { missionId } : {}),
      anchor: smartAnchor,
    });
  }

  async function executeAi<T>(task: AiTask, prompt: string, parse: (text: string) => T) {
    aiAbort.current?.abort();
    const controller = new AbortController();
    aiAbort.current = controller;
    setAiBusy(true);
    setAiMessage('');
    setAiPhase('checking-device');
    setAiProgress(0);
    try {
      const { getFirebaseHybridProvider } = await import('./ai/firebase');
      return await runAiTask({
        provider: getFirebaseHybridProvider(),
        task,
        prompt,
        mode: aiMode,
        cloudConsent,
        parse,
        signal: controller.signal,
        onPhase: setAiPhase,
        onProgress: setAiProgress,
      });
    } catch (error) {
      const normalized = normalizeAiError(error);
      if (normalized.code !== 'cancelled') setAiMessage(normalized.message);
      return null;
    } finally {
      if (aiAbort.current === controller) {
        aiAbort.current = null;
        setAiBusy(false);
        setAiPhase(null);
      }
    }
  }

  async function createSmartAnchor() {
    if (!state || !tab) return;
    const mission = state.missions.find((item) => item.id === saveMissionId)
      ?? state.missions.find((item) => item.id === state.activeMissionId);
    if (!mission) {
      setAiMessage('Start or select a mission before creating a Smart Anchor.');
      return;
    }
    const input = {
      mission: mission.text,
      pageTitle: tab.title,
      existingNote: note,
      ...(selectedText.trim() ? { selectedText } : {}),
    };
    const result = await executeAi('smart-anchor', buildSmartAnchorPrompt(input), parseSmartAnchor);
    if (!result) return;
    setSmartAnchor(result.value);
    setAnchorSource(result.source);
    setNote(result.value.contextNote);
    setAiMessage(`${sourceLabel(result.source)}. Review the Smart Anchor, then save the tab.`);
  }

  async function createRestartBrief(items: SavedTab[], mission: string) {
    const referenced = items.map((item, index) => ({
      ref: `A${index + 1}`,
      title: item.title,
      note: item.note,
      ...(item.anchor ? { anchor: item.anchor } : {}),
    }));
    const allowedRefs = referenced.map((item) => item.ref);
    const result = await executeAi(
      'restart-brief',
      buildRestartPrompt({ mission, tabs: referenced }),
      (text) => parseRestartBrief(text, allowedRefs),
    );
    if (!result) return;
    const index = allowedRefs.indexOf(result.value.firstTabRef);
    const item = items[index];
    if (!item) {
      setAiMessage('The restart brief selected an unavailable tab. Try again.');
      return;
    }
    setRestartResult({ ...result.value, item, source: result.source });
    setAiMessage(`${sourceLabel(result.source)}. No saved tab or note was changed.`);
  }

  function cancelAi() {
    aiAbort.current?.abort();
  }

  function openDashboard() {
    void chrome.tabs.create({ url: chrome.runtime.getURL('index.html?dashboard') })
      .catch(() => setMessage('Could not open the dashboard.'));
  }

  const current = state ? activeMission(state) : null;
  const elapsed = current ? formatElapsed(current.startedAt, now) : null;
  const orderedMissions = state ? [...state.missions].sort((a, b) => {
    if (a.id === state.activeMissionId) return -1;
    if (b.id === state.activeMissionId) return 1;
    return b.activatedAt - a.activatedAt;
  }) : [];
  const cards = (items: SavedTab[]) => items.map((item) => (
    <SavedCard key={item.id} item={item} busy={busy}
      onOpen={() => void send({ type: 'open', id: item.id })}
      onRemove={() => void send({ type: 'remove', id: item.id })} />
  ));
  const missionForm = (
    <form className="new-mission" onSubmit={start}>
      <label className="sr-only" htmlFor="mission">{state?.missions.length ? 'New mission' : 'What are you working on?'}</label>
      <input id="mission" placeholder={state?.missions.length ? 'New mission' : 'What are you working on?'} required autoComplete="off"
        maxLength={MISSION_LIMIT} value={missionText} onChange={(event) => setMissionText(event.target.value)} />
      <button type="submit" className="solid-pill" disabled={busy || !missionText.trim()}>
        {state?.missions.length ? 'Add' : 'Start mission'}
      </button>
    </form>
  );
  const popupTabs = current
    ? state?.parked.filter((item) => {
        if (item.missionId) return item.missionId === current.id;
        if (!item.mission || item.mission !== current.text) return false;
        return state.missions.filter((mission) => mission.text === item.mission).length === 1;
      }) ?? []
    : state?.parked ?? [];
  const selectedMission = state?.missions.find((item) => item.id === saveMissionId) ?? current;
  const cloudFields = dashboard
    ? restartCloudFields()
    : smartAnchorCloudFields({
        mission: selectedMission?.text ?? '',
        pageTitle: tab?.title ?? '',
        existingNote: note,
        ...(selectedText.trim() ? { selectedText } : {}),
      });
  const needsCloudConsent = aiMode === 'hybrid' && !cloudConsent;
  const controlId = dashboard ? 'restart-ai-mode' : 'anchor-ai-mode';
  const aiControls = <div className="ai-controls">
    <label htmlFor={controlId}>AI mode</label>
    <select id={controlId} value={aiMode} disabled={aiBusy}
      onChange={(event) => setAiMode(event.target.value as InferenceMode)}>
      <option value="device-only">Device only</option>
      <option value="hybrid">Prefer device, allow cloud fallback</option>
    </select>
    {aiMode === 'hybrid' ? <>
      <p className="privacy-copy">If on-device AI is unavailable, cloud fallback sends only: {cloudFields.join(', ')}.</p>
      <label className="consent-check">
        <input type="checkbox" checked={cloudConsent} disabled={aiBusy}
          onChange={(event) => setCloudConsent(event.target.checked)} />
        <span>I allow this data to be sent to Firebase AI for this session.</span>
      </label>
    </> : <p className="privacy-copy">Device Only never sends this task to the cloud.</p>}
  </div>;
  const aiStatus = <>
    {aiBusy && aiPhase && <div className="ai-running" role="status">
      <div>
        <p>{phaseLabels[aiPhase]}</p>
        {aiPhase === 'initializing-device' && <progress max="1" value={aiProgress} aria-label="On-device model download progress" />}
      </div>
      <button type="button" className="quiet" onClick={cancelAi}>Cancel</button>
    </div>}
    {aiMessage && <p className="ai-message" role="status">{aiMessage}</p>}
  </>;

  return (
    <main className={dashboard ? 'dashboard' : 'popup'}>
      <div className="glass">
        <header className="masthead">
          <div className="brand">
            <AnchorIcon />
            <h1>FocusAnchor</h1>
          </div>
          {!dashboard && <button type="button" className="dash-link" onClick={openDashboard}>Dashboard &gt;</button>}
        </header>

        {message && <p className="notice" role="status">{message}</p>}
        {!state ? !message && <p className="muted" role="status">Loading your dashboard…</p> : <>
          <section className="mission" aria-labelledby="mission-heading">
            <h2 id="mission-heading" className="sr-only">Current mission</h2>
            {elapsed ? <time className="hero-time" dateTime={elapsed.dateTime} aria-label={elapsed.label}>{elapsed.display}</time>
              : <p className="hero-time hero-empty" aria-hidden="true">0:00</p>}
            <button type="button" className="mission-toggle" aria-expanded={pickerOpen}
              onClick={() => setPickerOpen((open) => !open)}>
              <span>{current?.text ?? 'No mission yet'}</span>
              <span className="chevron" aria-hidden="true">{pickerOpen ? '⌃' : '›'}</span>
            </button>
            <div className={pickerOpen ? 'picker open' : 'picker'}>
              {orderedMissions.map((mission) => {
                const timing = formatElapsed(mission.startedAt, now);
                const selected = mission.id === state.activeMissionId;
                return (
                  <div key={mission.id} className="mission-row">
                    <button type="button" className="mission-pick" aria-pressed={selected}
                      onClick={() => void send({ type: 'activate', id: mission.id })}>{mission.text}</button>
                    <time dateTime={timing.dateTime} aria-label={timing.label}>{timing.display}</time>
                    <button type="button" className={selected ? 'finish' : 'quiet'} disabled={busy}
                      onClick={() => void send({ type: 'finish', id: mission.id })}>Finish</button>
                  </div>
                );
              })}
              {state.missions.length > 0 && <>
                <label className="sr-only" htmlFor="save-mission">Mission for this tab</label>
                <select id="save-mission" value={saveMissionId ?? current?.id ?? ''}
                  onChange={(event) => setSaveMissionId(event.target.value)}>
                  {state.missions.map((mission) => <option key={mission.id} value={mission.id}>{mission.text}</option>)}
                </select>
              </>}
              {missionForm}
            </div>
          </section>

          {!dashboard && (tab ? <form className="note-form" onSubmit={saveTab}>
            <p className="tab-title">{tab.title}</p>
            <label className="sr-only" htmlFor="note">Note for this tab</label>
            <textarea id="note" rows={2} maxLength={NOTE_LIMIT} value={note}
              onChange={(event) => {
                setNote(event.target.value);
                setSmartAnchor(null);
                setAnchorSource(null);
              }} required placeholder="Note for this tab" />
            <details className="ai-context">
              <summary>Add selected page text</summary>
              <label htmlFor="selected-text">Paste only the text that should inform this anchor</label>
              <textarea id="selected-text" rows={3} maxLength={SELECTED_TEXT_LIMIT} value={selectedText}
                onChange={(event) => setSelectedText(event.target.value)} placeholder="Optional selected text" />
            </details>
            <section className="ai-panel" aria-labelledby="smart-anchor-heading">
              <div className="ai-heading">
                <div>
                  <h2 id="smart-anchor-heading">Smart Anchor</h2>
                  <p>Turn this page into a concrete reason and next action.</p>
                </div>
                <span aria-hidden="true">✦</span>
              </div>
              {aiControls}
              <button type="button" className="ai-button" disabled={aiBusy || !selectedMission || needsCloudConsent}
                onClick={() => void createSmartAnchor()}>
                {smartAnchor ? 'Regenerate Smart Anchor' : 'Create Smart Anchor'}
              </button>
              {aiStatus}
              {smartAnchor && <div className="anchor-preview">
                <p className="anchor-source">{anchorSource ? sourceLabel(anchorSource) : 'Saved Smart Anchor'}</p>
                <p><strong>Why it matters</strong>{smartAnchor.whyItMatters}</p>
                <p><strong>Next action</strong>{smartAnchor.nextAction}</p>
                <p><strong>Context note</strong>{smartAnchor.contextNote}</p>
                {smartAnchor.question && <p><strong>Question</strong>{smartAnchor.question}</p>}
              </div>}
            </section>
            <div className="save-actions">
              <button type="submit" className="glass-pill" name="save-action" value="keep-open"
                aria-label="Save note & keep open" disabled={busy || aiBusy || !note.trim()}>Keep open</button>
              <button type="submit" className="solid-pill" name="save-action" value="close"
                aria-label="Save note & close tab" disabled={busy || aiBusy || !note.trim()}>Save &amp; close</button>
            </div>
          </form> : <p className="muted">Open FocusAnchor from a website to save its tab.</p>)}

          {dashboard && current && popupTabs.length > 0 && <section className="ai-panel restart-panel" aria-labelledby="restart-heading">
            <div className="ai-heading">
              <div>
                <h2 id="restart-heading">Restart brief</h2>
                <p>Choose the most useful saved tab and a grounded next step.</p>
              </div>
              <span aria-hidden="true">↗</span>
            </div>
            {aiControls}
            <button type="button" className="ai-button" disabled={aiBusy || needsCloudConsent}
              onClick={() => void createRestartBrief(popupTabs, current.text)}>
              {restartResult ? 'Regenerate restart brief' : 'Create restart brief'}
            </button>
            {aiStatus}
            {restartResult && <div className="anchor-preview restart-preview">
              <p className="anchor-source">{sourceLabel(restartResult.source)}</p>
              <p><strong>Open first</strong>{restartResult.item.title}</p>
              <p><strong>Why</strong>{restartResult.firstTabReason}</p>
              <p><strong>Next action</strong>{restartResult.nextAction}</p>
              <button type="button" className="solid-pill" disabled={busy}
                onClick={() => void send({ type: 'open', id: restartResult.item.id })}>Open recommended tab</button>
            </div>}
          </section>}

          <section className="library" aria-labelledby="library-heading">
            <h2 id="library-heading" className="sr-only">Saved tabs</h2>
            {(dashboard ? state.parked : popupTabs).length === 0 ? <EmptyState /> : dashboard
              ? missionGroups(state).map((group) => (
                <div key={group.key} className="mission-group">
                  <h3>{group.title}</h3>
                  <ul>{cards(group.items)}</ul>
                </div>
              ))
              : <ul>{cards(popupTabs)}</ul>}
          </section>
        </>}
      </div>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
