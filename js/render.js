// ============================================
// Render markdown
// ============================================
function parseFrontmatter(src) {
  const match = src.match(/^---\s*\n([\s\S]*?)\n---\s*\n/);
  if (!match) return { body: src, meta: null };
  const yamlStr = match[1];
  const body = src.slice(match[0].length);

  // Simple YAML parser for our structured frontmatter
  const meta = {};
  let currentKey = null;
  let currentList = null;
  let currentItem = null;

  for (const line of yamlStr.split('\n')) {
    const topMatch = line.match(/^(\w[\w-]*):\s*(.*)/);
    const listItemMatch = line.match(/^\s+-\s+(.*)/);
    const nestedKvMatch = line.match(/^\s+(\w[\w-]*):\s*(.*)/);

    if (topMatch && !line.startsWith(' ')) {
      currentKey = topMatch[1];
      const val = topMatch[2].replace(/^["']|["']$/g, '').trim();
      if (val) {
        meta[currentKey] = val;
        currentList = null;
      } else {
        meta[currentKey] = [];
        currentList = meta[currentKey];
        currentItem = null;
      }
    } else if (listItemMatch && currentList !== null) {
      const val = listItemMatch[1].trim();
      // Check if it's "key: value" format
      const kvMatch = val.match(/^(\w[\w-]*):\s*(.*)/);
      if (kvMatch) {
        currentItem = {};
        currentItem[kvMatch[1]] = kvMatch[2].replace(/^["']|["']$/g, '').trim();
        currentList.push(currentItem);
      } else {
        currentList.push(val.replace(/^["']|["']$/g, ''));
        currentItem = null;
      }
    } else if (nestedKvMatch && currentItem) {
      currentItem[nestedKvMatch[1]] = nestedKvMatch[2].replace(/^["']|["']$/g, '').trim();
    }
  }
  return { body, meta };
}

function renderFrontmatterDashboard(meta) {
  if (!meta) return '';
  const status = meta.status || '';
  const date = meta.date || '';
  const metrics = Array.isArray(meta.metrics) ? meta.metrics : [];
  const repos = Array.isArray(meta.repos) ? meta.repos : [];
  const abbrs = meta.abbreviations;

  if (!status && !metrics.length && !repos.length) return '';

  const statusClass = status.toLowerCase().replace(/[^a-z-]/g, '').replace('in-progress', 'in-progress') || 'draft';
  const statusNorm = statusClass.includes('ship') ? 'shipped' : statusClass.includes('progress') ? 'in-progress' : statusClass.includes('block') ? 'blocked' : 'draft';
  const dot = statusNorm === 'shipped' ? '&#9679;' : statusNorm === 'in-progress' ? '&#9675;' : statusNorm === 'blocked' ? '&#9679;' : '&#9675;';

  let html = '<div class="fm-dashboard"><div class="fm-top-row">';
  if (status) html += `<span class="fm-status-badge ${statusNorm}">${dot} ${escapeHtml(status)}</span>`;
  if (date) html += `<span class="fm-date">${escapeHtml(date)}</span>`;
  html += '</div>';

  if (metrics.length) {
    html += '<div class="fm-metrics">';
    for (const m of metrics) {
      html += `<div class="fm-metric"><span class="fm-metric-value">${escapeHtml(m.value || '')}</span><span class="fm-metric-label">${escapeHtml(m.label || '')}</span></div>`;
    }
    html += '</div>';
  }

  if (repos.length) {
    html += '<div class="fm-repos">';
    for (const r of repos) {
      if (r.github) {
        html += `<a class="fm-repo-badge" href="${escapeHtml(r.github)}" target="_blank" rel="noopener">&#9733; ${escapeHtml(r.name || 'repo')}</a>`;
      } else {
        html += `<span class="fm-repo-badge">${escapeHtml(r.name || 'repo')}</span>`;
      }
    }
    html += '</div>';
  }

  html += '</div>';
  return html;
}

function renderMarkdown(source, title) {
  const body = document.getElementById('mdBody');
  const welcome = document.getElementById('welcomeScreen');

  // Parse and strip YAML frontmatter
  const { body: stripped, meta } = parseFrontmatter(source);
  source = stripped;
  window._frontmatter = meta;

  // Extract narrations before rendering
  const { narrations } = extractNarrations(source);
  window._narrations = narrations;

  // Pre-process math
  const processed = renderMath(source);

  // Render
  const dashboardHtml = renderFrontmatterDashboard(meta);
  body.innerHTML = dashboardHtml + md.render(processed);
  body.style.display = 'block';
  welcome.style.display = 'none';
  document.getElementById('fabContainer').style.display = 'flex';
  document.getElementById('foldBtn').style.display = '';
  document.getElementById('ttsToggleBtn').style.display = '';

  // Title
  const name = (title || 'Untitled').split('/').pop();
  const path = title && title.includes('/') ? title : '';
  document.getElementById('titleText').textContent = name;
  document.getElementById('breadcrumb').textContent = path;

  // Reading stats
  const text = body.textContent;
  const words = text.split(/\s+/).filter(w => w.length > 0).length;
  const mins = Math.max(1, Math.ceil(words / 230));
  document.getElementById('readingMeta').textContent = `${words.toLocaleString()} words ~ ${mins} min read`;

  // Post-process (each wrapped so one failure doesn't block the rest)
  try { transformCalloutBlocks(); } catch(e) { console.warn('callouts:', e); }
  try { addSectionToggles(); } catch(e) { console.warn('addSectionToggles:', e); }
  try { buildToc(); } catch(e) { console.warn('buildToc:', e); }
  try { buildSectionMinimap(); } catch(e) { console.warn('minimap:', e); }
  try { buildSearchIndex(); } catch(e) { console.warn('buildSearchIndex:', e); }
  try { buildTtsSections(); } catch(e) { console.warn('buildTtsSections:', e); }
  try { renderMermaidDiagrams(); } catch(e) { console.warn('renderMermaidDiagrams:', e); }
  try { setupScrollSpy(); } catch(e) { console.warn('setupScrollSpy:', e); }
  try { setupImageLightbox(); } catch(e) { console.warn('setupImageLightbox:', e); }
  try { enhanceLinks(); } catch(e) { console.warn('enhanceLinks:', e); }
  try { applyAbbreviationTooltips(meta); } catch(e) { console.warn('abbreviations:', e); }
  try { setupMermaidClickToSection(); } catch(e) { console.warn('mermaidClick:', e); }

  // Show toolbar buttons
  try { document.getElementById('linksPanelBtn').style.display = ''; } catch(e) {}

  // Reset state
  allCollapsed = false;
  window.scrollTo({ top: 0 });
}

function escapeHtml(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

