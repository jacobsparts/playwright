# playwright-cli with Browser Control

## Connection

Start a session against a running browser-control server:

```bash
playwright-cli open --browser-control=http://localhost:3001
```

Connect to a specific session by ID:

```bash
playwright-cli open --browser-control=http://localhost:3001 --browser-control-session-id=my-session
```

Close the session when done:

```bash
playwright-cli close
```

## Navigation

```bash
playwright-cli goto https://example.com
playwright-cli go-back
playwright-cli go-forward
playwright-cli reload
```

## Page Inspection

### Snapshots

Capture an ARIA snapshot of the page. Returns a tree of elements with refs (e.g. `e3`, `e42`) used to target interactions.

```bash
playwright-cli snapshot
```

Partial snapshot rooted at a CSS selector:

```bash
playwright-cli snapshot "main"
```

Save to a specific file:

```bash
playwright-cli snapshot --filename=page.yml
```

### Screenshots

```bash
playwright-cli screenshot
playwright-cli screenshot --filename=shot.png
playwright-cli screenshot --full-page          # full scrollable page
playwright-cli screenshot e5                   # specific element by ref
```

### Evaluate JavaScript

```bash
playwright-cli eval "() => document.title"
playwright-cli eval "() => window.innerWidth"
playwright-cli eval "(el) => el.textContent" e3   # with element ref
```

## Interaction

### Clicking

Click by element ref from a snapshot:

```bash
playwright-cli click e6
playwright-cli click e6 right           # right-click
playwright-cli dblclick e6              # double-click
```

### Typing

Type into the currently focused element (fires full key event sequence per character):

```bash
playwright-cli type "hello world"
```

Fill a specific element by ref (sets value directly, faster):

```bash
playwright-cli fill e42 "search query"
playwright-cli fill e42 "query" --submit   # press Enter after
```

### Keyboard

```bash
playwright-cli press Enter
playwright-cli press Tab
playwright-cli press ArrowDown
playwright-cli press a
```

Low-level key control:

```bash
playwright-cli keydown Shift
playwright-cli press ArrowDown        # Shift+ArrowDown
playwright-cli keyup Shift
```

### Mouse

Coordinate-based mouse control. Coordinates are 1:1 with screenshot pixels.

```bash
playwright-cli mousemove 400 300
playwright-cli mousedown
playwright-cli mouseup
```

Scroll:

```bash
playwright-cli mousewheel 0 300       # scroll down
playwright-cli mousewheel 0 -300      # scroll up
```

### Hover

```bash
playwright-cli hover e10
```

### Drag and Drop

```bash
playwright-cli drag e5 e12            # drag from ref to ref
```

### Forms

```bash
playwright-cli fill e15 "user@example.com"
playwright-cli select e20 "option-value"
playwright-cli check e25
playwright-cli uncheck e25
playwright-cli upload /path/to/file.pdf
```

### Dialogs

```bash
playwright-cli dialog-accept
playwright-cli dialog-accept "prompt text"
playwright-cli dialog-dismiss
```

## Tabs

```bash
playwright-cli tab-list
playwright-cli tab-new https://example.com
playwright-cli tab-select 2
playwright-cli tab-close               # close current
playwright-cli tab-close 1             # close by index
```

## Viewport

```bash
playwright-cli resize 1920 1080
```

## Cookies

Cookies are accessed via the `chrome.cookies` extension API (includes httpOnly cookies).

```bash
playwright-cli cookie-list
playwright-cli cookie-list --domain=example.com
playwright-cli cookie-get session_id
playwright-cli cookie-set name value --domain=.example.com --secure --httpOnly
playwright-cli cookie-delete session_id
playwright-cli cookie-clear
```

## Storage

### Local Storage

```bash
playwright-cli localstorage-list
playwright-cli localstorage-get key
playwright-cli localstorage-set key value
playwright-cli localstorage-delete key
playwright-cli localstorage-clear
```

### Session Storage

```bash
playwright-cli sessionstorage-list
playwright-cli sessionstorage-get key
playwright-cli sessionstorage-set key value
playwright-cli sessionstorage-delete key
playwright-cli sessionstorage-clear
```

### Auth State

Save and restore cookies + localStorage:

```bash
playwright-cli state-save auth.json
playwright-cli state-load auth.json
```

## Network

### Request Log

```bash
playwright-cli network
playwright-cli network --static              # include images/fonts/scripts
playwright-cli network --request-body        # include request bodies
playwright-cli network --filter="/api/.*"    # filter by URL regex
playwright-cli network --clear
```

### Route Mocking

```bash
playwright-cli route "**/api/users" --status=200 --body='[{"name":"test"}]' --content-type=application/json
playwright-cli route-list
playwright-cli unroute "**/api/users"
playwright-cli unroute                       # remove all routes
```

### Offline Mode

```bash
playwright-cli network-state-set offline
playwright-cli network-state-set online
```

## DevTools

### Console

```bash
playwright-cli console                       # info and above
playwright-cli console error                 # errors only
playwright-cli console --clear
```

### Run Playwright Code

Execute a Playwright script with access to `page`:

```bash
playwright-cli run-code "await page.waitForSelector('.loaded')"
playwright-cli run-code --filename=script.js
```

### Tracing

```bash
playwright-cli tracing-start
# ... perform actions ...
playwright-cli tracing-stop
```

### Video

```bash
playwright-cli video-start
# ... perform actions ...
playwright-cli video-stop --filename=recording.webm
```

## PDF

```bash
playwright-cli pdf
playwright-cli pdf --filename=page.pdf
```

## Session Management

```bash
playwright-cli list                          # list sessions
playwright-cli close-all                     # close all sessions
playwright-cli kill-all                      # force kill stale sessions
playwright-cli delete-data                   # delete session profile data
```

Multiple named sessions:

```bash
playwright-cli -s=work open --browser-control=http://localhost:3001
playwright-cli -s=personal open --browser-control=http://localhost:3001 --browser-control-session-id=other

playwright-cli -s=work goto https://example.com
playwright-cli -s=personal goto https://other.com
```

## Node.js API

```javascript
const { chromium } = require('playwright-core');

const browser = await chromium.connectToBrowserControl('http://localhost:3001');
// Or with a specific session:
// const browser = await chromium.connectToBrowserControl('http://localhost:3001', { sessionId: 'my-session' });

const context = browser.contexts()[0];
const page = context.pages()[0];

await page.goto('https://example.com');
const title = await page.title();
const screenshot = await page.screenshot();

await browser.close();
```

## Notes

- **Snapshots vs screenshots**: Snapshots return an ARIA tree (fast, structured, gives element refs). Screenshots return a PNG image. Use snapshots for interaction targeting, screenshots for visual verification.
- **`type` vs `fill`**: `type` fires individual key events per character (realistic, triggers autocomplete). `fill` sets the value directly (faster, no per-key events).
- **Mouse coordinates**: 1:1 with screenshot pixels. Use `eval` with `getBoundingClientRect()` to find element coordinates when refs aren't available.
- **Event fidelity**: Mouse actions dispatch the full pointer+mouse event sequence (pointerover, mouseover, pointerenter, mouseenter, pointermove, mousemove, pointerdown, mousedown, focus, pointerup, mouseup, click). Keyboard actions dispatch keydown, keypress, InputEvent, keyup.
