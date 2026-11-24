import { askHybrid } from './hybrid';
import { cleanNudge, refocusPrompt } from './promptText';

interface RequestMessage {
  type?: string;
  title?: string;
  note?: string;
  summary?: string;
  mission?: string | null;
}

chrome.runtime.onMessage.addListener((message: RequestMessage, sender, respond) => {
  if (sender.id !== chrome.runtime.id || message?.type !== 'refocus-request') return;
  const title = typeof message.title === 'string' ? message.title : '';
  const note = typeof message.note === 'string' ? message.note : '';
  const summary = typeof message.summary === 'string' ? message.summary : '';
  const mission = typeof message.mission === 'string' ? message.mission : null;
  const prompt = refocusPrompt({ title, note, summary, mission });
  void askHybrid(prompt, prompt).then(
    (answer) => respond({ ok: true, nudge: cleanNudge(answer.text), route: answer.route }),
    (error: unknown) => respond({
      ok: false,
      error: error instanceof Error ? error.message : 'Could not refocus.',
    }),
  );
  return true;
});
