// GitHub HTML Renderer — render an .html blob in-place on GitHub.
// GitHub shows HTML as source. This fetches the raw file with your session cookies
// (so it works on private repos you can read), rewrites intra-repo links to GitHub blob
// URLs, and displays the page in a full-viewport sandboxed iframe. Clicking a doc link
// navigates the tab to that blob, where this script re-renders it. In-page (#) anchors
// stay live.
//
// Security: the iframe is sandboxed WITHOUT allow-same-origin, so the rendered page gets
// an opaque origin. Its scripts run (diagrams, toggles) but cannot read github.com cookies,
// DOM or storage. Do not add allow-same-origin: a srcdoc iframe inherits github.com's origin,
// and with scripts enabled any .html file in any repo would run as you on GitHub.
(function () {
  "use strict";

  // Parse /{owner}/{repo}/blob/{ref}/{path...}.html  (skip non-html blobs)
  const m = location.pathname.match(/^\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+\.html?)$/i);
  if (!m) return;
  const [, owner, repo, ref, filepath] = m;
  const dir = filepath.includes("/") ? filepath.replace(/\/[^/]*$/, "") : "";
  const blobBase = `https://github.com/${owner}/${repo}/blob/${ref}/${dir ? dir + "/" : ""}`;
  const rawUrl = `https://github.com/${owner}/${repo}/raw/${ref}/${filepath}`;

  if (document.getElementById("mdv-html-render-btn")) return; // already injected

  const btn = document.createElement("button");
  btn.id = "mdv-html-render-btn";
  btn.textContent = "⚡ Render";
  btn.title = "Render this HTML page";
  btn.style.cssText =
    "position:fixed;top:64px;right:22px;z-index:2147483647;background:#f0883e;color:#160b02;" +
    "border:none;border-radius:8px;padding:9px 15px;font:700 13px/1 -apple-system,system-ui,sans-serif;" +
    "cursor:pointer;box-shadow:0 3px 12px rgba(0,0,0,.45)";
  document.documentElement.appendChild(btn);

  let iframe = null;

  function rewrite(html) {
    // Give every non-anchor link an absolute GitHub URL + target=_top so it navigates the tab.
    return html.replace(/<a\b([^>]*?)\bhref="([^"]+)"([^>]*)>/gi, (whole, pre, href, post) => {
      if (href.startsWith("#")) return whole; // in-page TOC anchor → keep inside the iframe
      let abs = href;
      if (!/^(https?:|mailto:|javascript:|data:)/i.test(href)) {
        try { abs = new URL(href, blobBase).href; } catch (_) { abs = href; }
      }
      const attrs = (pre + " " + post).replace(/\btarget="[^"]*"/gi, "").replace(/\s+/g, " ").trim();
      return `<a ${attrs} href="${abs}" target="_top">`;
    });
  }

  async function render() {
    btn.textContent = "… loading";
    try {
      const res = await fetch(rawUrl, { credentials: "include", cache: "no-cache" });
      if (!res.ok) throw new Error("HTTP " + res.status + " fetching raw file");
      const html = rewrite(await res.text());
      iframe = document.createElement("iframe");
      iframe.id = "mdv-html-render-frame";
      iframe.srcdoc = html;
      iframe.setAttribute("sandbox", "allow-scripts allow-popups allow-top-navigation-by-user-activation");
      iframe.style.cssText = "position:fixed;inset:0;width:100vw;height:100vh;border:0;z-index:2147483646;background:#0d1117";
      document.documentElement.appendChild(iframe);
      btn.textContent = "✕ Source";
    } catch (e) {
      btn.textContent = "⚡ Render";
      alert("HTML renderer: " + e.message +
            "\n(If this is a private repo, make sure you're signed in to GitHub in this tab.)");
    }
  }

  btn.addEventListener("click", () => {
    if (iframe) { iframe.remove(); iframe = null; btn.textContent = "⚡ Render"; }
    else render();
  });

  // Auto-render on first load (comment out this line to require a click each time).
  render();
})();
