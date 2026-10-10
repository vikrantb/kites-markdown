// ============================================
// Section toggle (collapsible headings)
// ============================================
const chevronSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';

function addSectionToggles() {
  const body = document.getElementById('mdBody');
  body.querySelectorAll('h1,h2,h3,h4').forEach(heading => {
    const level = parseInt(heading.tagName[1]);

    // Insert toggle button as first child
    const btn = document.createElement('button');
    btn.className = 'section-toggle';
    btn.innerHTML = chevronSvg;
    btn.setAttribute('aria-label', 'Toggle section');
    btn.onclick = (e) => { e.stopPropagation(); toggleSection(heading, btn); };
    heading.prepend(btn);

    // Wrap following content
    const wrapper = document.createElement('div');
    wrapper.className = 'section-content';
    wrapper.dataset.level = level;

    let sib = heading.nextElementSibling;
    while (sib) {
      if (/^H[1-6]$/.test(sib.tagName) && parseInt(sib.tagName[1]) <= level) break;
      const next = sib.nextElementSibling;
      wrapper.appendChild(sib);
      sib = next;
    }
    if (wrapper.children.length > 0) {
      heading.insertAdjacentElement('afterend', wrapper);
    } else {
      btn.style.visibility = 'hidden';
    }
  });
}

function toggleSection(heading, btn) {
  const content = heading.nextElementSibling;
  if (!content || !content.classList.contains('section-content')) return;
  const c = content.classList.toggle('collapsed');
  btn.classList.toggle('collapsed', c);
}

function toggleAllSections() {
  allCollapsed = !allCollapsed;
  document.getElementById('mdBody').querySelectorAll('.section-toggle').forEach(b => b.classList.toggle('collapsed', allCollapsed));
  document.getElementById('mdBody').querySelectorAll('.section-content').forEach(e => e.classList.toggle('collapsed', allCollapsed));
}

// ============================================
// TOC
// ============================================
function buildToc() {
  const body = document.getElementById('mdBody');
  const headings = body.querySelectorAll('h1,h2,h3,h4,h5,h6');
  const tocList = document.getElementById('tocList');
  tocList.innerHTML = '';

  if (headings.length === 0) {
    document.getElementById('tocSidebar').classList.add('hidden');
    document.getElementById('contentWrapper').classList.add('full-width');
    return;
  }

  headings.forEach((h, i) => {
    const level = parseInt(h.tagName[1]);
    const text = h.textContent.replace(/[#]/g, '').trim();
    if (!h.id) h.id = `heading-${i}`;
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.className = 'toc-link';
    a.href = `#${h.id}`;
    a.textContent = text;
    a.dataset.level = level;
    a.onclick = (e) => {
      e.preventDefault();
      document.getElementById(h.id).scrollIntoView({ behavior: 'smooth', block: 'start' });
      document.getElementById('tocSidebar').classList.remove('mobile-show');
    };
    li.appendChild(a);
    tocList.appendChild(li);
  });
}

function toggleToc() {
  const sb = document.getElementById('tocSidebar');
  const wr = document.getElementById('contentWrapper');
  if (window.innerWidth <= 900) {
    sb.classList.toggle('mobile-show');
  } else {
    tocVisible = !tocVisible;
    sb.classList.toggle('hidden', !tocVisible);
    wr.classList.toggle('full-width', !tocVisible);
  }
}

// ============================================
// Scroll spy + breadcrumb
// ============================================
function setupScrollSpy() {
  const links = document.querySelectorAll('.toc-link');
  if (!links.length) return;

  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        const id = entry.target.id;
        links.forEach(l => l.classList.toggle('active', l.getAttribute('href') === `#${id}`));
        // Active TOC scroll
        const active = document.querySelector('.toc-link.active');
        if (active) active.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        // Breadcrumb
        document.getElementById('breadcrumb').textContent = entry.target.textContent.replace(/#/g, '').trim();
      }
    });
  }, { rootMargin: '-80px 0px -70% 0px', threshold: 0 });

  document.getElementById('mdBody').querySelectorAll('h1,h2,h3,h4,h5,h6').forEach(h => observer.observe(h));
}

// ============================================
// Search
// ============================================
function buildSearchIndex() {
  searchIndex = [];
  const body = document.getElementById('mdBody');
  body.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach(h => {
    searchIndex.push({ type: 'heading', text: h.textContent.replace(/#/g,'').trim(), id: h.id, level: parseInt(h.tagName[1]) });
  });
  body.querySelectorAll('p,li,td,blockquote').forEach(el => {
    const t = el.textContent.trim();
    if (t.length > 15) {
      let nearH = null, prev = el;
      while (prev) {
        prev = prev.previousElementSibling || (prev.parentElement !== body ? prev.parentElement : null);
        if (prev && /^H[1-6]$/.test(prev.tagName)) { nearH = prev; break; }
      }
      searchIndex.push({ type: 'content', text: t.slice(0, 200), headingId: nearH?.id, headingText: nearH?.textContent.replace(/#/g,'').trim(), element: el });
    }
  });
}

function openSearch() {
  document.getElementById('searchOverlay').classList.add('show');
  const inp = document.getElementById('searchInput');
  inp.value = ''; document.getElementById('searchResults').innerHTML = '';
  searchFocusIdx = -1;
  setTimeout(() => inp.focus(), 50);
}
function closeSearch() { document.getElementById('searchOverlay').classList.remove('show'); }

function handleSearch(q) {
  const res = document.getElementById('searchResults');
  searchFocusIdx = -1;
  if (!q || q.length < 2) { res.innerHTML = ''; return; }
  const ql = q.toLowerCase();
  const matches = searchIndex.filter(i => i.text.toLowerCase().includes(ql)).slice(0, 20);
  res.innerHTML = matches.map((m, i) => {
    const ht = highlightMatch(m.text, q);
    if (m.type === 'heading') {
      return `<div class="search-result-item" data-idx="${i}" data-action="go-search" data-arg="${i}"><span class="search-result-heading">${'#'.repeat(m.level)} ${ht}</span></div>`;
    }
    return `<div class="search-result-item" data-idx="${i}" data-action="go-search" data-arg="${i}"><span class="search-result-heading">${escapeHtml(m.headingText||'')}</span><span class="search-result-ctx">${ht}</span></div>`;
  }).join('');
  res._matches = matches;
}

function highlightMatch(text, q) {
  const e = escapeHtml(text);
  const qe = q.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  return e.replace(new RegExp(`(${qe})`,'gi'),'<span class="search-match">$1</span>');
}

function goSearch(idx) {
  const m = document.getElementById('searchResults')._matches?.[idx];
  if (!m) return;
  closeSearch();
  if (m.type === 'heading' && m.id) {
    document.getElementById(m.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } else if (m.headingId) {
    document.getElementById(m.headingId)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } else if (m.element) {
    m.element.scrollIntoView({ behavior: 'smooth', block: 'center' });
    m.element.style.background = 'var(--bg-tts-highlight)';
    setTimeout(() => { m.element.style.background = ''; }, 2000);
  }
}

function handleSearchKeys(e) {
  const items = document.getElementById('searchResults').querySelectorAll('.search-result-item');
  if (e.key === 'Escape') { closeSearch(); return; }
  if (e.key === 'ArrowDown') { e.preventDefault(); searchFocusIdx = Math.min(searchFocusIdx+1, items.length-1); items.forEach((el,i)=>el.classList.toggle('focused',i===searchFocusIdx)); items[searchFocusIdx]?.scrollIntoView({block:'nearest'}); }
  if (e.key === 'ArrowUp') { e.preventDefault(); searchFocusIdx = Math.max(searchFocusIdx-1, 0); items.forEach((el,i)=>el.classList.toggle('focused',i===searchFocusIdx)); items[searchFocusIdx]?.scrollIntoView({block:'nearest'}); }
  if (e.key === 'Enter' && searchFocusIdx >= 0) goSearch(searchFocusIdx);
}

// ============================================
// Image lightbox
// ============================================
function setupImageLightbox() {
  document.getElementById('mdBody').querySelectorAll('img').forEach(img => {
    img.addEventListener('click', () => {
      document.getElementById('lightboxImg').src = img.src;
      document.getElementById('lightbox').classList.add('show');
    });
  });
}
function closeLightbox() { document.getElementById('lightbox').classList.remove('show'); }

