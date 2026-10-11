// The self-test, run inside an app window in self-test mode only: the shell injects this script (and the
// capture script before it) into the page. Outside self-test mode it is never loaded.
//
// It waits until the document has rendered (diagrams included), measures what rendered, probes the
// security boundaries without side effects, optionally exercises saving and live reload on a scratch
// copy, and reports through mdvHost.reportSelfTest. The shell adds its own checks, writes the JSON and
// exits 0 or 1.
(function () {
  'use strict';
  if (window.__mdvSelfTestStarted) return;
  window.__mdvSelfTestStarted = true;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const call = (command, args) => window.__TAURI__.core.invoke(command, args || {});
  const clip = (s, n) => (String(s).length > (n || 200) ? String(s).slice(0, n || 200) + '…' : String(s));

  async function waitFor(test, ms, what) {
    const end = Date.now() + ms;
    for (;;) {
      let value;
      try { value = test(); } catch (_) { value = null; }
      if (value) return value;
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await sleep(100);
    }
  }

  const body = () => document.getElementById('mdBody');

  function mermaidSettled() {
    const all = body().querySelectorAll('.mermaid');
    return [...all].every((el) => el.querySelector('svg') || el.classList.contains('mermaid-error') || /Mermaid error/i.test(el.textContent));
  }

  function countRendered() {
    const q = (selector) => body().querySelectorAll(selector).length;
    const comments = typeof mdvComments !== 'undefined' && Array.isArray(mdvComments) ? mdvComments : null;
    return {
      h1: q('h1'), h2: q('h2'), h3: q('h3'),
      paragraphs: q('p'), tables: q('table'), codeBlocks: q('pre code'), taskItems: q('input[type=checkbox]'),
      mermaidBlocks: q('.mermaid'), mermaidSvgs: q('.mermaid svg'),
      katex: q('.katex'), katexErrors: q('.katex-error'),
      callouts: q('.callout'), footnotes: q('.footnotes li'), links: q('a[href]'), images: q('img'),
      commentThreads: comments ? comments.filter((c) => !c.parent_id).length : null,
    };
  }

  function imageReport() {
    const imgs = [...body().querySelectorAll('img')];
    const loaded = imgs.filter((i) => i.complete && i.naturalWidth > 0);
    return {
      total: imgs.length,
      loaded: loaded.length,
      viaAssetProtocol: imgs.filter((i) => i.dataset.mdvSrc).length,
      loadedSources: loaded.map((i) => clip(i.dataset.mdvSrc || i.getAttribute('src'), 120)),
      broken: imgs.filter((i) => !(i.complete && i.naturalWidth > 0)).map((i) => clip(i.dataset.mdvSrc || i.getAttribute('src'), 120)),
    };
  }

  // Elements still carrying inline handlers: the app's CSP blocks them, so each is a dead control.
  function inlineHandlers() {
    const found = [];
    for (const el of document.querySelectorAll('*')) {
      for (const attr of el.attributes) {
        if (/^on[a-z]+$/i.test(attr.name)) found.push(`${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}[${attr.name}]`);
      }
    }
    return { count: found.length, examples: found.slice(0, 12) };
  }

  // Requests the bridge must refuse, each for one named reason: a refusal for any other reason would mean
  // the probe hit a different check and proves nothing about this one. None has a side effect.
  async function probeBridge(host) {
    const windows = /^[a-zA-Z]:[\\/]/.test(host.currentPath || '');
    const existingNonMarkdown = windows ? 'C:\\Windows\\win.ini' : '/etc/hosts';
    const folder = (host.currentPath || '').replace(/[\\/][^\\/]*$/, '');
    const sep = windows ? '\\' : '/';
    const refused = async (expected, attempt) => {
      try {
        const result = await attempt();
        if (result && result.ok === false) return { refused: result.reason === expected, code: result.reason || 'refused', expected };
        return { refused: false, result: clip(JSON.stringify(result)), expected };
      } catch (e) {
        const code = (e && e.code) || clip(e);
        return { refused: code === expected, code, expected };
      }
    };
    const out = {
      readNonMarkdown: await refused('not-markdown', () => call('mdv_read_document', { path: existingNonMarkdown })),
      openNonMarkdown: await refused('not-markdown', () => call('mdv_open_path', { path: existingNonMarkdown })),
      openScriptLink: await refused('not-allowed', () => call('mdv_open_external', { url: 'javascript:alert(1)' })),
      openFileLink: await refused('not-allowed', () => call('mdv_open_external', { url: windows ? 'file:///C:/Windows/win.ini' : 'file:///etc/hosts' })),
      saveOtherFile: await probeSaveIntoSibling(folder + sep + 'kites-self-test-sibling.md', refused),
    };
    out.allRefused = Object.values(out).every((v) => v.refused);
    return out;
  }

  // A save into another existing Markdown file in the same folder, naming that file's real version, so the
  // window-owns-its-file rule is the only thing that can refuse it. The runner puts the sibling there.
  async function probeSaveIntoSibling(sibling, refused) {
    const before = await call('mdv_read_document', { path: sibling }).catch((e) => ({ missing: (e && e.message) || String(e) }));
    if (before.missing) return { refused: false, expected: 'not-allowed', missing: `the probe needs ${sibling}: ${clip(before.missing)}` };
    const attempt = await refused('not-allowed', () => call('mdv_save_document', { path: sibling, text: 'kites-self-test: written by the probe\n', version: before.version }));
    const after = await call('mdv_read_document', { path: sibling }).catch(() => null);
    attempt.siblingUnchanged = !!after && after.text === before.text;
    attempt.refused = attempt.refused && attempt.siblingUnchanged;
    return attempt;
  }

  function waitForChange(host, test, ms) {
    return new Promise((resolve) => {
      const stop = host.onDocumentChanged((doc) => { if (test(doc)) { stop(); clearTimeout(timer); resolve(doc); } });
      const timer = setTimeout(() => { stop(); resolve(null); }, ms);
    });
  }

  // Saving and live reload, end to end, on a scratch copy (--self-test-save-probe):
  // an own save is written and not echoed back; an edit by another program arrives as a live reload;
  // a save based on the version before that edit is refused and writes nothing.
  async function probeSave(host) {
    const path = host.currentPath;
    const original = rawMarkdown;
    const echoes = [];
    const stopCounting = host.onDocumentChanged((doc) => echoes.push(doc));
    const ownSave = await host.saveDocument(path, original, host.currentMtimeMs);
    await sleep(1200); // longer than the watcher's quiet period
    stopCounting();
    const beforeEdit = host.currentMtimeMs;
    const arrived = waitForChange(host, (doc) => doc.text.includes('kites-self-test: edited elsewhere'), 6000);
    await call('mdv_self_test_external_edit');
    const liveReload = await arrived;
    await sleep(300);
    const reloadedIntoPage = rawMarkdown.includes('kites-self-test: edited elsewhere');
    // The save seam names the version before the edit by its time; the bridge sends that version's token.
    const staleSave = await host.saveDocument(path, original, beforeEdit);
    const afterStale = await host.readDocument(path).catch(() => null);
    const restore = await host.saveDocument(path, original, host.currentMtimeMs);
    const final = await host.readDocument(path).catch(() => null);
    const checks = {
      ownSaveWritten: !!(ownSave && ownSave.ok),
      ownSaveNotEchoed: echoes.length === 0,
      externalEditLiveReloaded: !!liveReload && reloadedIntoPage,
      staleSaveRefusedAsConflict: !!staleSave && staleSave.ok === false && staleSave.reason === 'conflict',
      staleSaveWroteNothing: !!afterStale && afterStale.text.includes('kites-self-test: edited elsewhere'),
      restoreSaved: !!(restore && restore.ok),
      fileEndsAsItBegan: !!final && final.text === original,
    };
    return { ok: Object.values(checks).every(Boolean), checks, staleSave: staleSave && { ok: staleSave.ok, reason: staleSave.reason } };
  }

  // Script in a document must not run. First with raw HTML straight into the page (the Content Security
  // Policy alone), then through the viewer's own render path (its sanitizer, then the CSP). An error
  // listener attached from here is the positive control: the error fires, the inline handler must not.
  async function probeSanitization() {
    window.__mdvProbeRuns = 0;
    const probe = '<img src="kites-self-test-missing.png" alt="probe" onerror="window.__mdvProbeRuns++">';
    let rawErrorFired = false;
    const box = document.createElement('div');
    box.hidden = true;
    box.innerHTML = probe;
    box.querySelector('img').addEventListener('error', () => { rawErrorFired = true; });
    document.body.appendChild(box);
    await sleep(700);
    const viaRawHtml = window.__mdvProbeRuns;
    box.remove();

    renderMarkdown('# Self-test probe\n\n' + probe + '\n', 'self-test probe');
    const img = [...body().querySelectorAll('img')].find((i) => (i.dataset.mdvSrc || i.getAttribute('src') || '').includes('kites-self-test-missing'));
    let renderErrorFired = false;
    if (img) {
      if (img.complete && img.naturalWidth === 0) renderErrorFired = true;
      img.addEventListener('error', () => { renderErrorFired = true; });
    }
    await sleep(900);
    const viaRender = window.__mdvProbeRuns - viaRawHtml;
    return {
      executed: viaRawHtml + viaRender > 0,
      viaRawHtml,
      viaRender,
      rawErrorFired,
      renderErrorFired,
      probeRendered: !!img,
      handlerAttributeKept: !!(img && img.hasAttribute('onerror')),
    };
  }

  async function run() {
    const started = performance.now();
    const host = await waitFor(() => window.mdvHost, 20000, 'window.mdvHost');
    if (!(await host.selfTestRequested())) return;
    const log = window.__mdvSelfTestLog || { consoleErrors: [], pageErrors: [], resourceErrors: [], cspViolations: [] };
    const options = (await call('mdv_self_test_options').catch(() => null)) || {};
    const report = { ok: false, failures: [], kind: host.kind };
    try {
      await waitFor(() => host.currentPath && body() && body().querySelector('h1, h2, h3, p, li, table, pre'), 30000, 'the document to render');
      await waitFor(mermaidSettled, 30000, 'the Mermaid diagrams');
      await waitFor(() => [...body().querySelectorAll('img')].every((i) => i.complete), 10000, 'the images').catch(() => null);
      await sleep(400); // the comment sidebar renders 50 ms after the document
      report.path = host.currentPath;
      report.renderedMs = Math.round(performance.now() - started);
      report.counts = countRendered();
      report.images = imageReport();
      report.inlineHandlers = inlineHandlers();
      report.title = document.title;
      const before = {
        consoleErrors: log.consoleErrors.slice(), pageErrors: log.pageErrors.slice(),
        resourceErrors: log.resourceErrors.slice(), cspViolations: log.cspViolations.slice(),
      };
      report.log = before;
      report.bridge = await probeBridge(host);
      report.save = options.saveProbe ? await probeSave(host) : null;
      report.sanitization = await probeSanitization();
      report.cspViolationsDuringProbes = log.cspViolations.slice(before.cspViolations.length);
      report.errorsDuringProbes = log.consoleErrors.slice(before.consoleErrors.length).concat(log.pageErrors.slice(before.pageErrors.length));
    } catch (e) {
      report.failures.push(clip(e && e.message ? e.message : e, 300));
    }

    const f = report.failures;
    const c = report.counts;
    if (host.kind !== 'desktop') f.push(`mdvHost.kind is ${host.kind}, not desktop`);
    if (c) {
      if (c.h1 + c.h2 + c.h3 + c.paragraphs === 0) f.push('nothing rendered');
      if (c.mermaidSvgs !== c.mermaidBlocks) f.push(`${c.mermaidSvgs} of ${c.mermaidBlocks} Mermaid diagrams rendered`);
      if (c.katexErrors) f.push(`${c.katexErrors} math errors`);
    }
    if (report.log) {
      if (report.log.consoleErrors.length) f.push(`${report.log.consoleErrors.length} console errors`);
      if (report.log.pageErrors.length) f.push(`${report.log.pageErrors.length} page errors`);
      if (report.log.cspViolations.length) f.push(`${report.log.cspViolations.length} CSP violations while rendering`);
    }
    if (report.bridge && !report.bridge.allRefused) {
      const wrong = Object.entries(report.bridge).filter(([k, v]) => k !== 'allRefused' && !v.refused);
      f.push('the bridge did not refuse as it must: ' + wrong.map(([k, v]) => `${k} (${v.missing || `${v.code || 'accepted'}, expected ${v.expected}`})`).join(', '));
    }
    if (report.save && !report.save.ok) f.push('saving or live reload failed: ' + Object.entries(report.save.checks).filter(([, v]) => !v).map(([k]) => k).join(', '));
    if (report.sanitization) {
      if (report.sanitization.executed) f.push('script in a document ran');
      if (!report.sanitization.rawErrorFired || !report.sanitization.probeRendered) f.push('the script probe did not run, so it proves nothing');
    }
    report.ok = f.length === 0;
    report.totalMs = Math.round(performance.now() - started);
    await host.reportSelfTest(report);
  }

  const begin = () => run().catch((e) => {
    const host = window.mdvHost;
    const failure = { ok: false, failures: ['self-test crashed: ' + clip(e && e.stack ? e.stack : e, 600)] };
    if (host && host.reportSelfTest) host.reportSelfTest(failure);
  });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', begin);
  else begin();
})();
