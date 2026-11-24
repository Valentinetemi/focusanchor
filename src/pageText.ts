export interface RawPage {
  title: string;
  selection: string;
  visibleText: string;
}

export async function readPage(tabId: number): Promise<RawPage | null> {
  if (!chrome.scripting?.executeScript) return null;
  try {
    const [injected] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => ({
        title: document.title ?? '',
        selection: window.getSelection?.()?.toString() ?? '',
        visibleText: document.body?.innerText ?? '',
      }),
    });
    const value = injected?.result;
    if (!value || typeof value !== 'object') return null;
    const page = value as Partial<RawPage>;
    return {
      title: typeof page.title === 'string' ? page.title : '',
      selection: typeof page.selection === 'string' ? page.selection : '',
      visibleText: typeof page.visibleText === 'string' ? page.visibleText : '',
    };
  } catch {
    return null;
  }
}
