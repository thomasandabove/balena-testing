// Bookmarklet: captures the page you're looking at as one self-contained HTML file
// (styles, fonts and images inlined, scripts removed) for the HTML to Figma tool.
(async () => {
  if (window.__h2fSnapshot) return;
  window.__h2fSnapshot = true;

  const MAX_ASSET = 4 * 1024 * 1024, MAX_TOTAL = 30 * 1024 * 1024;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  let total = 0;
  const missed = new Set();

  // Small status card, kept in its own shadow root so the site's CSS can't touch it.
  const host = document.createElement('div');
  host.id = '__h2f_snapshot_ui';
  host.style.cssText = 'all:initial;position:fixed;top:16px;right:16px;z-index:2147483647';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>
    .c{font:14px/1.45 system-ui,-apple-system,Segoe UI,sans-serif;background:#fff;color:#15181d;border:1px solid #d4d8de;border-radius:12px;box-shadow:0 12px 32px rgba(0,0,0,.18);padding:16px;width:300px;display:flex;flex-direction:column;gap:10px}
    b{font-size:15px}.m{color:#5b6370;font-size:13px}button{font:600 14px system-ui,sans-serif;border:0;border-radius:8px;padding:10px 12px;cursor:pointer;background:#2b55e6;color:#fff}
    button.s{background:#eceef1;color:#15181d}.r{display:flex;gap:8px}.r button{flex:1}</style>
    <div class="c"><b>HTML to Figma</b><div class="m" id="m">Capturing this page…</div><div class="r" id="r" hidden></div></div>`;
  document.documentElement.appendChild(host);
  const say = (t) => { root.getElementById('m').textContent = t; };

  const close = () => { host.remove(); window.__h2fSnapshot = false; };

  try {
    // Scroll through once so lazy images load and scroll-triggered content appears.
    const startY = scrollY;
    for (let y = 0, i = 0; y < document.documentElement.scrollHeight && i < 80; y += innerHeight * 0.8, i++) {
      scrollTo(0, y);
      await wait(120);
    }
    scrollTo(0, startY);
    await wait(400);
    for (const a of (document.getAnimations ? document.getAnimations() : [])) {
      try { a.finish(); } catch { try { a.pause(); } catch {} }
    }

    const toDataUrl = (blob) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(blob); });
    const cache = new Map();
    const inline = (url) => {
      if (!url || /^(data|blob|about):/i.test(url)) return Promise.resolve(url);
      if (!cache.has(url)) {
        cache.set(url, (async () => {
          try {
            const res = await fetch(url, { mode: 'cors', credentials: new URL(url).origin === location.origin ? 'include' : 'omit' });
            if (!res.ok) throw new Error(res.status);
            const blob = await res.blob();
            if (blob.size > MAX_ASSET || total + blob.size > MAX_TOTAL) throw new Error('too large');
            total += blob.size;
            return await toDataUrl(blob);
          } catch {
            missed.add(url);
            return url;
          }
        })());
      }
      return cache.get(url);
    };
    const abs = (u, base) => { try { return new URL(u, base).href; } catch { return u; } };
    const inlineCssUrls = async (css, base) => {
      const re = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;
      const found = [...new Set([...css.matchAll(re)].map((m) => abs(m[2].trim(), base)))];
      const map = new Map(await Promise.all(found.map(async (u) => [u, await inline(u)])));
      return css.replace(re, (all, q, u) => `url("${map.get(abs(u.trim(), base)) || abs(u.trim(), base)}")`);
    };

    say('Collecting styles…');
    const sheetCss = async (sheet) => {
      const base = sheet.href || location.href;
      let text;
      try {
        const parts = [];
        for (const rule of sheet.cssRules) {
          if (rule.type === CSSRule.IMPORT_RULE && rule.styleSheet) parts.push(await sheetCss(rule.styleSheet));
          else parts.push(rule.cssText);
        }
        text = parts.join('\n');
      } catch {
        try { text = await (await fetch(sheet.href, { mode: 'cors' })).text(); } catch { missed.add(sheet.href); return ''; }
      }
      text = await inlineCssUrls(text, base);
      const media = sheet.media && sheet.media.mediaText;
      return media && media !== 'all' ? `@media ${media}{\n${text}\n}` : text;
    };
    let css = '';
    for (const sheet of document.styleSheets) {
      if (sheet.ownerNode && sheet.ownerNode.closest && sheet.ownerNode.closest('#__h2f_snapshot_ui')) continue;
      css += (await sheetCss(sheet)) + '\n';
    }
    for (const sheet of document.adoptedStyleSheets || []) css += (await sheetCss(sheet)) + '\n';

    say('Collecting images…');
    const clone = document.documentElement.cloneNode(true);
    const orig = [document.documentElement, ...document.documentElement.querySelectorAll('*')];
    const copy = [clone, ...clone.querySelectorAll('*')];
    const jobs = [];
    orig.forEach((o, i) => {
      const c = copy[i];
      if (!c) return;
      const tag = o.localName;
      if (tag === 'input' || tag === 'textarea') {
        if (o.type === 'checkbox' || o.type === 'radio') { if (o.checked) c.setAttribute('checked', ''); else c.removeAttribute('checked'); }
        else if (tag === 'textarea') c.textContent = o.value;
        else if (o.type !== 'password' && o.type !== 'file') c.setAttribute('value', o.value);
      }
      if (tag === 'select') [...o.options].forEach((opt, k) => { if (opt.selected) c.options[k].setAttribute('selected', ''); });
      if (tag === 'img') {
        const src = o.currentSrc || o.src;
        c.removeAttribute('srcset'); c.removeAttribute('sizes'); c.removeAttribute('loading');
        jobs.push(inline(src).then((u) => c.setAttribute('src', u)));
      }
      if (tag === 'source' && o.parentElement && o.parentElement.localName === 'picture') c.remove();
      if (tag === 'canvas') {
        try { const img = document.createElement('img'); img.src = o.toDataURL('image/png'); img.setAttribute('style', c.getAttribute('style') || ''); img.className = o.className; img.width = o.width; img.height = o.height; c.replaceWith(img); } catch {}
      }
      if (tag === 'video' && o.poster) jobs.push(inline(abs(o.poster, location.href)).then((u) => c.setAttribute('poster', u)));
      const style = c.getAttribute && c.getAttribute('style');
      if (style && /url\(/.test(style)) jobs.push(inlineCssUrls(style, location.href).then((s) => c.setAttribute('style', s)));
      // Open web components: keep their content as declarative shadow DOM.
      if (o.shadowRoot && o.shadowRoot.mode === 'open') {
        const t = document.createElement('template');
        t.setAttribute('shadowrootmode', 'open');
        let inner = o.shadowRoot.innerHTML;
        for (const s of o.shadowRoot.adoptedStyleSheets || []) { try { inner = `<style>${[...s.cssRules].map((r) => r.cssText).join('\n')}</style>` + inner; } catch {} }
        t.innerHTML = inner;
        c.prepend(t);
      }
      for (const a of [...(c.attributes || [])]) {
        if (/^on/i.test(a.name) || /^\s*javascript:/i.test(a.value)) c.removeAttribute(a.name);
      }
    });
    await Promise.all(jobs);

    clone.querySelectorAll('script, noscript, link[rel~="stylesheet"], link[rel="preload"], link[rel="modulepreload"], style, #__h2f_snapshot_ui').forEach((el) => el.remove());
    let head = clone.querySelector('head');
    if (!head) { head = document.createElement('head'); clone.prepend(head); }
    const meta = document.createElement('meta');
    meta.name = 'h2f-source';
    meta.content = location.href;
    meta.setAttribute('data-width', String(innerWidth));
    meta.setAttribute('data-height', String(innerHeight));
    const base = document.createElement('base');
    base.href = location.href;
    const style = document.createElement('style');
    style.textContent = css.replace(/<\/style/gi, '<\\/style');
    head.prepend(style);
    head.prepend(base);
    head.prepend(meta);
    if (!head.querySelector('meta[charset]')) { const cs = document.createElement('meta'); cs.setAttribute('charset', 'utf-8'); head.prepend(cs); }

    const html = '<!DOCTYPE html>\n' + clone.outerHTML;
    const size = html.length > 1048576 ? (html.length / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(html.length / 1024)) + ' KB';
    say(`Captured "${document.title || location.hostname}" (${size})${missed.size ? `. ${missed.size} file${missed.size > 1 ? 's' : ''} couldn't be read and may be missing` : ''}. Copy it, then press ⌘V / Ctrl V in the HTML to Figma tool.`);

    const row = root.getElementById('r');
    row.hidden = false;
    const copyBtn = document.createElement('button');
    copyBtn.textContent = 'Copy page';
    copyBtn.onclick = async () => {
      let ok = false;
      try { await navigator.clipboard.writeText(html); ok = true; } catch {
        const ta = document.createElement('textarea');
        ta.value = html; root.appendChild(ta); ta.select();
        try { ok = document.execCommand('copy'); } catch {}
        ta.remove();
      }
      say(ok ? 'Copied. Go back to the HTML to Figma tool and press ⌘V / Ctrl V.' : 'Your browser blocked the clipboard. Use Download instead and upload the file to the tool.');
    };
    const dl = document.createElement('button');
    dl.className = 's';
    dl.textContent = 'Download';
    dl.onclick = () => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
      a.download = (location.hostname + location.pathname).replace(/[^\w.-]+/g, '-').replace(/-+$/, '') + '.html';
      a.click();
    };
    const x = document.createElement('button');
    x.className = 's';
    x.textContent = 'Close';
    x.onclick = close;
    row.append(copyBtn, dl, x);
  } catch (e) {
    say('Capture failed: ' + (e && e.message ? e.message : e));
    setTimeout(close, 6000);
  }
})();
