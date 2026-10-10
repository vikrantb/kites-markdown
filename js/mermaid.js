// ============================================
// Mermaid
// ============================================
async function renderMermaidDiagrams() {
  if (typeof mermaid === 'undefined') return;
  const diagrams = document.querySelectorAll('.mermaid:not(.rendered)');
  if (!diagrams.length) return;
  const t = currentTheme === 'dark' ? 'dark' : 'default';
  mermaid.initialize({ startOnLoad: false, theme: t, securityLevel: 'loose' });
  for (const el of diagrams) {
    const code = el.textContent;
    const id = el.id || 'mermaid-' + Math.random().toString(36).slice(2);
    try {
      const { svg } = await mermaid.render(id + '-svg', code);
      el.innerHTML = svg;
      el.classList.add('rendered');

      // Add expand button to wrapper
      const wrapper = el.closest('.mermaid-wrapper');
      if (wrapper && !wrapper.querySelector('.diagram-expand-btn')) {
        const btn = document.createElement('button');
        btn.className = 'diagram-expand-btn';
        btn.title = 'Expand diagram';
        btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>';
        btn.onclick = (e) => { e.stopPropagation(); openDiagramOverlay(wrapper); };
        wrapper.prepend(btn);

        // Also allow clicking the diagram itself to expand
        wrapper.style.cursor = 'pointer';
        wrapper.addEventListener('click', () => openDiagramOverlay(wrapper));
      }
    } catch (err) {
      el.innerHTML = `<pre style="color:var(--accent-danger);font-size:0.82rem">Mermaid error: ${escapeHtml(err.message)}</pre>`;
    }
  }
}

