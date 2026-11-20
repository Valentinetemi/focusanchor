import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { isWebUrl, MISSION_LIMIT, normalizeState, NOTE_LIMIT, STATE_KEY } from './state';
import type { Command, Reply, State } from './state';
import './style.css';

const dashboard = new URLSearchParams(location.search).has('dashboard');
type ActiveTab = { id: number; url: string; title: string };

function App() {
  const [state, setState] = useState<State | null>(null);
  const [tab, setTab] = useState<ActiveTab | null>(null);
  const [missionText, setMissionText] = useState('');
  const [note, setNote] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  const noteLoadedFor = useRef<string | null>(null);

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
    if (!dashboard) {
      void chrome.tabs.query({ active: true, currentWindow: true }).then(([current]) => {
        if (active && current?.id !== undefined && isWebUrl(current.url)) {
          setTab({ id: current.id, url: current.url, title: current.title || new URL(current.url).hostname });
        }
      }, () => { if (active) setMessage('Could not read the active tab.'); });
    }
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => {
      active = false;
      chrome.storage.onChanged.removeListener(onChange);
      window.clearInterval(timer);
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
      if (!reply.ok) {
        setMessage(reply.error);
        return;
      }
      if (command.type === 'start') setMissionText('');
      if (command.type === 'save') {
        setMessage(reply.notice ?? (command.close ? 'Note saved and tab closed.' : 'Note saved. Tab kept open.'));
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

  return (
    <main className={dashboard ? 'dashboard' : 'popup'}>
      <header className="masthead">
        <div className="brand">
          <span className="mark" aria-hidden="true"><span /></span>
          <div><h1>FocusAnchor</h1><p>Save the tab. Keep the thought.</p></div>
        </div>
        {!dashboard && <button className="quiet dashboard-link" onClick={() => {
          void chrome.tabs.create({ url: chrome.runtime.getURL('index.html?dashboard') })
            .catch(() => setMessage('Could not open the dashboard.'));
        }}>Dashboard ↗</button>}
      </header>

      <div className="content">
        {message && <p className="notice" role="status">{message}</p>}
        {!state ? !message && <p role="status">Loading your dashboard…</p> : <>
          <section className="mission" aria-labelledby="mission-heading">
            <h2 id="mission-heading">Current mission</h2>
            {state.mission ? <>
              <p className="mission-title">{state.mission.text}</p>
              <div className="mission-footer">
                <span>{Math.max(0, Math.floor((now - state.mission.startedAt) / 60_000))} min elapsed</span>
                <button className="finish" disabled={busy} onClick={() => void send({ type: 'finish' })}>Finish session</button>
              </div>
            </> : (
              <form onSubmit={start}>
                <label className="sr-only" htmlFor="mission">What are you working on?</label>
                <input id="mission" placeholder="What are you working on?" required
                  maxLength={MISSION_LIMIT} value={missionText} onChange={(e) => setMissionText(e.target.value)} />
                <button className="primary" disabled={busy || !missionText.trim()}>Start mission</button>
              </form>
            )}
          </section>

          <section className="stats" aria-label="Focus dashboard">
            <div><strong>{state.parked.length}</strong><span>Saved tabs</span></div>
            <div><strong>{state.mission?.tabSwitches ?? '—'}</strong><span>Tab switches</span></div>
            <div><strong>{state.completedSessions}</strong><span>Sessions finished</span></div>
          </section>

          {!dashboard && <section className="parking" aria-labelledby="park-heading">
            <h2 id="park-heading">Save this tab</h2>
            {tab ? <form onSubmit={saveTab}>
              <p className="tab-title" title={tab.title}>{tab.title}</p>
              <label htmlFor="note">Note</label>
              <textarea id="note" rows={2} maxLength={NOTE_LIMIT} value={note}
                onChange={(e) => setNote(e.target.value)} required placeholder="A reminder for your future self" />
              <div className="save-actions">
                <button className="secondary" name="save-action" value="keep-open"
                  disabled={busy || !note.trim()}>Save note &amp; keep open</button>
                <button className="primary" name="save-action" value="close"
                  disabled={busy || !note.trim()}>Save note &amp; close tab</button>
              </div>
            </form> : <p className="muted">Open FocusAnchor from a website to save its tab.</p>}
          </section>}

          <section className="library" aria-labelledby="library-heading">
            <h2 id="library-heading">Saved tabs</h2>
            {state.parked.length === 0 ? <p className="muted">Your saved tabs and notes will appear here.</p> :
              <ul>{state.parked.map((item) => <li key={item.id}>
                <div className="item-heading">
                  <h3>{item.title}</h3>
                  <span className={`saved-status ${item.status}`}>{item.status === 'closed' ? 'Saved & closed' : 'Kept open'}</span>
                </div>
                <p>{item.note}</p>
                <div className="item-footer">
                  <span>{`Original mission: ${item.mission ?? 'None'}`}</span>
                  <div className="actions">
                    <button className="quiet" disabled={busy} aria-label={`Remove ${item.title}`}
                      onClick={() => void send({ type: 'remove', id: item.id })}>Remove</button>
                    <button className="reopen" disabled={busy} aria-label={`Open ${item.title}`}
                      onClick={() => void send({ type: 'open', id: item.id })}>Open ↗</button>
                  </div>
                </div>
              </li>)}</ul>}
          </section>
        </>}
      </div>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
