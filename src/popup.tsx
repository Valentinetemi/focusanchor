import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { formatElapsed, isWebUrl, MISSION_LIMIT, normalizeState, NOTE_LIMIT, STATE_KEY } from './state';
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

function SavedCard({ item, busy, onOpen, onRemove }: {
  item: SavedTab;
  busy: boolean;
  onOpen: () => void;
  onRemove: () => void;
}) {
  const domain = domainOf(item.url);
  return (
    <li className="card">
      <div className="card-top">
        <Favicon url={item.url} domain={domain} />
        <div className="card-id">
          <h3>{item.title}</h3>
          <p className="domain">{domain}</p>
        </div>
        <span className={`saved-status ${item.status}`}>{item.status === 'closed' ? 'Saved & closed' : 'Kept open'}</span>
      </div>
      <p className="note-preview">{item.note}</p>
      <div className="card-footer">
        <span>{`Original mission: ${item.mission ?? 'None'}`}</span>
        <div className="actions">
          <button type="button" className="reopen" disabled={busy} aria-label={`Open ${item.title}`} onClick={onOpen}>Open</button>
          <button type="button" className="quiet" disabled={busy} aria-label={`Remove ${item.title}`} onClick={onRemove}>Remove</button>
        </div>
      </div>
    </li>
  );
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

function Capybara() {
  return (
    <svg className="capybara" viewBox="0 0 64 36" width="22" height="12" role="img" aria-label="Capybara" fill="currentColor">
      <ellipse cx="38" cy="20" rx="20" ry="9.5" />
      <ellipse cx="18" cy="18" rx="12" ry="8" />
      <ellipse cx="14.5" cy="10" rx="2.8" ry="3.2" />
      <ellipse cx="7" cy="20.5" rx="4.2" ry="2.7" />
      <circle cx="15" cy="16.6" r="1.15" fill="#10161c" />
      <path d="M26 28.2v4.2M38 28.6v3.8" stroke="#10161c" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}

function App() {
  const [state, setState] = useState<State | null>(null);
  const [tab, setTab] = useState<ActiveTab | null>(null);
  const [missionText, setMissionText] = useState('');
  const [note, setNote] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  const noteLoadedFor = useRef<string | null>(null);
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
          setNote('');
          setTab(await readActiveTab(command.tabId));
        }
        return;
      }
      if (command.type === 'start') setMissionText('');
      if (command.type === 'save') {
        setMessage(reply.notice ?? (command.close ? 'Note saved and tab closed.' : 'Note saved. Tab kept open.'));
        if (command.close) {
          noteLoadedFor.current = null;
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
    void send({ type: 'start', text: missionText });
  }

  function saveTab(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    if (tab) void send({
      type: 'save',
      tabId: tab.id,
      url: tab.url,
      note,
      close: submitter?.value === 'close',
    });
  }

  function openDashboard() {
    void chrome.tabs.create({ url: chrome.runtime.getURL('index.html?dashboard') })
      .catch(() => setMessage('Could not open the dashboard.'));
  }

  const elapsed = state?.mission ? formatElapsed(state.mission.startedAt, now) : null;

  return (
    <main className={dashboard ? 'dashboard' : 'popup'}>
      <div className="shell">
        <header className="masthead">
          <div className="brand">
            <span className="mark" aria-hidden="true"><span /></span>
            <div>
              <h1>FocusAnchor</h1>
              <p>Save the tab. Keep the thought.</p>
            </div>
          </div>
          {!dashboard && <button type="button" className="quiet dashboard-link" onClick={openDashboard}>Dashboard</button>}
        </header>

        {message && <p className="notice" role="status">{message}</p>}
        {!state ? !message && <p className="muted" role="status">Loading your dashboard…</p> : <>
          <section className="mission panel" aria-labelledby="mission-heading">
            {state.mission && elapsed ? <>
              <div className="mission-top">
                <div className="mission-copy">
                  <h2 id="mission-heading"><span className="live-dot" aria-hidden="true" />Current mission</h2>
                  <p className="mission-title">{state.mission.text}</p>
                </div>
                <div className="timer-block">
                  <span className="timer-kicker">Elapsed</span>
                  <time dateTime={elapsed.dateTime} aria-label={elapsed.label}>{elapsed.display}</time>
                </div>
              </div>
              <div className="mission-footer">
                <button type="button" className="finish" disabled={busy} onClick={() => void send({ type: 'finish' })}>Finish session</button>
              </div>
            </> : (
              <form onSubmit={start}>
                <h2 id="mission-heading">Current mission</h2>
                <label className="sr-only" htmlFor="mission">What are you working on?</label>
                <input id="mission" placeholder="What are you working on?" required autoComplete="off"
                  maxLength={MISSION_LIMIT} value={missionText} onChange={(event) => setMissionText(event.target.value)} />
                <button type="submit" className="primary" disabled={busy || !missionText.trim()}>Start mission</button>
              </form>
            )}
          </section>

          <section className="stats" aria-label="Focus dashboard">
            <div><strong>{state.parked.length}</strong><span>Saved tabs</span></div>
            <div><strong>{state.mission?.tabSwitches ?? '—'}</strong><span>Tab switches</span></div>
            <div><strong>{state.completedSessions}</strong><span>Sessions finished</span></div>
          </section>

          {!dashboard && <section className="parking panel" aria-labelledby="park-heading">
            <h2 id="park-heading">Save this tab</h2>
            {tab ? <form onSubmit={saveTab}>
              <p className="tab-title">{tab.title}</p>
              <p className="domain">{domainOf(tab.url)}</p>
              <label htmlFor="note">Note</label>
              <textarea id="note" rows={2} maxLength={NOTE_LIMIT} value={note}
                onChange={(event) => setNote(event.target.value)} required placeholder="Why does this tab matter?" />
              <div className="save-actions">
                <button type="submit" className="secondary" name="save-action" value="keep-open"
                  disabled={busy || !note.trim()}>Save note &amp; keep open</button>
                <button type="submit" className="primary" name="save-action" value="close"
                  disabled={busy || !note.trim()}>Save note &amp; close tab</button>
              </div>
            </form> : <p className="muted">Open FocusAnchor from a website to save its tab.</p>}
          </section>}

          <section className="library" aria-labelledby="library-heading">
            <h2 id="library-heading">Saved tabs</h2>
            {state.parked.length === 0 ? <EmptyState /> : <ul>{state.parked.map((item) => (
              <SavedCard key={item.id} item={item} busy={busy}
                onOpen={() => void send({ type: 'open', id: item.id })}
                onRemove={() => void send({ type: 'remove', id: item.id })} />
            ))}</ul>}
          </section>
        </>}
        <footer className="colophon">
          <Capybara />
        </footer>
      </div>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
