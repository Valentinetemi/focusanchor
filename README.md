# FocusAnchor

Save the tab. Keep the thought.

FocusAnchor is a Chrome extension for picking one mission and saving a note on a distracting tab, whether you keep it open or close it. Come back to the tab later with its note and the mission you were working on.

## Install locally

Use Chrome and Node.js 24 LTS (24.15 or newer).

```sh
npm ci
npm run build
```

1. Open `chrome://extensions` in Chrome and enable **Developer mode**.
2. Click **Load unpacked** and select this project's `dist` directory.
3. Open Chrome's extensions menu and pin **FocusAnchor**. After rebuilding, click **Reload** on its card in `chrome://extensions`.

## Try the full flow

1. Open two ordinary websites in the same window. Click the FocusAnchor toolbar icon and start a mission, such as “Finish my hackathon submission.”
2. Switch to the other website. Reopen FocusAnchor, enter a note, and choose **Save note & keep open** or **Save note & close tab**. Saving the same URL again updates its note instead of creating a duplicate.
3. Open FocusAnchor again. Under **Saved tabs**, check the title, note, save action, and original mission. Click **Open** to switch to an existing matching tab or restore the URL when it is no longer open. **Remove** deletes the saved entry.
4. Open **Dashboard** for the full-page view. **Finish session** clears the mission and adds one to the completed-session count.

The elapsed timer measures time since the mission started. The switch count measures Chrome tab activation changes during that mission, including changes caused by closing or opening tabs. It remains a plain browser activity count. Saved tabs is the number of unique URLs currently saved.

Run `npm test` to build the extension and exercise the popup and service worker with mocked Chrome APIs. The toolbar walkthrough above checks browser permissions and tab behavior in Chrome.

## Permissions and data

- `activeTab` lets the popup read the current tab's URL and title when opened from the toolbar. Saving supports HTTP and HTTPS pages.
- `tabs` lets the dashboard find and focus an already-open saved URL before it creates a new tab.
- `storage` persists the mission, dashboard counts, and saved URLs, titles, notes, save actions, and original missions in this Chrome profile. The extension has no server or analytics.
- FocusAnchor saves the record before attempting to close the tab. Reopening restores the URL, so unsaved form content or other page state may be lost when a tab closes.

Built with React, TypeScript, and Vite for Manifest V3.
