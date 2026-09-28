# Standard Operating Procedure: End-to-End Bug Testing

## 1\. Document Control

| Detail | Information |
| --- | --- |
| SOP ID | QA-SOP-004 |
| Version | 1.0.0 |
| Scope | Cross-platform (Web, Mobile, Desktop) Application Testing |
| Objective | Standardize the execution, verification, and reporting of user journeys to catch breaking bugs. |

* * *

## 2\. Prerequisites & Environment Setup

Before initiating the testing cycle, ensure you have isolated your testing parameters from production environments.

-   **Environment Isolation:** Never run manual or automated destructive E2E tests against production databases. Ensure you have credentials for a dedicated **Staging**, **UAT**, or **Preview** environment.
-   **State Management:** Ensure you can reset or seed the database to a clean, known state before starting.
-   **Testing Tools:**
    -   _Automated:_ Have your framework frameworks (e.g., [Playwright](https://playwright.dev "Playwright E2E Testing Framework"), [Cypress](https://cypress.io "Cypress E2E Testing Framework"), or [Appium](https://appium.io "Appium Mobile Testing")) updated.
    -   _Manual/Exploratory:_ Have a browser session recorder ready (e.g., DevTools, [Bird Eats Bug](https://birdeatsbug.com "Bird Eats Bug Session Recorder"), or Loom) to record logs and screen recordings.

* * *

## 3\. Core E2E Testing Lifecycle

Use code with caution.

#### \[1. Scoping\] ──> \[2. Execution\] ──> \[3. Edge Case Triage\] ──>\[4. Reporting\]

### Phase 1: Test Scoping & Mapping

Identify the vital target areas that represent complete user workflows. Do not assert implementation details (like specific CSS classes); focus entirely on user-visible behavior.

-   **Authentication & Access:** Registration, log in, session expiration, log out, and role-based permissions.
-   **Primary Value Loop:** The absolute core function of the app (e.g., Adding an item to a cart -> checking out -> payment verification).
-   **Data Integrity:** Creating, reading, updating, and deleting an entity (CRUD), ensuring values persist across page reloads.

### Phase 2: Test Execution Protocol

Follow these explicit sequence rules to ensure test repeatability and avoid false positives:

1.  **Clear Storage:** Wipe browser local storage, session storage, and cookies before booting the application.
2.  **Execute Chronologically:** Follow the defined user paths. Avoid jumping ahead using direct URL manipulation unless testing deep-linking behavior.
3.  **Handle Wait States:** Do not use arbitrary fixed timers (e.g., `sleep(5000)`). Explicitly wait for visual cues like element visibility, element interactivty, or network idle states.
4.  **Inspect Console & Network:** Keep browser developer tools open. Flag any `5xx` or unresolved `4xx` server errors, even if the UI fails gracefully.

### Phase 3: Edge Case & Boundary Verification

Once the "happy path" functions properly, attempt to break the system logic systematically.

-   **Input Boundaries:** Inject empty strings, `null` values, max length boundaries, special characters (`!@#$%^&*`), and emoji characters into all input fields.
-   **Interruption Handling:** Test network degradation (throttling to 3G/Offline), hitting the browser "Back" button mid-transaction, and rapidly double-clicking submit buttons.

* * *

## 4\. Bug Reporting Standards

If a step fails or unexpected behavior is observed, log a ticket immediately following this strict formatting template.

### Bug Report Template

```markdown
### 🚨 [BUG] Short, Descriptive Title (e.g., Checkout crashes when cart has >10 items)

**Environment:** Staging v2.4.1 | Chrome 120.0 | MacOS Sonoma  
**Severity:** Critical / Major / Minor  

#### 📋 Steps to Reproduce
1. Navigate to the application staging URL.
2. Log in using `test_user@example.com`.
3. Add 11 units of "Product A" to the cart.
4. Click on the checkout button in the upper right.

#### 🎯 Expected Behavior
The app redirects the user to the payment form screen with the correct total displayed.

#### ❌ Actual Behavior
The screen turns completely blank. The web console logs an unhandled type error (`TypeError: Cannot read properties of undefined`).

#### Attachments
* [Link to Screen Recording / Screenshot]
* [Network HAR file or relevant Console Logs]
```

---

### 🚨 [BUG] Modal requires double Escape to close; click and backdrop dismiss do not work

**Environment:** localhost:3000 | Chrome (DevTools MCP) | Windows  
**Severity:** Major

#### 📋 Steps to Reproduce
1. Open http://localhost:3000/ in Grid or List view.
2. Tab to a video card and press Enter to open the player modal.
3. Press Escape once.
4. Observe modal stays open, focus moves to close button.
5. Press Escape again — modal closes, focus lands on `<body>`.
6. Re-open modal, click the `×` close button or the backdrop.

#### 🎯 Expected Behavior
A single Escape dismisses the modal and returns focus to the triggering card. Clicking the close button or the backdrop also dismisses the modal.

#### ❌ Actual Behavior
First Escape only moves focus to the close button; modal remains open. Second Escape closes it. Clicking the close button or the backdrop does **not** close the modal. Focus returns to `<body>` instead of the originating card.

#### Attachments
* Live test: `modalHidden` stayed `false` after `closeBtn.click()` and after `backdrop.click()`. Only a second `Escape` keypress set `modalHidden=true`. After close, `document.activeElement` was `<body>`, not the card.

---

### 🚨 [BUG] Fixed sidebar obscures main content on tablet/mobile widths

**Environment:** localhost:3000 | Chrome (DevTools MCP) | Windows  
**Severity:** Major

#### 📋 Steps to Reproduce
1. Open http://localhost:3000/.
2. Resize viewport to 360×640.
3. Observe sidebar and main content.
4. Resize to 768×1024.
5. Observe overlap.

#### 🎯 Expected Behavior
At narrow widths the sidebar collapses behind a toggle or slides over as an overlay without obscuring the grid. No horizontal overflow.

#### ❌ Actual Behavior
360×640: sidebar is permanently visible, consuming ~264 px; grid is pushed off-screen. 768×1024: sidebar is `position: fixed; left: 0; width: 264px; z-index: 60` while `main` is `width: 768px` with no offset — sidebar overlaps the grid. 1440×900: layout is correct. `scrollWidth === innerWidth` at all breakpoints (no horizontal scrollbar), but content is hidden under the sidebar at 360–768 px.

#### Attachments
* Computed style: `.sidebar { position: fixed; width: 264px; left: 0; z-index: 60 }`, `main { width: 768px }` at 768×1024. Screenshots confirm overlap.

---

### 🚨 [BUG] View-state desync between visual layout and aria-pressed

**Environment:** localhost:3000 | Chrome (DevTools MCP) | Windows  
**Severity:** Minor

#### 📋 Steps to Reproduce
1. Open the app.
2. Click Timeline.
3. Run the state-check snippet below.

#### 🎯 Expected Behavior
`aria-pressed="true"` on the active view button matches the visible layout.

#### ❌ Actual Behavior
After clicking Timeline, the visual layout shows Timeline, but `aria-pressed` on the buttons can briefly show `Grid=true` / `Timeline=false`. After re-clicking Timeline it corrects to `Timeline=true`. This indicates a race or state-update ordering issue in view switching.

#### Attachments
* Snippet to reproduce: `const buttons = [...document.querySelectorAll('button')]; const get = name => buttons.find(b => b.textContent.trim()===name)?.getAttribute('aria-pressed'); console.log({Grid:get('Grid'),List:get('List'),Artist:get('Artist'),Timeline:get('Timeline')});`
* Live run: `{Grid:false, List:false, Artist:false, Timeline:true}` after stabilization, but intermediate states showed `Grid:true` while Timeline was visually active.

---

### 🚨 [BUG] Axe label-content-name-mismatch on grid/list cards

**Environment:** localhost:3000 | Chrome (DevTools MCP) | Windows  
**Severity:** Minor

#### 📋 Steps to Reproduce
1. Open http://localhost:3000/ in Grid or List view.
2. Run Lighthouse Accessibility audit.
3. Inspect `<article role="button" aria-label="…">` elements.

#### 🎯 Expected Behavior
No `label-content-name-mismatch` violations; cards expose a single accessible name consistent with their visible text.

#### ❌ Actual Behavior
Lighthouse reports `label-content-name-mismatch` (8×) and `agent-accessibility-tree` (1×) because `<article role="button" aria-label="…">` contains child text nodes that differ from the `aria-label`.

#### Attachments
* Desktop Lighthouse: Accessibility 100, but `errors-in-console` 2× (404/501), `label-content-name-mismatch` 8×, `agent-accessibility-tree` 1×. Source: `assets/js/ui.js` renders `<article role="button" aria-label="…">` for grid/list cards.

---

### 🚨 [BUG] Server API endpoints missing (expected on this dev server)

**Environment:** localhost:3000 | Chrome (DevTools MCP) | Windows  
**Severity:** Low

#### 📋 Steps to Reproduce
1. Open Network tab.
2. Reload the page.
3. Check for `/api/sync-shows` and `/api/fetch-status`.

#### 🎯 Expected Behavior
These endpoints return 200 with JSON (when `tools/serve.js` is running).

#### ❌ Actual Behavior
`/api/sync-shows` → 501 Not Implemented. `/api/fetch-status` → 404 Not Found. This is because the current server is `python -m http.server`, not `tools/serve.js`.

#### Attachments
* Network panel: 2× errors on reload. App still functions because `catalog.js` falls back to `fetch("data/shows.json")`.

---

* * *

## 5\. Troubleshooting & Flakiness Mitigations

-   **Flaky Automation Tests:** If an E2E test fails occasionally but passes on retry, it is flaky. Inspect element selectors first. Prefer accessible roles and semantic test IDs (e.g., `data-testid="submit-btn"`) over fragile XPath or CSS structures.
-   **Atomic Testing Principle:** Ensure every test scenario is entirely self-contained. A test should independently generate its own prerequisite mock data and not rely on data left behind by a previous test case.
