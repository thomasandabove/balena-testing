// HTML to Figma Importer
// Builds frames with auto layout from the layout tree that the HTML to Figma tool copies to the clipboard.

figma.showUI(__html__, { width: 360, height: 440, themeColors: true });

const STYLE_NAMES = {
  100: ['Thin', 'Hairline'],
  200: ['ExtraLight', 'Extra Light', 'UltraLight', 'Ultra Light'],
  300: ['Light'],
  400: ['Regular', 'Normal', 'Book', 'Roman'],
  500: ['Medium'],
  600: ['SemiBold', 'Semi Bold', 'DemiBold', 'Demi Bold'],
  700: ['Bold'],
  800: ['ExtraBold', 'Extra Bold', 'UltraBold', 'Ultra Bold', 'Heavy'],
  900: ['Black', 'Heavy'],
};

let fontIndex = null;
const loadedFonts = new Set();
const missingFonts = new Set();

async function getFontIndex() {
  if (!fontIndex) {
    fontIndex = new Map();
    for (const f of await figma.listAvailableFontsAsync()) {
      const key = f.fontName.family.toLowerCase();
      if (!fontIndex.has(key)) fontIndex.set(key, { family: f.fontName.family, styles: [] });
      fontIndex.get(key).styles.push(f.fontName.style);
    }
  }
  return fontIndex;
}

const squash = (s) => s.toLowerCase().replace(/[\s_-]/g, '');

async function resolveFont(family, weight, italic) {
  const index = await getFontIndex();
  let fam = index.get(String(family).toLowerCase());
  if (!fam) {
    missingFonts.add(family);
    fam = index.get('inter') || index.values().next().value;
  }
  const styles = fam.styles;
  const flat = styles.map(squash);
  const w = Math.min(900, Math.max(100, Math.round((weight || 400) / 100) * 100));
  const order = [w];
  for (let d = 100; d <= 800; d += 100) {
    if (w + d <= 900) order.push(w + d);
    if (w - d >= 100) order.push(w - d);
  }
  const passes = italic ? [true, false] : [false];
  for (const it of passes) {
    for (const ww of order) {
      for (const name of STYLE_NAMES[ww]) {
        const base = squash(name);
        const candidates = it ? (ww === 400 ? ['italic', base + 'italic'] : [base + 'italic']) : [base];
        for (const c of candidates) {
          const i = flat.indexOf(c);
          if (i >= 0) return { family: fam.family, style: styles[i] };
        }
      }
    }
  }
  const reg = flat.indexOf('regular');
  return { family: fam.family, style: styles[reg >= 0 ? reg : 0] };
}

async function loadFont(fontName) {
  const key = fontName.family + '|' + fontName.style;
  if (!loadedFonts.has(key)) {
    await figma.loadFontAsync(fontName);
    loadedFonts.add(key);
  }
}

let job = null;

function paint(p) {
  if (p.type === 'IMAGE') {
    const hash = job.hashes[p.imageRef];
    if (!hash) return null;
    const out = { type: 'IMAGE', imageHash: hash, scaleMode: p.scaleMode || 'FILL' };
    if (p.scaleMode === 'TILE' && p.scalingFactor) out.scalingFactor = p.scalingFactor;
    return out;
  }
  return p;
}

function effect(e) {
  if (e.type === 'BACKGROUND_BLUR' || e.type === 'LAYER_BLUR') return { type: e.type, radius: e.radius, visible: true };
  return { type: e.type, color: e.color, offset: e.offset, radius: e.radius, spread: e.spread || 0, visible: true, blendMode: 'NORMAL' };
}

function applyPaints(node, n) {
  if (n.type !== 'TEXT' && n.fills && 'fills' in node) {
    const fills = n.fills.map(paint).filter(Boolean);
    if (n.type !== 'SVG' || fills.length) node.fills = fills;
  }
  if (n.strokes && 'strokes' in node) {
    node.strokes = n.strokes;
    node.strokeAlign = 'INSIDE';
    const w = n.strokeWeights || [1, 1, 1, 1];
    if (w.every((v) => v === w[0])) node.strokeWeight = w[0];
    else if ('strokeTopWeight' in node) {
      node.strokeTopWeight = w[0];
      node.strokeRightWeight = w[1];
      node.strokeBottomWeight = w[2];
      node.strokeLeftWeight = w[3];
    }
    if (n.dash && 'dashPattern' in node) node.dashPattern = n.dash;
  }
  if (n.radii && 'topLeftRadius' in node) {
    node.topLeftRadius = n.radii[0];
    node.topRightRadius = n.radii[1];
    node.bottomRightRadius = n.radii[2];
    node.bottomLeftRadius = n.radii[3];
  }
  if (n.effects && 'effects' in node) node.effects = n.effects.map(effect);
  if (n.opacity != null && n.opacity < 1) node.opacity = n.opacity;
}

function applyLayout(node, L) {
  node.layoutMode = L.mode;
  if (L.wrap) {
    node.layoutWrap = 'WRAP';
    node.counterAxisSpacing = L.crossGap || 0;
  }
  node.itemSpacing = L.gap || 0;
  node.paddingTop = L.pad.t;
  node.paddingRight = L.pad.r;
  node.paddingBottom = L.pad.b;
  node.paddingLeft = L.pad.l;
  node.primaryAxisAlignItems = L.primaryAlign;
  node.counterAxisAlignItems = L.counterAlign;
}

async function makeText(n) {
  const t = figma.createText();
  const fonts = [];
  for (const s of n.segments) {
    const f = await resolveFont(s.family, s.weight, s.italic);
    await loadFont(f);
    fonts.push(f);
  }
  t.fontName = fonts[0];
  t.characters = n.text;
  let i = 0;
  n.segments.forEach((s, k) => {
    const end = Math.min(n.text.length, i + s.len);
    if (end <= i) return;
    t.setRangeFontName(i, end, fonts[k]);
    t.setRangeFontSize(i, end, Math.max(1, s.size));
    t.setRangeFills(i, end, [s.fill]);
    t.setRangeLetterSpacing(i, end, { unit: 'PIXELS', value: s.ls || 0 });
    t.setRangeLineHeight(i, end, s.lh ? { unit: 'PIXELS', value: s.lh } : { unit: 'AUTO' });
    if (s.deco) t.setRangeTextDecoration(i, end, s.deco);
    if (s.textCase) t.setRangeTextCase(i, end, s.textCase);
    if (s.href) {
      try { t.setRangeHyperlink(i, end, { type: 'URL', value: s.href }); } catch (e) { /* links are optional */ }
    }
    i = end;
  });
  t.textAlignHorizontal = n.align || 'LEFT';
  if (n.sizing === 'FIXED') {
    t.resize(Math.max(1, n.w), Math.max(1, n.h));
    t.textAutoResize = 'HEIGHT';
  } else {
    t.textAutoResize = 'WIDTH_AND_HEIGHT';
  }
  return t;
}

// Positions a child inside its parent: free placement, absolute inside auto layout, or Fill sizing.
function place(child, c, pj) {
  const auto = !!pj.layout;
  if (c.transform) {
    if (auto) child.layoutPositioning = 'ABSOLUTE';
    const t = c.transform;
    const sx = Math.hypot(t.a, t.b) || 1, sy = Math.hypot(t.c, t.d) || 1;
    if ((Math.abs(sx - 1) > 0.01 || Math.abs(sy - 1) > 0.01) && 'resize' in child) {
      try { child.resize(Math.max(0.01, c.w * sx), Math.max(0.01, c.h * sy)); } catch (e) { /* keep original size */ }
    }
    const cos = t.a / sx, sin = t.b / sx;
    child.relativeTransform = [[cos, -sin, t.x - pj.x], [sin, cos, t.y - pj.y]];
    return;
  }
  if (!auto || c.absolute) {
    if (auto) child.layoutPositioning = 'ABSOLUTE';
    child.x = c.x - pj.x;
    child.y = c.y - pj.y;
    return;
  }
  const lp = c.lp || {};
  const horizontal = pj.layout.mode === 'HORIZONTAL';
  const fillWidth = horizontal ? lp.grow : lp.crossFill;
  const fillHeight = horizontal ? lp.crossFill : lp.grow;
  if (fillWidth) {
    if (child.type === 'TEXT') child.textAutoResize = 'HEIGHT';
    child.layoutSizingHorizontal = 'FILL';
  }
  if (fillHeight && child.type !== 'TEXT') child.layoutSizingVertical = 'FILL';
}

async function make(n) {
  job.done++;
  if (job.done % 40 === 0) {
    figma.ui.postMessage({ type: 'progress', done: job.done, total: job.total });
    await new Promise((r) => setTimeout(r, 0));
  }
  let node;
  if (n.type === 'TEXT') {
    node = await makeText(n);
  } else if (n.type === 'SVG') {
    try {
      node = figma.createNodeFromSvg(n.svg);
      if (Math.abs(node.width - n.w) > 0.5 || Math.abs(node.height - n.h) > 0.5) node.resize(Math.max(0.01, n.w), Math.max(0.01, n.h));
    } catch (e) {
      node = figma.createFrame();
      node.fills = [];
      node.resize(Math.max(0.01, n.w), Math.max(0.01, n.h));
    }
  } else {
    node = figma.createFrame();
    node.fills = [];
    node.clipsContent = !!n.clips;
    if (n.layout) applyLayout(node, n.layout);
    node.resize(Math.max(0.01, n.w), Math.max(0.01, n.h));
  }
  node.name = n.name || node.name;
  applyPaints(node, n);

  if (n.type === 'FRAME' && n.children) {
    for (const c of n.children) {
      const child = await make(c);
      node.appendChild(child);
      place(child, c, n);
    }
  }
  if (n.type === 'FRAME' && n.layout) {
    const L = n.layout, horizontal = L.mode === 'HORIZONTAL';
    if (L.hugPrimary) {
      if (horizontal) node.layoutSizingHorizontal = 'HUG'; else node.layoutSizingVertical = 'HUG';
    }
    if (L.hugCross) {
      if (horizontal) node.layoutSizingVertical = 'HUG'; else node.layoutSizingHorizontal = 'HUG';
    }
  }
  return node;
}

function countNodes(n) {
  let c = 1;
  for (const k of n.children || []) c += countNodes(k);
  return c;
}

function countFrames(n, acc) {
  if (n.type === 'FRAME') {
    acc.frames++;
    if (n.layout) acc.auto++;
  }
  for (const k of n.children || []) countFrames(k, acc);
  return acc;
}

figma.ui.onmessage = async (msg) => {
  if (!msg || msg.type !== 'import') return;
  try {
    const data = msg.data;
    if (!data || data.format !== 'html-to-figma' || !data.root) {
      throw new Error('That isn’t content copied from the HTML to Figma tool. Copy it with "Auto layout" selected and paste again.');
    }
    missingFonts.clear();
    const hashes = {};
    for (const id of Object.keys(data.images || {})) {
      hashes[id] = figma.createImage(figma.base64Decode(data.images[id])).hash;
    }
    job = { hashes, done: 0, total: countNodes(data.root) };
    figma.ui.postMessage({ type: 'progress', done: 0, total: job.total });

    const root = await make(data.root);
    const page = figma.currentPage;
    let right = null;
    for (const other of page.children) {
      if (other === root) continue;
      right = right === null ? other.x + other.width : Math.max(right, other.x + other.width);
    }
    page.appendChild(root);
    root.x = right === null ? 0 : Math.round(right + 200);
    root.y = 0;
    page.selection = [root];
    figma.viewport.scrollAndZoomIntoView([root]);

    const counts = countFrames(data.root, { frames: 0, auto: 0 });
    figma.ui.postMessage({ type: 'done', name: root.name, frames: counts.frames, autoLayout: counts.auto, missingFonts: Array.from(missingFonts) });
  } catch (e) {
    figma.ui.postMessage({ type: 'error', message: String((e && e.message) || e) });
  }
};
