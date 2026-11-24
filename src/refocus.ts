import { routeName, type RouteLabel } from './promptText.ts';

const marker = '__focusAnchorRefocus';

interface RefocusMessage {
  type?: string;
  nudge?: string;
  route?: string;
  note?: string;
  mission?: string | null;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function render(message: RefocusMessage): void {
  const nudge = typeof message.nudge === 'string' ? message.nudge : '';
  if (!nudge) return;
  document.getElementById('focusanchor-refocus')?.remove();
  const host = document.createElement('div');
  host.id = 'focusanchor-refocus';
  const shadow = host.attachShadow({ mode: 'open' });
  const route: RouteLabel = message.route === 'on-device' ? 'on-device' : 'cloud';
  const mission = typeof message.mission === 'string' && message.mission ? message.mission : '';
  const note = typeof message.note === 'string' ? message.note : '';
  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      .card {
        position: fixed;
        top: 16px;
        right: 16px;
        z-index: 2147483647;
        width: min(320px, calc(100vw - 32px));
        display: grid;
        gap: 8px;
        padding: 14px 14px 12px;
        border-radius: 18px;
        color: #0f1b33;
        background: rgba(255, 255, 255, 0.92);
        border: 1px solid rgba(255, 255, 255, 0.95);
        box-shadow: 0 16px 36px rgba(90, 110, 170, 0.22);
        font: 14px/1.4 -apple-system, BlinkMacSystemFont, "SF Pro Display", Inter, sans-serif;
      }
      h2 { margin: 0; font-size: 13px; font-weight: 500; }
      p { margin: 0; }
      .nudge { font-size: 15px; font-weight: 500; }
      .meta { color: #4a5873; font-size: 12px; }
      .row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
      .route {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        margin: 0;
        padding: 3px 8px;
        border-radius: 999px;
        background: #eef3fb;
        font-size: 11px;
        font-weight: 500;
      }
      .on-device { color: #0b7a52; }
      .cloud { color: #1d4f91; }
      .dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
      button {
        border: 0;
        background: transparent;
        color: #4a5873;
        font: inherit;
        font-size: 12px;
        cursor: pointer;
      }
    </style>
    <section class="card" role="dialog" aria-label="Back to this">
      <div class="row">
        <h2>Back to this</h2>
        <button type="button" id="dismiss">Dismiss</button>
      </div>
      <p class="nudge">${escapeHtml(nudge)}</p>
      ${note ? `<p class="meta">${escapeHtml(note)}</p>` : ''}
      ${mission ? `<p class="meta">${escapeHtml(`Mission: ${mission}`)}</p>` : ''}
      <p class="route ${route}"><span class="dot" aria-hidden="true"></span>${escapeHtml(routeName(route))}</p>
    </section>
  `;
  shadow.getElementById('dismiss')?.addEventListener('click', () => host.remove());
  (document.body ?? document.documentElement).append(host);
}

function install(): void {
  const scope = globalThis as typeof globalThis & { [marker]?: boolean };
  if (scope[marker]) return;
  scope[marker] = true;
  chrome.runtime.onMessage.addListener((message: RefocusMessage) => {
    if (message?.type !== 'refocus') return;
    render(message);
  });
}

install();
