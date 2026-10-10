// ============================================
// Actions: how every control of the viewer is wired
// ============================================
// The page has no inline handlers (no on* attributes in markup or in generated HTML). A control
// names what it does in its markup, and one delegated listener per event type, on document, runs it:
//
//   <button data-action="font-size" data-arg="-1">A-</button>
//
// data-action is the name of an entry in the registry below; data-arg is an optional string the
// entry receives. An entry maps event types to handlers: (element, arg, event) => void.
//
// Why: a Content Security Policy with script-src 'self' (markdown-viewer.html, and the desktop
// app's) refuses every inline handler, so the viewer's own buttons must not need one; and a
// document's markup can then never run script through an attribute.
//
// Other scripts add their controls with mdvRegisterActions({ name: { click: fn } }). New UI uses
// data-action, never on*= attributes.
//
// Rules the dispatcher keeps:
// - Listeners run in the CAPTURE phase, so an action runs before any listener on the control's
//   ancestors, exactly as an inline handler on the control did. An action that stops propagation
//   (browse-file, copy-link) therefore still hides the click from every listener above it.
// - Only the nearest [data-action] element is dispatched, so a control inside another control
//   (the Browse button inside the drop zone) never triggers both.
// - Content rendered from a document lives inside [data-mdv-document] containers (#mdBody, the
//   diagram overlay). A data-action found there runs only if its entry is marked
//   `document: true` (copy-code, which the viewer itself adds to code blocks). A document that
//   writes <button data-action="pick-workspace"> gets nothing.

const mdvActions = Object.create(null);
const mdvActionEventTypes = new Set();

function mdvRegisterActions(entries) {
  for (const [name, entry] of Object.entries(entries)) {
    mdvActions[name] = entry;
    for (const type of Object.keys(entry)) {
      if (type === 'document' || mdvActionEventTypes.has(type)) continue;
      mdvActionEventTypes.add(type);
      document.addEventListener(type, (event) => mdvDispatchAction(type, event), true);
    }
  }
}

function mdvDispatchAction(type, event) {
  const target = event.target;
  const el = target && target.closest ? target.closest('[data-action]') : null;
  if (!el) return;
  const entry = mdvActions[el.dataset.action];
  if (!entry || typeof entry[type] !== 'function') return;
  if (!entry.document && el.closest('[data-mdv-document]')) return;
  entry[type](el, el.dataset.arg, event);
}

function mdvPickFileFromDisk() {
  document.getElementById('fileInput').click();
}

mdvRegisterActions({
  // Toolbar
  'font-size':          { click: (el, arg) => changeFontSize(Number(arg)) },
  'toggle-width':       { click: () => toggleWidth() },
  'toggle-toc':         { click: () => toggleToc() },
  'toggle-all-sections':{ click: () => toggleAllSections() },
  'toggle-focus':       { click: () => toggleFocus() },
  'open-search':        { click: () => openSearch() },
  'toggle-links-panel': { click: () => toggleLinksPanel() },
  'tts-toggle':         { click: () => ttsToggle() },
  'toggle-comments':    { click: () => mdvToggleSidebar() },
  'open-writable':      { click: () => mdvOpenOrSetSaveLocation() },
  'pick-workspace':     { click: () => mdvPickWorkspace() },
  'toggle-dropdown':    { click: (el, arg) => toggleDropdown(arg) },
  'set-theme':          { click: (el, arg) => setTheme(arg) },
  'toggle-settings':    { click: () => toggleSettings() },
  'save-base-path':     { click: () => saveBasePath() },
  'open-file':          { click: () => mdvPickFileFromDisk() },
  'file-chosen':        { change: (el, arg, event) => handleFileInput(event) },

  // The welcome screen's Browse button sits inside the drop zone: the click stops here.
  'browse-file':        { click: (el, arg, event) => { event.stopPropagation(); mdvPickFileFromDisk(); } },

  // Search
  'search':             { input: (el) => handleSearch(el.value), keydown: (el, arg, event) => handleSearchKeys(event) },
  'go-search':          { click: (el, arg) => goSearch(Number(arg)) },
  // Overlays close on a click on the backdrop itself, not on anything inside it.
  'close-search':       { click: (el, arg, event) => { if (event.target === el) closeSearch(); } },
  'close-shortcuts':    { click: (el, arg, event) => { if (event.target === el) closeShortcuts(); } },
  'close-lightbox':     { click: () => closeLightbox() },

  // Diagram overlay
  'diagram-zoom':       { click: (el, arg) => diagramZoom(Number(arg)) },
  'diagram-fit':        { click: () => diagramFitToggle() },
  'close-diagram':      { click: () => closeDiagramOverlay() },

  // Links
  'copy-link':          { click: (el, arg, event) => copyLinkUrl(event) },

  // Scroll buttons
  'scroll-top':         { click: () => window.scrollTo({ top: 0, behavior: 'smooth' }) },
  'scroll-bottom':      { click: () => window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }) },

  // Read-aloud player
  'tts-prev':           { click: () => ttsPrev() },
  'tts-play-pause':     { click: () => ttsPlayPause() },
  'tts-next':           { click: () => ttsNext() },
  'tts-seek':           { click: (el, arg, event) => ttsSeekClick(event) },
  'tts-speed':          { click: () => ttsCycleSpeed() },
  'tts-stop':           { click: () => ttsStop() },

  // Notices about features that are off (render.js)
  'dismiss-notice':     { click: (el) => { const n = el.closest('.mdv-notice'); if (n) n.remove(); } },

  // Code blocks: the viewer adds this button inside rendered documents (core.js, highlight).
  'copy-code':          { click: (el) => { if (el.closest('pre')) copyCode(el); }, document: true },
});
