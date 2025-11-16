# DOM Highlighter

Preview any public web page inside a sandboxed iframe, visually inspect its DOM, and capture an ordered set of annotated highlights you can export, re-import, and replay later.

## Features

- **Chromium preview (Electron)** – launch the app as a desktop shell so remote
  sites execute with a real browser engine, bypassing CORS and CSP hurdles.
- **Live preview** – fetches the remote HTML server-side, rewrites it with a permissive base and injected scripts, then renders it in an iframe.
- **Interactive highlighting** – hover to see a flashing outline; click to lock a highlight; double-click to remove a lock; `Esc` clears all locks.
- **Inline annotations** – type notes for each locked element in the sidebar; annotations appear as floating callouts beside their elements only when content is present.
- **Replay & persistence** – export the current highlight sequence as JSON, import it back, or replay the sequence to restore highlights in order (helpful for walkthroughs or reviews).
- **Resilient injection** – automatically restores injected assets if the remote page attempts to remove them and keeps annotations positioned on scroll/resize.
- **Flow view (dual-screen friendly)** – open a separate流程图窗口 via **流程图**按钮查看/调整动作顺序，主界面与流程图实时同步。

## Getting Started

### Prerequisites

- Node.js 18+ (Node 22 LTS recommended)

### Install & Run

```bash
npm install
npm start
```

Running `npm start` launches the Electron desktop shell with a full Chromium
preview surface. If you still need the browser-based version (e.g. for quick
tests), run:

```bash
npm run web
```

and open [http://localhost:3000](http://localhost:3000).

> **Note:** The web fallback fetches target pages from the local Express server. If you run behind a reverse proxy, ensure `X-Forwarded-Proto` is set so asset URLs resolve correctly.

## Using the App

1. Enter a URL in the top-left field (include `https://` for best results) and press **Preview**.
2. Hover elements in the preview to see outlines; **click** to lock a highlight. Locked elements appear in the **Highlights** list.
3. Add annotations by typing in the textarea for each highlight. The note bubble is only rendered when the annotation has content.
4. **Double-click** a highlighted element in the preview (or press **Remove** in the list) to clear that highlight. Press **Esc** to remove all.
5. Use the sidebar actions:
   - **Highlight**: reapply the selector immediately.
   - **Replay**: step through all saved highlights in order (clears existing locks first).
   - **Export JSON**: download the ordered highlight data.
   - **Import**: load a previously exported JSON file and optionally replay it.

### Keyboard / Pointer Summary

- Hover → temporary outline
- Click → toggle lock on the hovered element
- Double-click → remove the locked highlight
- `Esc` → clear all locked highlights

## JSON Format

Exports now describe a **scene** composed of ordered actions (macro-style). Example:

```json
{
  "version": 1,
  "name": "示例场景",
  "generatedAt": "2024-11-30T10:45:00.123Z",
  "actions": [
    {
      "id": "a1",
      "order": 1,
      "type": "highlight",
      "selector": "#hero h1",
      "description": "h1#hero-title (512×96)",
      "annotation": "Primary headline"
    },
    {
      "id": "a2",
      "order": 2,
      "type": "click",
      "selector": ".cta-button",
      "annotation": "点击 CTA"
    },
    {
      "id": "a3",
      "order": 3,
      "type": "input",
      "selector": "input[name=email]",
      "value": "test@example.com",
      "annotation": "输入邮箱"
    },
    {
      "id": "a4",
      "order": 4,
      "type": "wait",
      "durationMs": 500,
      "annotation": "等待接口完成"
    }
  ],
  "highlights": [
    {
      "order": 1,
      "selector": "#hero h1",
      "description": "h1#hero-title (512×96)",
      "annotation": "Primary headline"
    }
  ]
}
```

- `type` supports `highlight`, `click`, `input`, `wait` (more can be added later).
- `selector` is the CSS path used during replay (best-effort, based on tag/id/class/nth-of-type).
- `annotation` holds the user-supplied note (empty strings are ignored by the overlay).
- The `highlights` array remains for backward compatibility with older exports; new clients prefer the `actions` list.

## Limitations & Tips

- **CORS / mixed content**: In the Electron preview the embedded Chromium instance follows the site's own security model, so most browser-only pages just work. When using the web fallback (`npm run web`), the old iframe-based fetch is still subject to CORS quirks.
- **Dynamic pages**: Sites that aggressively mutate the DOM may remove locks. The injector re-applies styles and removes entries whose elements disappear.
- **Selectors**: Replaying imported highlights depends on selectors still matching. If markup changes, entries will be marked “Element not found.” You can update the annotation to document the gap or delete the highlight.
- **Security**: The tool renders remote HTML directly. Avoid pointing it at untrusted internal sites unless you trust their scripts inside your browser sandbox.

## Project Structure

```
.
├── electron/          # Electron entry point + preload scripts
├── server.js          # Express server that fetches remote pages and injects assets
├── public/
│   ├── index.html     # Main UI layout
│   ├── styles.css     # Layout and sidebar styling
│   ├── main.js        # UI state management, iframe messaging, import/export logic
│   ├── injected.js    # Script injected into the preview page (highlight logic)
│   └── injected.css   # Highlight outlines and note styling
├── package.json
└── package-lock.json
```

## Development Notes

- Express 5 is used with native `fetch`. No client build step—static assets are plain HTML/CSS/JS.
- The server strips `<meta http-equiv="content-security-policy">` tags to ensure the injected scripts run.
- Highlight annotations are exchanged with the parent via `postMessage` (browser) or a proxied IPC bridge (Electron). Only messages flagged with `__domHighlighter` are processed.

## License

ISC © 2024
