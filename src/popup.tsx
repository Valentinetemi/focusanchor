import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { activeMission, formatElapsed, isWebUrl, MISSION_LIMIT, normalizeState, NOTE_LIMIT, STATE_KEY } from './state';
import type { Command, Reply, SavedTab, State } from './state';
import './style.css';

const dashboard = new URLSearchParams(location.search).has('dashboard');
type ActiveTab = { id: number; url: string; title: string };

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
      </div>
      <details className="row-menu">
        <summary aria-label={`Actions for ${item.title}`}>⋯</summary>
        <div className="menu-panel">
          <p className="domain">{domain}</p>
          <p className={`saved-status ${item.status}`}>{item.status === 'closed' ? 'Saved & closed' : 'Kept open'}</p>
          <p>{`Original mission: ${item.mission ?? 'None'}`}</p>
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
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  const noteLoadedFor = useRef<string | null>(null);
  const missionLoadedFor = useRef<string | null>(null);
  const activeMissionSeen = useRef<string | null>(null);
  const startId = useRef<string | null>(null);
  const tabRef = useRef<ActiveTab | null>(null);
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
    setNote(state.parked.find((item) => item.url === tab.url)?.note ?? '');
    noteLoadedFor.current = tab.url;
  }, [state, tab]);

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
    });
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
              onChange={(event) => setNote(event.target.value)} required placeholder="Note for this tab" />
            <div className="save-actions">
              <button type="submit" className="glass-pill" name="save-action" value="keep-open"
                aria-label="Save note & keep open" disabled={busy || !note.trim()}>Keep open</button>
              <button type="submit" className="solid-pill" name="save-action" value="close"
                aria-label="Save note & close tab" disabled={busy || !note.trim()}>Save &amp; close</button>
            </div>
          </form> : <p className="muted">Open FocusAnchor from a website to save its tab.</p>)}

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
