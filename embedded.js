window.__OCR_SHADOW_ROOT__=document.getElementById('ocrEmbeddedHost')?.shadowRoot;(function(){

"use strict";
const ocrRoot=window.__OCR_SHADOW_ROOT__; const $=id=>ocrRoot?.querySelector('#'+id);
let imgW=1,imgH=1,drag=null;


function extractEquipmentOCRLines(data){
  const lines=Array.isArray(data?.lines)?data.lines:[];
  return lines.map(line=>{
    const b=line?.bbox||{};
    const x0=Number(b.x0??line?.x??0), y0=Number(b.y0??line?.y??0);
    const x1=Number(b.x1??(x0+Number(line?.width||0))), y1=Number(b.y1??(y0+Number(line?.height||0)));
    return {text:String(line?.text||'').trim(),confidence:Number(line?.confidence||0),x:x0,y:y0,width:Math.max(0,x1-x0),height:Math.max(0,y1-y0)};
  }).filter(x=>x.text&&x.width>0&&x.height>0);
}

function detectEquipmentRegions(screen, lines) {
  const width = Math.max(1, Number(screen?.width) || 1);
  const height = Math.max(1, Number(screen?.height) || 1);

  // The equipment list is a left-side UI column. Keep the detector out of the
  // character/status area and reject OCR boxes that look like frame lines.
  const leftLimit = width * 0.25;
  const cardWidth = width * 0.22;
  const clean = v => String(v || '').normalize('NFKC')
    .replace(/[\s\u3000・･·•\-‐‑‒–—―＿_.,，。！？!?、:：;；/／\\|｜()[\]{}「」『』【】〈〉《》<>＋+＝=＊*#＃%％&＆@＠]/g, '');

  const labelDefs = [
    ['mainWeapon', 'メイン武器'],
    ['subWeapon',  'サブ武器'],
    ['head',       '頭防具'],
    ['chest',      '胴防具'],
    ['arms',       '腕防具'],
    ['waist',      '腰防具'],
    ['legs',       '脚防具'],
    ['charm',      '護石'],
    ['mantle',     '装衣']
  ];
  const orderedKeys = labelDefs.map(x => x[0]);
  const keyIndex = new Map(orderedKeys.map((key, i) => [key, i]));

  const levenshtein = (a, b) => {
    const aa = String(a), bb = String(b);
    if (!aa) return bb.length;
    if (!bb) return aa.length;
    let prev = Array.from({length: bb.length + 1}, (_, i) => i);
    for (let i = 1; i <= aa.length; i++) {
      const cur = [i];
      for (let j = 1; j <= bb.length; j++) {
        cur[j] = Math.min(
          cur[j - 1] + 1,
          prev[j] + 1,
          prev[j - 1] + (aa[i - 1] === bb[j - 1] ? 0 : 1)
        );
      }
      prev = cur;
    }
    return prev[bb.length];
  };
  const similarity = (a, b) => {
    const aa = clean(a), bb = clean(b);
    if (!aa || !bb) return 0;
    return 1 - levenshtein(aa, bb) / Math.max(aa.length, bb.length);
  };

  const source = (Array.isArray(lines) ? lines : []).map((l, i) => {
    const norm = clean(l?.text);
    return {
      i,
      text: String(l?.text || '').trim(),
      norm,
      x: Math.max(0, Number(l?.x) || 0),
      y: Math.max(0, Number(l?.y) || 0),
      width: Math.max(0, Number(l?.width) || 0),
      height: Math.max(0, Number(l?.height) || 0),
      confidence: Math.max(0, Math.min(100, Number(l?.confidence) || 0))
    };
  }).filter(l =>
    l.text && l.norm.length >= 2 && l.width > 0 && l.height > 0 &&
    l.x < leftLimit && l.width <= leftLimit
  ).sort((a, b) => a.y - b.y);

  // Only normalize aliases that have actually been observed in this game's UI.
  const normalizeEquipmentLabel = text => {
    const n = clean(text);
    const aliases = {
      '腰防四': '腰防具',
      '脚防思': '脚防具',
      '腰防貝': '腰防具',
      '脚防所': '脚防具'
    };
    return aliases[n] || n;
  };

  const scoreLabel = (line, expected) => {
    const got = normalizeEquipmentLabel(line.norm);
    const want = normalizeEquipmentLabel(expected);
    if (!got || !want) return 0;
    if (got === want) return 1;
    if (want.length >= 3 && got.length >= 3 && got.slice(0, 2) === want.slice(0, 2)) {
      const suffixScore = similarity(got.slice(2), want.slice(2));
      if (got.length === want.length) return 0.72 + 0.20 * suffixScore;
    }
    const sim = similarity(got, want);
    return sim >= 0.72 ? sim * 0.88 : 0;
  };

  const findLabel = (expected, startIndex) => {
    let best = null;
    for (let i = startIndex; i < source.length; i++) {
      const line = source[i];
      const s = scoreLabel(line, expected);
      if (!s) continue;
      const exactBonus = normalizeEquipmentLabel(line.norm) === normalizeEquipmentLabel(expected) ? 0.25 : 0;
      const score = s + exactBonus + line.confidence / 1000;
      if (!best || score > best.score) {
        best = {line, index: i, score, matchScore: s, canonicalLabel: normalizeEquipmentLabel(expected)};
      }
    }
    return best;
  };

  const found = [];
  let cursor = 0;
  for (const [key, expected] of labelDefs) {
    const hit = findLabel(expected, cursor);
    if (!hit) continue;
    found.push({key, label: hit.line, index: hit.index, matchScore: hit.matchScore || 0, canonicalLabel: hit.canonicalLabel || hit.line.text});
    cursor = hit.index + 1;
  }

  // v3.1.2: retain the geometry of the actual equipment-name OCR line.
  // The text itself may be wrong; only its bounding box is used downstream.
  // Search only between this semantic label and the next semantic label so a
  // neighbouring row cannot become the name anchor.
  const labelIndices = new Set(found.map(f => f.index));
  for (const f of found) {
    const label = f.label;
    const nextLabelIndex = found.find(g => g.index > f.index)?.index ?? source.length;
    const labelY = Number(label.y) || 0;
    const labelH = Math.max(1, Number(label.height) || 1);
    const rowPitchHint = Math.max(40, labelH * 3.5);
    const maxY = labelY + Math.max(labelH * 2.2, rowPitchHint * 0.55);
    const candidates = source.slice(f.index + 1, nextLabelIndex)
      .filter(line => line.y >= labelY + labelH * 0.35 && line.y <= maxY)
      .filter(line => line.x >= label.x - Math.max(24, labelH * 1.5))
      .filter(line => normalizeEquipmentLabel(line.norm) !== f.canonicalLabel)
      .filter(line => line.norm.length >= 3 && line.width >= Math.max(24, label.width * 0.55));
    if (candidates.length) {
      candidates.sort((a,b) => {
        const da=Math.abs(a.y-(labelY+labelH));
        const db=Math.abs(b.y-(labelY+labelH));
        return da-db || b.confidence-a.confidence || b.width-a.width;
      });
      f.nameAnchor = candidates[0];
    }
  }

  // -------------------------------------------------------------------------
  // v6: infer the vertical scale/pitch from the screenshot itself.
  // No fixed 198px value is used. Every OCR-confirmed label is an anchor with
  // a semantic row index. Pairwise slopes (dy / row-distance) give candidate
  // pitches; the median is robust to a single bad anchor. The fitted intercept
  // then places every row, including rows whose label OCR failed.
  // -------------------------------------------------------------------------
  const anchors = found.map(f => ({
    key: f.key,
    index: keyIndex.get(f.key),
    y: Number(f.label.y),
    x: Number(f.label.x),
    confidence: Number(f.label.confidence) || 0,
    matchScore: Number(f.matchScore) || 0,
    label: f.label,
    canonicalLabel: f.canonicalLabel || f.label.text
  })).filter(a => Number.isFinite(a.index) && Number.isFinite(a.y));

  const median = values => {
    const a = values.filter(Number.isFinite).slice().sort((x, y) => x - y);
    if (!a.length) return null;
    const m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  };

  let pitch = null;
  let pitchSource = 'none';
  let pitchConfidence = 0;
  if (anchors.length >= 2) {
    const slopes = [];
    for (let i = 0; i < anchors.length; i++) {
      for (let j = i + 1; j < anchors.length; j++) {
        const di = anchors[j].index - anchors[i].index;
        if (di <= 0) continue;
        const dy = anchors[j].y - anchors[i].y;
        if (dy > 0) slopes.push(dy / di);
      }
    }

    // Choose the slope with the strongest consensus instead of blindly taking
    // the median. A single bad OCR anchor can create several large pairwise
    // slopes; the densest cluster remains representative of the real UI pitch.
    if (slopes.length) {
      let best = null;
      for (const candidate of slopes) {
        const tolerance = Math.max(8, candidate * 0.12);
        const cluster = slopes.filter(v => Math.abs(v - candidate) <= tolerance);
        const clusterMedian = median(cluster) || candidate;
        const spread = cluster.reduce((sum, v) => sum + Math.abs(v - clusterMedian), 0);
        const score = cluster.length * 1000 - spread;
        if (!best || score > best.score) best = {candidate, cluster, score};
      }
      pitch = median(best.cluster);
      if (pitch && pitch > 10 && pitch < height * 0.5) {
        pitchSource = anchors.length >= 3 ? 'multi-anchor' : 'two-anchor';
        const consensusRatio = best.cluster.length / slopes.length;
        pitchConfidence = Math.min(100, Math.round(55 + consensusRatio * 40));
      } else {
        pitch = null;
      }
    }
  }

  let grid = null;
  let xAnchor = null;
  let medianGridResidual = null;
  if (pitch) {
    // Robust intercept: median(y - rowIndex*pitch). This makes the grid
    // independent of image resolution and UI scale.
    let intercept = median(anchors.map(a => a.y - a.index * pitch));
    let inliers = anchors.filter(a => Math.abs(a.y - (intercept + a.index * pitch)) <= Math.max(8, pitch * 0.25));

    // One bad OCR label must not invalidate an otherwise coherent grid.
    // Refit the intercept from inliers, then evaluate the residual again.
    if (inliers.length >= 2) {
      intercept = median(inliers.map(a => a.y - a.index * pitch));
      inliers = anchors.filter(a => Math.abs(a.y - (intercept + a.index * pitch)) <= Math.max(8, pitch * 0.25));
    }
    const anchorResiduals = inliers.map(a => Math.abs(a.y - (intercept + a.index * pitch)));
    const medianResidual = median(anchorResiduals) || 0;
    medianGridResidual = medianResidual;
    const tolerance = Math.max(8, pitch * 0.35);

    // Use a stable left-column X anchor instead of a fixed pixel coordinate.
    xAnchor = median((inliers.length ? inliers : anchors).map(a => a.x));
    const byKey = new Map(found.map(f => [f.key, f]));
    grid = orderedKeys.map(key => {
      const index = keyIndex.get(key);
      const expectedY = intercept + index * pitch;
      const actual = byKey.get(key);
      const actualY = actual ? Number(actual.label.y) : NaN;
      const useActual = Boolean(actual && Math.abs(actualY - expectedY) <= tolerance);
      return {
        key,
        index,
        y: useActual ? actualY : expectedY,
        label: useActual ? actual.label : null,
        confidence: useActual ? actual.label.confidence : 0,
        matchScore: useActual ? (actual.matchScore || 0) : 0,
        canonicalLabel: useActual ? (actual.canonicalLabel || actual.label.text) : null,
        nameAnchor: useActual ? (actual.nameAnchor || null) : null,
        inferred: !useActual
      };
    });

    // If fewer than two anchors survive the robust fit, do not pretend the
    // scale is reliable. Otherwise isolated OCR outliers are simply replaced
    // by the fitted grid position.
    if (inliers.length < 2 || medianResidual > pitch * 0.20) {
      grid = null;
      pitchSource = 'rejected';
      pitchConfidence = 0;
      xAnchor = null;
    }
  }

  const specs = grid || found.map(f => ({
    key: f.key,
    index: keyIndex.get(f.key),
    y: f.label.y,
    label: f.label,
    confidence: f.label.confidence,
    matchScore: f.matchScore || 0,
    canonicalLabel: f.canonicalLabel || f.label.text,
    inferred: false
  }));

  const columnX = Number.isFinite(xAnchor)
    ? Math.max(0, Math.min(width * 0.25 - 1, xAnchor))
    : Math.max(0, Math.min(width * 0.25 - 1, width * 0.05));

  const out = [];
  for (let i = 0; i < specs.length; i++) {
    const f = specs[i];
    const centerY = Number(f.y);
    const rowPitch = pitch || Math.max(40, Number(f.label?.height || 30) * 3.5);
    const half = Math.max(12, rowPitch * 0.48);
    const x1 = columnX;
    const x2 = Math.min(width, x1 + cardWidth);
    let y1 = Math.max(0, centerY - half);
    let y2 = Math.min(height, centerY + half);
    if (y2 <= y1) y2 = Math.min(height, y1 + Math.max(20, rowPitch * 0.8));

    out.push({
      key: f.key,
      x: x1,
      y: y1,
      width: x2 - x1,
      height: Math.max(1, y2 - y1),
      x1, y1, x2, y2,
      confidence: f.confidence,
      labelConfidence: f.inferred ? 0 : Math.round((f.matchScore || 0) * 100),
      label: f.label ? f.canonicalLabel || f.label.text : '構造推定',
      // Preserve the semantic label geometry so the OCR stage can crop the
      // actual equipment-name line instead of OCRing the whole card.
      anchorY: centerY,
      labelY: f.label ? Number(f.label.y) : centerY,
      labelHeight: f.label ? Math.max(1, Number(f.label.height) || 1) : Math.max(12, rowPitch * 0.28),
      labelX: f.label ? Number(f.label.x) : x1,
      labelWidth: f.label ? Math.max(1, Number(f.label.width) || 1) : Math.max(20, cardWidth * 0.5),
      nameAnchor: f.nameAnchor ? {
        x: Number(f.nameAnchor.x), y: Number(f.nameAnchor.y),
        width: Math.max(1, Number(f.nameAnchor.width) || 1),
        height: Math.max(1, Number(f.nameAnchor.height) || 1),
        confidence: Math.max(0, Math.min(100, Number(f.nameAnchor.confidence) || 0))
      } : null,
      sourceType: f.inferred ? 'inferred' : 'ocr',
      inferred: Boolean(f.inferred),
      excludedFromReflection: f.key === 'subWeapon' || f.key === 'mantle',
      pitch: pitch || null,
      pitchSource,
      pitchConfidence
    });
  }

  // Attach layout metadata without changing the existing array contract.
  out.layoutMeta = {
    anchorCount: anchors.length,
    pitch: pitch || null,
    pitchSource,
    pitchConfidence,
    scaledFromImage: Boolean(pitch),
    medianResidual: medianGridResidual
  };
  return out;
}


// Step 1.25-B v2.1: derive a single-line equipment-name crop from the semantic
// row anchor. The crop follows the inferred pitch and label geometry, so it
// scales with screenshots instead of using fixed pixel coordinates.
function equipmentNameCropRectV312(region, imageWidth, imageHeight) {
  if (!region) return null;
  const iw = Math.max(1, Number(imageWidth) || 1);
  const ih = Math.max(1, Number(imageHeight) || 1);
  const rx = Math.max(0, Number(region.x) || 0);
  const ry = Math.max(0, Number(region.y) || 0);
  const rw = Math.max(1, Number(region.width) || 1);
  const rh = Math.max(1, Number(region.height) || 1);
  const pitch = Math.max(20, Number(region.pitch) || rh / 0.96);
  const name = region.nameAnchor;
  const lineH = Math.max(10, Number(name?.height) || Number(region.labelHeight) || Math.min(34, pitch * 0.28));

  // v4.5.1: explicit name-band refinement takes priority. Do not shift the
  // detected band again. The previous path found the correct peak and then
  // moved the crop down by another ~0.4 line, which caused empty OCR on the
  // actual 3840x2160 equipment screenshot.
  if (region.refined && region.nameAnchor && Number.isFinite(Number(region.nameAnchor.y))) {
    const a=region.nameAnchor;
    const rect=clampRectToImage({
      x:Number(a.x), y:Number(a.y),
      width:Number(a.width), height:Number(a.height)
    },iw,ih);
    return {
      ...rect,
      pitch,
      source:'v4.5.1-refined-name-band',
      anchorRect:{x:Number(a.x),y:Number(a.y),width:Number(a.width),height:Number(a.height)},
      nameAnchor:{x:rect.x,y:rect.y,width:rect.width,height:rect.height}
    };
  }

  // v4.2.0: use the OCR rectangle produced by the generic icon grid directly.
  // The intended geometry is: the icon bottom-right is the OCR band's vertical
  // center; the band extends H/2 above and H/2 below that anchor.
  // Therefore: X = icon.right, Y = icon.bottom - H/2, W ≈ 7×iconW, H = iconH.
  // IMPORTANT: v4.0.8 still calculated the grid with this geometry, but the
  // downstream OCR crop helper silently reverted to the older 0.08H/0.76H crop.
  // This version removes that mismatch and makes the actual OCR input identical
  // to the rectangle shown in the anchor diagnostic overlay.
  if (region.sourceType === 'icon-anchor' && region.icon) {
    const icon = region.icon;
    const ix = Number(icon.x);
    const iy = Number(icon.y);
    const iw0 = Number(icon.w);
    const ih0 = Number(icon.h);
    if ([ix,iy,iw0,ih0].every(Number.isFinite) && iw0 > 0 && ih0 > 0) {
      const gridRect = region.ocr && [region.ocr.x,region.ocr.y,region.ocr.w,region.ocr.h].every(Number.isFinite)
        ? {x:Number(region.ocr.x), y:Number(region.ocr.y), width:Number(region.ocr.w), height:Number(region.ocr.h)}
        : {x:ix+iw0, y:iy+ih0*0.5, width:iw0*7, height:ih0};
      const rect = clampRectToImage(gridRect, iw, ih);
      return {
        ...rect,
        pitch,
        source:'v4.2.0-generic-icon-db-anchor',
        anchorRect:{x:ix,y:iy,width:iw0,height:ih0},
        nameAnchor:{x:rect.x,y:rect.y,width:rect.width,height:rect.height}
      };
    }
  }

  // v3.1.2: if the first layout OCR found the equipment-name line, use only
  // that line's geometry. OCR text is intentionally ignored here.
  if (name && Number(name.width) > 0 && Number.isFinite(Number(name.x)) && Number.isFinite(Number(name.y))) {
    const leftPad = Math.max(6, lineH * 0.30);
    const rightPad = Math.max(10, lineH * 1.00);
    const topPad = Math.max(3, lineH * 0.18);
    const bottomPad = Math.max(3, lineH * 0.18);
    const cardRight = Math.min(iw, rx + rw);
    const slotLeft = Number.isFinite(Number(region.slotX)) ? Number(region.slotX) : cardRight;
    const rightLimit = Math.max(Number(name.x) + Number(name.width), Math.min(cardRight, slotLeft));
    const x = Math.max(rx, Number(name.x) - leftPad);
    const desiredRight = Number(name.x) + Number(name.width) + rightPad;
    const right = Math.min(iw, rightLimit, desiredRight);
    const y = Math.max(0, Number(name.y) - topPad);
    const bottom = Math.min(ih, Number(name.y) + lineH + bottomPad);
    return {
      x, y,
      width: Math.max(1, right - x),
      height: Math.max(1, bottom - y),
      pitch, source: 'name-bbox',
      nameAnchor: {x:Number(name.x), y:Number(name.y), width:Number(name.width), height:lineH}
    };
  }

  // Fallback when the layout OCR did not produce a usable name bbox. Keep the
  // card geometry, but never resurrect the old 62% hard width limit.
  const labelY = Number.isFinite(Number(region.labelY)) ? Number(region.labelY) : (Number.isFinite(Number(region.anchorY)) ? Number(region.anchorY) : ry + rh * 0.48);
  const labelH = Math.max(10, Number(region.labelHeight) || Math.min(34, pitch * 0.28));
  const labelX = Number.isFinite(Number(region.labelX)) ? Number(region.labelX) : (rx + Math.min(18, rw * 0.04));
  const leftPad = Math.max(6, labelH * 0.30);
  const x = Math.max(rx, labelX - leftPad);
  const cardRight = Math.min(iw, rx + rw);
  const right = Math.min(cardRight, iw);
  const y = Math.max(0, labelY + labelH + Math.max(1, pitch * 0.01) - labelH * 0.18);
  const h = Math.max(14, Math.min(pitch * 0.44, labelH * 1.95, ih - y));
  return {x, y, width:Math.max(1, right-x), height:h, pitch, source:'card-fallback'};
}

// Keep the existing public helper name so all OCR callers use the v3.1.2
// geometry without requiring a second production path.
function equipmentNameCropRect(region, imageWidth, imageHeight) {
  return equipmentNameCropRectV312(region, imageWidth, imageHeight);
}

// v3.1.2 crop variants are retained only for visual regression comparison.
function buildEquipmentNameCropVariantsV311(region,imageWidth,imageHeight){
  const base=equipmentNameCropRectV312(region,imageWidth,imageHeight);
  if(!base)return [];
  const iw=Math.max(1,Number(imageWidth)||1), ih=Math.max(1,Number(imageHeight)||1);
  const rx=Number(region?.x)||0, rw=Math.max(1,Number(region?.width)||1);
  const rightEdge=Math.min(iw,rx+rw);
  const rightGuard=Math.max(6,Math.round(rw*.03));
  const wideWidth=Math.max(base.width,Math.round(rightEdge-base.x-rightGuard));
  const padX=Math.max(8,Math.round((Number(region?.nameAnchor?.height)||base.height)*.30));
  const padY=Math.max(8,Math.round((Number(region?.nameAnchor?.height)||base.height)*.20));
  const wide={x:base.x,y:base.y,width:wideWidth,height:base.height};
  const widePadding={x:base.x-padX,y:base.y-padY,width:wideWidth+padX*2,height:base.height+padY*2};
  const tallPadY=Math.max(padY,Math.round((Number(region?.nameAnchor?.height)||base.height)*.30));
  const widePaddingTall={x:base.x-padX,y:base.y-tallPadY,width:wideWidth+padX*2,height:base.height+tallPadY*2};
  return [
    {id:'current',label:'現在方式',rect:clampRectToImage(base,iw,ih)},
    {id:'wide',label:'広幅',rect:clampRectToImage(wide,iw,ih)},
    {id:'wide_padding',label:'広幅＋左右上下余白',rect:clampRectToImage(widePadding,iw,ih)},
    {id:'wide_padding_tall',label:'広幅＋余白多め',rect:clampRectToImage(widePaddingTall,iw,ih)}
  ];
}

// Step 1.25-B: normalize/filter DB rows by equipment slot. This is deliberately
// independent from OCR so slot mistakes can be tested without running Tesseract.
// v3.1.2: shared rectangle clamp for crop visual regression and production previews.
function clampRectToImage(rect,imageWidth,imageHeight){
  const iw=Math.max(1,Number(imageWidth)||1), ih=Math.max(1,Number(imageHeight)||1);
  let x=Math.round(Number(rect?.x)||0), y=Math.round(Number(rect?.y)||0);
  let width=Math.round(Number(rect?.width)||1), height=Math.round(Number(rect?.height)||1);
  x=Math.max(0,Math.min(iw-1,x)); y=Math.max(0,Math.min(ih-1,y));
  width=Math.max(1,Math.min(iw-x,width)); height=Math.max(1,Math.min(ih-y,height));
  return {x,y,width,height,source:rect?.source};
}

// v4.5.9: MHDB's armor `slots` field is the pre-limit-break value.
// The simulator's equipment model uses the max limit-break state for armor.
// Wilds limit-break slot expansion for the relevant RARE5/6 armor follows the
// documented pattern: existing slot levels +1, and a one-slot armor gains a
// second Lv1 slot. Keep the raw/base slots as well so the source of the
// effective value remains explicit and reversible.
function maxLimitBreakArmorSlotLevels(baseLevels, rarity) {
  const base=Array.isArray(baseLevels)?baseLevels.slice(0,3).map(Number).filter(n=>Number.isFinite(n)&&n>=1&&n<=3):[];
  const r=Number(rarity);
  if(!(r===5 || r===6)) return base;
  if(base.length===0) return [1,1];
  const upgraded=base.map(n=>Math.min(3,n+1));
  if(base.length===1) upgraded.push(1);
  return upgraded.slice(0,3);
}

function effectiveArmorSlotLevels(row) {
  if(!row) return [];
  const explicit=normalizeDecorationSlotLevels(row?.limitBreakSlotLevels ?? row?.maxLimitBreakSlots);
  if(explicit.length) return explicit;
  const base=normalizeDecorationSlotLevels(row?.slotLevels ?? row?.decorationSlots ?? row?.slots);
  return maxLimitBreakArmorSlotLevels(base,row?.rarity);
}

function normalizeEquipmentCandidateRows(rows, slot) {
  const allowed = {
    mainWeapon: 'weapon', head: 'head', chest: 'chest', arms: 'arms',
    waist: 'waist', legs: 'legs', charm: 'charm'
  };
  const want = allowed[slot];
  if (!want) return [];
  const seen = new Set();
  return (Array.isArray(rows) ? rows : []).map((r, i) => {
    const baseSlots=normalizeDecorationSlotLevels(r?.baseSlotLevels ?? r?.slotLevels ?? r?.decorationSlots ?? r?.slots);
    // Keep slotLevels as the DB/base value for compatibility with the established
    // equipment candidate matcher. Effective max-limit-break slots are exposed
    // separately through limitBreakSlotLevels and extractDecorationSlotLevels().
    const effectiveSlotLevels=(slot==='head'||slot==='chest'||slot==='arms'||slot==='waist'||slot==='legs')
      ? maxLimitBreakArmorSlotLevels(baseSlots,r?.rarity)
      : baseSlots.slice();
    return {
      id: r?.id ?? null,
      gameId: r?.gameId ?? null,
      kind: String(r?.kind || ''),
      name: String(r?.name || '').trim(),
      rankLevel: r?.rankLevel ?? null,
      rarity: r?.rarity ?? null,
      slots: r?.slots ?? null,
      decorationSlots: r?.decorationSlots ?? null,
      baseSlotLevels: baseSlots,
      limitBreakSlotLevels: (slot==='head'||slot==='chest'||slot==='arms'||slot==='waist'||slot==='legs') ? effectiveSlotLevels : [],
      slotLevels: baseSlots,
      sourceIndex: i
    };
  }).filter(r => r.name && r.kind === want).filter(r => {
    const key = `${r.kind}\u0000${r.id ?? ''}\u0000${r.gameId ?? ''}\u0000${r.name}\u0000${r.rankLevel ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}
function equipmentSlotLabel(key) {
  return ({mainWeapon:'メイン武器',head:'頭防具',chest:'胴防具',arms:'腕防具',waist:'腰防具',legs:'脚防具',charm:'護石',subWeapon:'サブ武器',mantle:'装衣'})[key] || key;
}

function addPadding(sourceCanvas, padX = 20, padY = 10) {
  const c = document.createElement('canvas');
  c.width = sourceCanvas.width + padX * 2;
  c.height = sourceCanvas.height + padY * 2;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(sourceCanvas, padX, padY);
  return c;
}

// Step 1.25-B v2.1: configurable padding preserves character edges at the
// OCR boundary. Dark-background modes keep a dark margin; inverted mode keeps
// the conventional white margin around black text.
function addPaddingCustom(sourceCanvas, padX = 30, padY = 20, color = '#FFFFFF') {
  const c = document.createElement('canvas');
  c.width = sourceCanvas.width + padX * 2;
  c.height = sourceCanvas.height + padY * 2;
  const ctx = c.getContext('2d');
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(sourceCanvas, padX, padY);
  return c;
}

function setVals(x,y,w,h){
  $("x").value=x.toFixed(2);$("y").value=y.toFixed(2);
  $("w").value=w.toFixed(2);$("h").value=h.toFixed(2);
  drawBox();updateCrop();
}
function vals(){
  return {
    x:Math.max(0,Math.min(100,Number($("x").value)||0)),
    y:Math.max(0,Math.min(100,Number($("y").value)||0)),
    w:Math.max(1,Math.min(100,Number($("w").value)||1)),
    h:Math.max(1,Math.min(100,Number($("h").value)||1))
  };
}
function drawBox(){
  const v=vals(), rect=$("img").getBoundingClientRect(), stage=$("stage").getBoundingClientRect();
  const sx=rect.width/imgW, sy=rect.height/imgH;
  const left=(v.x/100)*rect.width+(rect.left-stage.left);
  const top=(v.y/100)*rect.height+(rect.top-stage.top);
  const width=(v.w/100)*rect.width, height=(v.h/100)*rect.height;
  Object.assign($("box").style,{left:left+"px",top:top+"px",width:width+"px",height:height+"px"});
}
function updateCrop(){
  if(!$("img").src)return;
  const v=vals();
  const sx=Math.round(imgW*v.x/100), sy=Math.round(imgH*v.y/100);
  const sw=Math.max(1,Math.round(imgW*v.w/100)), sh=Math.max(1,Math.round(imgH*v.h/100));
  const c=$("crop"), ctx=c.getContext("2d");
  const scale=Math.min(2.5,1400/Math.max(sw,sh));
  c.width=Math.max(1,Math.round(sw*scale));c.height=Math.max(1,Math.round(sh*scale));
  ctx.drawImage($("img"),sx,sy,sw,sh,0,0,c.width,c.height);
}
function defaultRegion(){
  // First calibration range. It is intentionally adjustable in this Step.
  // The lower/sub weapon is excluded by keeping the vertical range shallow.
  setVals(0, 8, 30, 12);
}
$("file").onchange=()=>{
  const f=$("file").files[0]; if(!f)return;
  const url=URL.createObjectURL(f);
  $("img").onload=()=>{
    imgW=$("img").naturalWidth;imgH=$("img").naturalHeight;
    $("fileStatus").textContent=`読込完了：${imgW} × ${imgH}`;
    defaultRegion(); drawBox(); updateCrop();
    // 画像選択直後にDB取得を裏で開始し、OCR開始時の待ち時間を減らす。
    ensureWeaponDB().catch(()=>{});
  };
  $("img").src=url;
};
["x","y","w","h"].forEach(id=>$(id).addEventListener("input",()=>{drawBox();updateCrop()}));
window.addEventListener("resize",()=>{drawBox();updateCrop()});
$("default").onclick=defaultRegion;

function pointerPos(e){
  const r=$("stage").getBoundingClientRect();
  const ix=e.clientX-r.left, iy=e.clientY-r.top;
  const ir=$("img").getBoundingClientRect();
  return {x:(ix-(ir.left-r.left))/ir.width*100,y:(iy-(ir.top-r.top))/ir.height*100};
}
$("box").addEventListener("pointerdown",e=>{
  if(e.target.classList.contains("handle"))return;
  e.preventDefault(); $("box").setPointerCapture(e.pointerId);
  const v=vals(), p=pointerPos(e); drag={type:"move",sx:p.x,sy:p.y,v};
});
$("box").addEventListener("pointermove",e=>{
  if(!drag)return;
  const p=pointerPos(e),dx=p.x-drag.sx,dy=p.y-drag.sy,v=drag.v;
  setVals(
    Math.max(0,Math.min(100-v.w,v.x+dx)),
    Math.max(0,Math.min(100-v.h,v.y+dy)),
    v.w,v.h
  );
});
$("box").addEventListener("pointerup",()=>drag=null);
ocrRoot.querySelectorAll(".handle").forEach(handle=>{
  handle.addEventListener("pointerdown",e=>{
    e.preventDefault();e.stopPropagation();
    $("box").setPointerCapture(e.pointerId);
    const v=vals(),p=pointerPos(e);
    drag={type:handle.className,v,sx:p.x,sy:p.y};
  });
  handle.addEventListener("pointermove",e=>{
    if(!drag)return;
    const p=pointerPos(e),dx=p.x-drag.sx,dy=p.y-drag.sy,v=drag.v;
    let x=v.x,y=v.y,w=v.w,h=v.h;
    if(drag.type.includes("tr")){y+=dy;h-=dy;w+=dx}
    if(drag.type.includes("tl")){x+=dx;y+=dy;w-=dx;h-=dy}
    if(drag.type.includes("br")){w+=dx;h+=dy}
    if(drag.type.includes("bl")){x+=dx;w-=dx;h+=dy}
    if(w>=1&&h>=1)setVals(Math.max(0,Math.min(99,x)),Math.max(0,Math.min(99,y)),Math.min(100-x,w),Math.min(100-y,h));
  });
  handle.addEventListener("pointerup",()=>drag=null);
});

function sourceCropCanvas(){
  const v=vals();
  const sx=Math.round(imgW*v.x/100), sy=Math.round(imgH*v.y/100);
  const sw=Math.max(1,Math.round(imgW*v.w/100)), sh=Math.max(1,Math.round(imgH*v.h/100));
  const c=document.createElement("canvas"); c.width=sw; c.height=sh;
  const ctx=c.getContext("2d"); ctx.drawImage($("img"),sx,sy,sw,sh,0,0,sw,sh);
  return c;
}
function nameRegion(){
  const base=sourceCropCanvas();
  const x=Math.max(0,Math.min(99,Number($("nx").value)||0));
  const y=Math.max(0,Math.min(99,Number($("ny").value)||0));
  const w=Math.max(1,Math.min(100-x,Number($("nw").value)||1));
  const h=Math.max(1,Math.min(100-y,Number($("nh").value)||1));
  return {base,x,y,w,h};
}

function contrastStretchCanvas(canvas, low=55, high=215){
  const ctx=canvas.getContext('2d',{willReadFrequently:true});
  const img=ctx.getImageData(0,0,canvas.width,canvas.height);
  const d=img.data, span=Math.max(1,high-low);
  for(let i=0;i<d.length;i+=4){
    const y=.299*d[i]+.587*d[i+1]+.114*d[i+2];
    const v=Math.max(0,Math.min(255,Math.round((y-low)*255/span)));
    d[i]=d[i+1]=d[i+2]=v;
  }
  ctx.putImageData(img,0,0);
}
function addOCRPadding(canvas,pad=12){
  const c=document.createElement('canvas');
  c.width=canvas.width+pad*2; c.height=canvas.height+pad*2;
  const ctx=c.getContext('2d');
  ctx.fillStyle='#fff'; ctx.fillRect(0,0,c.width,c.height);
  ctx.drawImage(canvas,pad,pad);
  return c;
}
function buildOCRWhitelist(dict){
  const chars=new Set('・ーαβγΑΒΓ0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ');
  for(const name of dict||[]) for(const ch of Array.from(String(name))) chars.add(ch);
  // Keep Japanese kana generally available even when a diagnostic dictionary is small.
  for(const s of ['あいうえおかきくけこがぎぐげござしすせそざじずぜぞたちつてとだぢづでど',
                   'なにぬねのはひふへほばびぶべぼぱぴぷぺぽまみむめもやゆよ',
                   'らりるれろわをんぁぃぅぇぉゃゅょゔアイウエオカキクケコガギグゲゴ',
                   'サシスセソザジズゼゾタチツテトダヂヅデドナニヌネノハヒフヘホ',
                   'バビブベボパピプペポマミムメモヤユヨラリルレロワヲンァィゥェォヴ'])
    for(const ch of Array.from(s)) chars.add(ch);
  return [...chars].join('');
}

function buildEquipmentOCRWhitelist(){
  // Equipment names contain kanji that may not appear in the weapon dictionary.
  // Build the whitelist from the currently loaded equipment/charm master data,
  // while retaining the full Japanese kana set and alpha/beta/gamma.
  const names=[];
  for(const item of (Array.isArray(weaponDB)?weaponDB:[])) names.push(item?.name);
  for(const item of (Array.isArray(armorDB)?armorDB:[])) names.push(item?.name);
  for(const item of (Array.isArray(charmDB)?charmDB:[])) names.push(item?.name);
  return buildOCRWhitelist(names.filter(Boolean));
}

function makeNameOCRCanvas(mode,dx=0,dy=0,dw=0,dh=0){
  const q=nameRegion(),base=q.base;
  const x=Math.max(0,Math.min(99,q.x+dx)), y=Math.max(0,Math.min(99,q.y+dy));
  const w=Math.max(1,Math.min(100-x,q.w+dw)), h=Math.max(1,Math.min(100-y,q.h+dh));
  const sx=Math.round(base.width*x/100), sy=Math.round(base.height*y/100);
  const sw=Math.max(1,Math.round(base.width*w/100)), sh=Math.max(1,Math.round(base.height*h/100));
  const scale=4; let c=document.createElement("canvas"); c.width=sw*scale;c.height=sh*scale;
  const ctx=c.getContext("2d",{willReadFrequently:true}); ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality="high";
  ctx.drawImage(base,sx,sy,sw,sh,0,0,c.width,c.height);
  if(mode==="contrast155") contrastStretchCanvas(c,55,215);

  if(mode!=="color"){
    const d=ctx.getImageData(0,0,c.width,c.height);
    for(let i=0;i<d.data.length;i+=4){
      const gray=.299*d.data[i]+.587*d.data[i+1]+.114*d.data[i+2];
      let z=gray;
      if(mode==="contrast155") z=gray>155?255:0;if(mode==="threshold") z=gray>140?255:0;
      if(mode==="threshold155") z=gray>155?255:0;
      if(mode==="threshold125") z=gray>125?255:0;
      if(mode==="invert") z=gray>140?0:255;
      d.data[i]=d.data[i+1]=d.data[i+2]=z;
    }
    ctx.putImageData(d,0,0);
  }
  return addPadding(c, 20, 10);
}
function updateNameCrop(){
  if(!$('img').src)return;
  const c=makeNameOCRCanvas('color'); const out=$('nameCrop'),ctx=out.getContext('2d');
  out.width=c.width;out.height=c.height;ctx.drawImage(c,0,0);
}
['nx','ny','nw','nh'].forEach(id=>$(id).addEventListener('input',updateNameCrop));
const oldUpdateCrop=updateCrop; updateCrop=function(){oldUpdateCrop();updateNameCrop()};

// ---- 装備DB（Step 1.25-B） ----
// v4.5.7: equipment slot caches are versioned because an older cached row could
// contain only the first slot (for example [1] instead of [2,1]).
const ARMOR_API='https://wilds.mhdb.io/ja/armor';
const CHARM_API='https://wilds.mhdb.io/ja/charms';
const ARMOR_CACHE_KEY='DEV_MWWSKILLSIM_OCR_ARMOR_V4';
const CHARM_CACHE_KEY='DEV_MWWSKILLSIM_OCR_CHARMS_V2';
// β版互換：旧版で保存されたDBも候補として読む。新しい保存先は既存キーを維持する。
const LEGACY_ARMOR_CACHE_KEYS=['DEV_MWWSKILLSIM_OCR_ARMOR_V4','DEV_MWWSKILLSIM_OCR_ARMOR_V1'];
const LEGACY_CHARM_CACHE_KEYS=['DEV_MWWSKILLSIM_OCR_CHARMS_V2','DEV_MWWSKILLSIM_OCR_CHARMS_V1'];
const LEGACY_WEAPON_CACHE_KEYS=['DEV_MWWSKILLSIM_OCR_WEAPONS_V1'];
let armorDB=[], charmDB=[];
let armorReady=false, charmReady=false;
let armorPromise=null, charmPromise=null;
function setEquipmentDBStatus(text, cls=''){
  const el=$('equipmentDBStatus'); if(el) el.innerHTML=`装備DB：<span class="${cls}">${text}</span>`;
}
function normalizeArmorRows(rows){
  return normalizeEquipmentCandidateRows(rows.map(r=>({id:r?.id,gameId:r?.gameId,kind:String(r?.kind||''),name:r?.name,rarity:r?.rarity,slots:r?.slots,decorationSlots:r?.decorationSlots,slotLevels:r?.slotLevels,limitBreakSlotLevels:r?.limitBreakSlotLevels})), 'head')
    .concat(normalizeEquipmentCandidateRows(rows,'chest'),normalizeEquipmentCandidateRows(rows,'arms'),normalizeEquipmentCandidateRows(rows,'waist'),normalizeEquipmentCandidateRows(rows,'legs'));
}
async function fetchEquipmentPage(api, offset){
  const projection={id:true,gameId:true,kind:true,name:true,rarity:true,slots:true,decorationSlots:true,slotLevels:true,limitBreakSlotLevels:true};
  const u=`${api}?limit=250&offset=${offset}&p=${encodeURIComponent(JSON.stringify(projection))}`;
  const r=await fetch(u,{cache:'no-store',mode:'cors'}); if(!r.ok) throw new Error(`装備DB HTTP ${r.status}`);
  const data=await r.json(); if(!Array.isArray(data)) throw new Error('装備DBの応答が配列ではありません'); return data;
}
async function fetchCharmPage(offset){
  // Charm names live on ranks, not on the top-level Charm object. Keep ranks
  // in this projection or OCR candidate construction would silently get zero rows.
  const projection={id:true,gameId:true,ranks:true};
  const u=`${CHARM_API}?limit=250&offset=${offset}&p=${encodeURIComponent(JSON.stringify(projection))}`;
  const r=await fetch(u,{cache:'no-store',mode:'cors'}); if(!r.ok) throw new Error(`護石DB HTTP ${r.status}`);
  const data=await r.json(); if(!Array.isArray(data)) throw new Error('護石DBの応答が配列ではありません'); return data;
}
function readRowsFromCacheKeys(keys, normalizer){
  for(const key of keys){
    try{
      const raw=JSON.parse(localStorage.getItem(key)||'null');
      const rows=normalizer(raw?.rows||raw);
      if(Array.isArray(rows)&&rows.length)return rows;
    }catch(e){}
  }
  return [];
}

async function loadArmorDB(force=false){
  if(armorReady&&!force)return armorDB;
  if(armorPromise&&!force)return armorPromise;
  armorPromise=(async()=>{
    const cachedRows=readRowsFromCacheKeys(LEGACY_ARMOR_CACHE_KEYS, normalizeArmorRows);
    if(!force && cachedRows.length){armorDB=cachedRows;armorReady=true;setEquipmentDBStatus(`${armorDB.length.toLocaleString()}件（保存済みDB）`,'ok');return armorDB;}
    try{
      const all=[];let offset=0;
      for(let page=0;page<100;page++){
        const part=await fetchEquipmentPage(ARMOR_API,offset);all.push(...part);
        if(part.length<250)break;offset+=250;
      }
      const rows=normalizeArmorRows(all);
      if(!rows.length)throw new Error('防具DBが0件でした');
      armorDB=rows;armorReady=true;
      try{localStorage.setItem(ARMOR_CACHE_KEY,JSON.stringify({savedAt:new Date().toISOString(),rows:armorDB}));}catch(e){}
      return armorDB;
    }catch(e){
      if(cachedRows.length){armorDB=cachedRows;armorReady=true;setEquipmentDBStatus(`${armorDB.length.toLocaleString()}件（保存済みDBを使用）`,'warn');return armorDB;}
      throw e;
    }
  })();
  try{return await armorPromise}catch(e){armorPromise=null;armorReady=false;throw e}finally{armorPromise=null}
}
async function loadCharmDB(force=false){
  if(charmReady&&!force)return charmDB;
  if(charmPromise&&!force)return charmPromise;
  charmPromise=(async()=>{
    let cachedRows=readRowsFromCacheKeys(LEGACY_CHARM_CACHE_KEYS, x=>Array.isArray(x)?x:(x?.rows||[]));
    if(!force && cachedRows.length){charmDB=cachedRows;charmReady=true;setEquipmentDBStatus(`${charmDB.length.toLocaleString()}件（保存済みDB）`,'ok');return charmDB;}
    try{
      const all=[];let offset=0;
      for(let page=0;page<100;page++){
        const part=await fetchCharmPage(offset);all.push(...part);
        if(part.length<250)break;offset+=250;
      }
      const rows=[];const seen=new Set();
      for(const c of all){for(const rank of Array.isArray(c?.ranks)?c.ranks:[]){
        const name=String(rank?.name||'').trim();if(!name)continue;
        const row={id:c?.id??null,gameId:c?.gameId??null,kind:'charm',name,rankLevel:rank?.level??null,slots:rank?.slots??c?.slots??null,decorationSlots:rank?.decorationSlots??c?.decorationSlots??null,slotLevels:normalizeDecorationSlotLevels(rank?.slotLevels??rank?.decorationSlots??rank?.slots??c?.slotLevels??c?.decorationSlots??c?.slots)};
        const key=`${row.id}\u0000${row.rankLevel}\u0000${row.name}`;if(seen.has(key))continue;seen.add(key);rows.push(row);
      }}
      if(!rows.length)throw new Error('護石DBが0件でした');
      charmDB=rows;charmReady=true;
      try{localStorage.setItem(CHARM_CACHE_KEY,JSON.stringify({savedAt:new Date().toISOString(),rows:charmDB}));}catch(e){}
      return charmDB;
    }catch(e){
      if(cachedRows.length){charmDB=cachedRows;charmReady=true;setEquipmentDBStatus(`${charmDB.length.toLocaleString()}件（保存済みDBを使用）`,'warn');return charmDB;}
      throw e;
    }
  })();
  try{return await charmPromise}catch(e){charmPromise=null;charmReady=false;throw e}finally{charmPromise=null}
}
function equipmentRowsForSlot(slot){
  if(slot==='mainWeapon')return weaponDB;
  if(slot==='charm')return charmDB;
  return armorDB.filter(r=>r.kind===({head:'head',chest:'chest',arms:'arms',waist:'waist',legs:'legs'})[slot]);
}
// ---- 全武器DB / 候補照合 ----
const WEAPON_API='https://wilds.mhdb.io/ja/weapons';
const WEAPON_CACHE_KEY='DEV_MWWSKILLSIM_OCR_WEAPONS_V1';
let weaponDB=[];
let weaponDBReady=false;
let weaponGramIndex=new Map();
let weaponDBPromise=null;

function setDBStatus(text, cls=''){
  const el=$('dbStatus');
  if(el) el.innerHTML=`武器DB：<span class="${cls}">${text}</span>`;
}
function normalizeWeaponRows(rows){
  const seen=new Set();
  return (Array.isArray(rows)?rows:[]).map(w=>({
    id:w?.id ?? null,
    gameId:w?.gameId ?? null,
    kind:String(w?.kind||''),
    name:String(w?.name||'').trim(),
    slots:w?.slots ?? null,
    decorationSlots:w?.decorationSlots ?? null,
    slotLevels:w?.slotLevels ?? null
  })).filter(w=>w.name).filter(w=>{
    const key=`${w.kind}\u0000${w.gameId??''}\u0000${w.id??''}\u0000${w.name}`;
    if(seen.has(key))return false;seen.add(key);return true;
  });
}
function rebuildWeaponGramIndex(){
  weaponGramIndex=new Map();
  weaponDB.forEach((item,idx)=>{
    const n=normJPLoose(item.name); const seen=new Set();
    for(let i=0;i<n.length-1;i++){
      const g=n.slice(i,i+2); if(seen.has(g))continue; seen.add(g);
      if(!weaponGramIndex.has(g))weaponGramIndex.set(g,new Set());
      weaponGramIndex.get(g).add(idx);
    }
  });
}
function searchWeaponItems(raw){
  if(!weaponDB.length)return [];
  const n=normJPLoose(raw); const counts=new Map();
  for(let i=0;i<n.length-1;i++){
    const g=n.slice(i,i+2); const set=weaponGramIndex.get(g); if(!set)continue;
    for(const idx of set)counts.set(idx,(counts.get(idx)||0)+1);
  }
  if(!counts.size)return weaponDB;
  // Keep a generous fallback pool so a single OCR error does not eliminate the correct weapon.
  const ranked=[...counts.entries()].sort((a,b)=>b[1]-a[1]).slice(0,80).map(x=>weaponDB[x[0]]);
  return ranked.length?ranked:weaponDB;
}
async function fetchWeaponPage(offset){
  const projection={id:true,gameId:true,kind:true,name:true,slots:true,decorationSlots:true,slotLevels:true};
  const u=`${WEAPON_API}?limit=250&offset=${offset}&p=${encodeURIComponent(JSON.stringify(projection))}`;
  const r=await fetch(u,{cache:'no-store',mode:'cors'});
  if(!r.ok)throw new Error(`武器DB HTTP ${r.status}`);
  const data=await r.json();
  if(!Array.isArray(data))throw new Error('武器DBの応答が配列ではありません');
  return data;
}
async function loadWeaponDB(force=false){
  if(weaponDBReady&&!force)return weaponDB;
  if(weaponDBPromise&&!force)return weaponDBPromise;
  weaponDBPromise=(async()=>{
    const cachedRows=readRowsFromCacheKeys(LEGACY_WEAPON_CACHE_KEYS, normalizeWeaponRows);
    if(!force && cachedRows.length){weaponDB=cachedRows;rebuildWeaponGramIndex();weaponDBReady=true;setDBStatus(`${weaponDB.length.toLocaleString()}件（保存済みDB）`,'ok');return weaponDB;}
    try{
      setDBStatus('全件取得中…','info');
      const all=[];let offset=0;
      for(let page=0;page<100;page++){
        const part=await fetchWeaponPage(offset);all.push(...part);setDBStatus(`全件取得中… ${all.length.toLocaleString()}件`,'info');
        if(part.length<250)break;offset+=250;
      }
      const rows=normalizeWeaponRows(all);if(!rows.length)throw new Error('武器DBが0件でした');
      weaponDB=rows;rebuildWeaponGramIndex();weaponDBReady=true;
      try{localStorage.setItem(WEAPON_CACHE_KEY,JSON.stringify({savedAt:new Date().toISOString(),rows}));}catch(e){}
      setDBStatus(`${weaponDB.length.toLocaleString()}件（最新取得）`,'ok');return weaponDB;
    }catch(e){
      if(cachedRows.length){weaponDB=cachedRows;rebuildWeaponGramIndex();weaponDBReady=true;setDBStatus(`${weaponDB.length.toLocaleString()}件（保存済みDBを使用）`,'warn');return weaponDB;}
      setDBStatus('取得失敗：'+e.message,'bad');throw e;
    }
  })();
  try{return await weaponDBPromise}catch(e){weaponDBPromise=null;weaponDBReady=false;throw e}finally{weaponDBPromise=null}
}
async function ensureWeaponDB(){
  if(weaponDBReady&&weaponDB.length)return weaponDB;
  return loadWeaponDB(false);
}
$('loadDB').onclick=async()=>{
  $('loadDB').disabled=true;
  try{await loadWeaponDB(true)}catch(e){}
  finally{$('loadDB').disabled=false}
};
$('clearDB').onclick=()=>{
  try{localStorage.removeItem(WEAPON_CACHE_KEY)}catch(e){}
  weaponDB=[];weaponDBReady=false;weaponDBPromise=null;weaponGramIndex=new Map();setDBStatus('未取得');
};

function normJPStrict(v){
  return String(v||'').normalize('NFKC').toLowerCase()
    .replace(/[\s\u3000]+/g,'')
    .replace(/[”“’'`「」『』（）()\[\]【】,，.。:：;；_|｜~～—–]+/g,'');
}
function normJPLoose(v){
  return normJPStrict(v).replace(/[・･·•ー\-]/g,'');
}
function lev(a,b){
  const aa=Array.from(a),bb=Array.from(b),prev=Array(bb.length+1);
  for(let j=0;j<=bb.length;j++)prev[j]=j;
  for(let i=1;i<=aa.length;i++){
    const cur=[i];
    for(let j=1;j<=bb.length;j++)cur[j]=Math.min(prev[j]+1,cur[j-1]+1,prev[j-1]+(aa[i-1]===bb[j-1]?0:1));
    for(let j=0;j<cur.length;j++)prev[j]=cur[j];
  }
  return prev[bb.length];
}
function lcsLen(a,b){
  const aa=Array.from(a),bb=Array.from(b);let p=new Array(bb.length+1).fill(0);
  for(const ch of aa){let c=new Array(bb.length+1).fill(0);for(let j=1;j<=bb.length;j++)c[j]=ch===bb[j-1]?p[j-1]+1:Math.max(p[j],c[j-1]);p=c}
  return p[bb.length]
}
function dice(a,b){
  if(a===b)return 1;if(a.length<2||b.length<2)return 0;
  const m=new Map();for(let i=0;i<a.length-1;i++){const g=a.slice(i,i+2);m.set(g,(m.get(g)||0)+1)}
  let hit=0;for(let i=0;i<b.length-1;i++){const g=b.slice(i,i+2),n=m.get(g)||0;if(n>0){hit++;m.set(g,n-1)}}
  return 2*hit/(a.length+b.length-2)
}
function commonSubstringLen(a,b){
  const aa=Array.from(a),bb=Array.from(b);let prev=new Array(bb.length+1).fill(0),best=0;
  for(let i=1;i<=aa.length;i++){const cur=new Array(bb.length+1).fill(0);for(let j=1;j<=bb.length;j++){if(aa[i-1]===bb[j-1]){cur[j]=prev[j-1]+1;if(cur[j]>best)best=cur[j]}}prev=cur}
  return best;
}
function fuzzySubstringScore(a,b){
  if(!a||!b)return {score:0,matched:0};
  const aa=Array.from(a),bb=Array.from(b);
  if(aa.length<4||bb.length<4)return {score:0,matched:0};
  const short=aa.length<=bb.length?aa:bb, long=aa.length<=bb.length?bb:aa;
  let best=0,bestLen=0;
  const target=short.length;
  const minLen=Math.max(3,target-2),maxLen=Math.min(long.length,target+2);
  for(let len=minLen;len<=maxLen;len++){
    for(let i=0;i+len<=long.length;i++){
      const win=long.slice(i,i+len).join('');
      const s=1-lev(short.join(''),win)/Math.max(short.length,win.length);
      if(s>best){best=s;bestLen=len}
    }
  }
  return {score:best,matched:bestLen};
}
function kanaSmallBase(ch){
  const map={ァ:'ア',ィ:'イ',ゥ:'ウ',ェ:'エ',ォ:'オ',ッ:'ツ',ャ:'ヤ',ュ:'ユ',ョ:'ヨ',ヮ:'ワ',ｧ:'ア',ｨ:'イ',ｩ:'ウ',ｪ:'エ',ｫ:'オ',ｯ:'ツ',ｬ:'ヤ',ｭ:'ユ',ｮ:'ヨ'};
  return map[ch]||ch;
}
function stripDakuten(ch){
  return String(ch||'').normalize('NFD').replace(/[\u3099\u309A]/g,'').normalize('NFC');
}
function charMismatchWeight(a,b){
  if(a===b)return 0;
  if(a.toLowerCase()===b.toLowerCase())return .25;
  if(kanaSmallBase(a)===kanaSmallBase(b))return .25;
  if(stripDakuten(a)===stripDakuten(b))return .50;
  return 1;
}
function normalizeForNameScore(v){
  return Array.from(String(v||'').normalize('NFKC')).filter(ch=>!/[\s\u3000・･·•\-‐‑‒–—―＿_.,，。！？!?、:：;；/／\\|｜()[\]{}「」『』【】〈〉《》<>＋+＝=＊*#＃%％&＆@＠]/.test(ch));
}
function normalizeSubtypeSymbols(raw){
  let s=String(raw||'').normalize('NFKC').replace(/[\r\n]+/g,' ').replace(/[|｜]/g,' ').replace(/\s+/g,' ').trim();
  // Strip only terminal OCR noise before interpreting the subtype token. This keeps
  // ordinary name characters intact while handling tails such as "v 一", "aq 一"
  // and "BQ 央" seen in real equipment screenshots.
  s=s.replace(/[\s一ー―＿_.]+$/u,'').trim();
  s=s.replace(/\s*(?:v|V|ν|𝛾|γ)(?:\s*[一ー―昌央1-9]*)$/u,'γ');
  // Check beta before alpha because the alpha "q" alias would otherwise turn BQ/bq into Bα.
  s=s.replace(/\s*(?:80q|bq|b|B|6|8|𝛽|β)(?:\s*[一ー―昌央1-9]*)$/iu,'β');
  s=s.replace(/\s*(?:aq|nq|a|A|q|𝛂|α)(?:\s*[一ー―1-9]*)$/iu,'α');
  return s;
}
function splitEquipmentSubtype(raw){
  const s=normalizeSubtypeSymbols(raw);
  const m=s.match(/^(.*?)[\s]*([αβγ])$/u);
  return m?{base:m[1].trim(),subtype:m[2]}:{base:s.trim(),subtype:null};
}
function equipmentSubtypeScore(raw,item){
  const r=splitEquipmentSubtype(raw), d=splitEquipmentSubtype(item);
  if(!d.subtype)return 0;
  if(r.subtype&&r.subtype===d.subtype)return 1;
  if(r.subtype&&r.subtype!==d.subtype)return 0;
  return 0.5;
}
function weightedNameDistance(raw,item){
  const normalizedRaw=normalizeSubtypeSymbols(raw);
  const a=normalizeForNameScore(normalizedRaw),b=normalizeForNameScore(item);
  if(!b.length)return {score:0,cost:1,matched:0,basePoints:0,details:{normal:0,light:0,dakuten:0,missing:0,extra:0}};
  const n=b.length,unit=100/n;
  const prev=new Array(a.length+1).fill(0);
  const prevD=Array.from({length:a.length+1},()=>({normal:0,light:0,dakuten:0,missing:0,extra:0}));
  for(let j=1;j<=a.length;j++){prev[j]=j;prevD[j]={normal:0,light:0,dakuten:0,missing:0,extra:j};}
  let rows=prev,detail=prevD;
  for(let i=1;i<=b.length;i++){
    const cur=new Array(a.length+1).fill(0),curD=Array.from({length:a.length+1},()=>({normal:0,light:0,dakuten:0,missing:0,extra:0}));
    cur[0]=i;curD[0]={normal:0,light:0,dakuten:0,missing:i,extra:0};
    for(let j=1;j<=a.length;j++){
      const w=charMismatchWeight(b[i-1],a[j-1]);
      const type=w===0?'match':w===.25?'light':w===.5?'dakuten':'normal';
      const sub=rows[j-1]+w, del=rows[j]+1, ins=cur[j-1]+1;
      let best=sub,base=detail[j-1],op=type;
      if(del<best){best=del;base=detail[j];op='missing';}
      if(ins<best){best=ins;base=curD[j-1];op='extra';}
      const d={...base};
      if(op==='light')d.light++; else if(op==='dakuten')d.dakuten++; else if(op==='normal')d.normal++; else if(op==='missing')d.missing++; else if(op==='extra')d.extra++;
      cur[j]=best;curD[j]=d;
    }
    rows=cur;detail=curD;
  }
  const cost=rows[a.length],d=detail[a.length];
  // The denominator is the DB name length. Extra non-space OCR characters are
  // penalized, while spaces/separators were removed before alignment and cost 0.
  let score=Math.max(0,1-(cost/n));
  const subtype=equipmentSubtypeScore(normalizedRaw,item);
  // Alpha/beta/gamma are different database items. A clearly read subtype must
  // therefore outweigh a one-character edit-distance advantage.
  if(subtype===1) score=Math.min(1,score+0.15);
  else if(subtype===0) score=Math.max(0,score-0.35);
  const matched=Math.max(0,n-d.normal-d.light-d.dakuten-d.missing);
  return {score,cost,matched,basePoints:unit,details:d,subtype};
}
function getDictionary(){return weaponDB.map(w=>w.name)}
function getWeaponItems(raw){return searchWeaponItems(raw)}
function confidenceWeight(conf){if(conf>=85)return 1;if(conf>=75)return .90;if(conf>=65)return .78;if(conf>=50)return .62;if(conf>=35)return .45;return .30}
function dynamicMarginRequired(name){const n=normalizeForNameScore(name).length;if(n<=4)return .16;if(n<=7)return .12;if(n<=11)return .09;return .07}
function candidateHasEnoughEvidence(c){return !!c && c.score>=.45}
// Step 1.24: DB候補の総合スコア。OCR↔OCR一致率は最終判定に使わない。
// 支持補正は文字評価とは独立した加点要素として扱う。
function supportBonus(supportOrRatio,total){
  const t=Number(total||0);
  const r=t>0 ? Number(supportOrRatio||0)/t : Number(supportOrRatio||0);
  const s=t>0 ? Number(supportOrRatio||0) : Math.round(r*3);
  if(t<=0 || s<=0)return 0;
  if(s===1 && t===1)return .04;
  if(s===2 && t===2)return .08;
  if(s===2 && t===3)return .06;
  if(s>=3 && s===t)return .12;
  if(s>=5 && t===6)return .10;
  if(r>=.666)return .06;
  return 0;
}
function finalCandidateScore(x){
  const charScore=.70*Number(x.avgNameScore||0)+.15*Number(x.bestNameScore||0);
  const ocrConfidence=.15*(Number(x.confAvg||0)/100);
  const support= supportBonus(x.support,x.total||0);
  const totalScore=Math.min(1,charScore+ocrConfidence+support);
  return {charScore,ocrConfidence,supportBonus:support,totalScore};
}
function totalCandidateScore(x){
  const r=finalCandidateScore(x);
  return typeof r==='number'?r:r.totalScore;
}
// Step 1.24: aggregate only OCR passes that ranked this DB candidate #1.
// This keeps averages consistent with the support count and prevents a candidate
// that merely appeared in another pass's top-3 from contaminating its evidence.
function summarizeCandidateEvidence(x){
  const rows=Array.isArray(x?.topRows)?x.topRows:[];
  const supporting=rows.filter(r=>Number(r?.rank)===0);
  const source=supporting.length?supporting:[];
  const avgNameScore=source.length?source.reduce((s,r)=>s+Number(r.nameScore||0),0)/source.length:0;
  const avgRowScore=source.length?source.reduce((s,r)=>s+Number(r.score||0),0)/source.length:0;
  const confAvg=source.length?source.reduce((s,r)=>s+Number(r.conf||0),0)/source.length:0;
  const bestNameScore=source.length?Math.max(...source.map(r=>Number(r.nameScore||0))):0;
  const score=finalCandidateScore({...x,avgNameScore,avgRowScore,confAvg,bestNameScore});
  return {avgNameScore,avgRowScore,confAvg,bestNameScore,supportBonus:score.supportBonus,charScore:score.charScore,ocrConfidence:score.ocrConfidence,totalScore:score.totalScore};
}
function candidateDecision(x,secondFinal=null){
  if(!x)return {level:'manual',label:'手動入力',reason:'DB候補を形成できませんでした。'};
  const hasSecond=Number.isFinite(Number(secondFinal));
  const currentFinal=Number.isFinite(Number(x.totalScore))?Number(x.totalScore):totalCandidateScore(x);
  const margin=hasSecond?currentFinal-Number(secondFinal):null, support=Number(x.supportRatio||0);
  const conf=Number(x.confAvg||0);
  const marginOK=!hasSecond || margin>=.05;
  // 高い支持補正だけでは自動確定させず、OCR信頼度50%以上も要求する。
  if(currentFinal>=.72 && marginOK && x.avgNameScore>=.50 && conf>=50)
    return {level:'auto',label:'自動確定候補',reason:'DB統合スコア、支持補正、OCR信頼度、候補差が基準を満たしました。'};
  if(currentFinal>=.60 && marginOK)
    return {level:'confirm',label:'ユーザー確認',reason:'有力候補ですが、自動確定条件を満たしていません。'};
  if(currentFinal>=.45)
    return {level:'ambiguous',label:'候補選択',reason:'候補差が小さいため、上位候補から選択してください。'};
  return {level:'manual',label:'手動入力',reason:'DB候補の確度が不足しています。'};
}
function renderCandidates(cands,meta){
  const out=$("candidateOut");
  if(!cands.length){out.innerHTML='<div class="notice">該当する武器候補を確認できませんでした。上位候補を十分に形成できませんでした。</div>';return}
  const topFinal=Number(cands[0].totalScore??cands[0].final??0);
  const topSecondFinal=cands[1]?Number(cands[1].totalScore??cands[1].final??0):null;
  const topMargin=topSecondFinal==null?null:topFinal-topSecondFinal;
  out.innerHTML=cands.slice(0,5).map((c,i)=>{
    const pct=Math.round((c.totalScore??c.final)*100),cls=pct>=80?'background:#eef2e8':pct>=65?'background:#f6f1df':'background:#f5e8e4';
    const d=i===0 ? (c.decision||candidateDecision(c,topSecondFinal)) : (c.decision||candidateDecision(c,null));
    const marginText=i===0 ? (topMargin==null?'1位差 —（2位候補なし）':`1位差 ${Math.round(topMargin*100)}pt`) : '1位差 —';
    return `<div style="${cls};border:1px solid #c8baa0;border-radius:9px;padding:9px;margin-top:7px"><b>${i+1}位　${c.name}</b> <span class="corrected-tag">${d.label}</span><br><span class="note">最終 ${pct}%　／　支持 ${c.support}/${meta.total}回　／　平均文字評価 ${Math.round(c.avgNameScore*100)}%　／　OCR信頼度平均 ${Math.round(c.confAvg)}%　／　支持補正 +${Math.round((c.supportBonus||0)*100)}pt　／　${marginText}</span></div>`;
  }).join('')+`<div class="note" style="margin-top:8px">${meta.decision}</div>`;
}
function cleanOCR(raw){return String(raw||'').replace(/[\r\n]+/g,' ').replace(/[|｜]/g,' ').replace(/\s+/g,' ').trim()}
async function detectLayoutFromImage(){
  if(!$('img').src){$('layoutStatus').textContent='先に画像を選択してください。';return;}
  const btn=$('detectLayout'); btn.disabled=true;
  const started=performance.now();
  let worker=null;
  try{
    $('layoutStatus').textContent='画面全体をOCR中…';
    worker=await Tesseract.createWorker('jpn');
    await worker.setParameters({tessedit_pageseg_mode:'11',preserve_interword_spaces:'1'});
    const r=await worker.recognize($('img'));
    const lines=extractEquipmentOCRLines(r?.data||{});
    const regions=detectEquipmentRegions({width:imgW,height:imgH},lines);
    const found=new Set(regions.map(x=>x.key));
    const labels={mainWeapon:'メイン武器',subWeapon:'サブ武器',head:'頭防具',chest:'胴防具',arms:'腕防具',waist:'腰防具',legs:'脚防具',charm:'護石',mantle:'装衣'};
    const missing=Object.keys(labels).filter(k=>!found.has(k));
    const lm=regions.layoutMeta||{};
    const scaleNote=lm.pitch ? `装備ピッチ自動推定：${Math.round(lm.pitch)}px／アンカー${lm.anchorCount}個／${lm.pitchSource}` : '装備ピッチ：推定できず（検出ラベルのみ使用）';
    $('layoutOut').innerHTML=`<div class="note" style="margin-top:6px">${scaleNote}</div>` + regions.map(r=>{
      const pct=Math.round(r.confidence);
      const matchPct=Math.round(r.labelConfidence||0);
      const confidenceText=r.inferred?'構造推定':`OCR信頼度 ${pct}%／ラベル一致 ${matchPct}%`;
      const subNote=r.key==='mainWeapon'?' <span class="corrected-tag">認識対象</span>':(r.excludedFromReflection?' <span class="corrected-tag">反映対象外</span>':'');
      return `<div style="border:1px solid #c8baa0;border-radius:9px;padding:8px;margin-top:6px"><b>${labels[r.key]||r.key}</b>${subNote}<br><span class="note">検出ラベル「${r.label}」／${confidenceText}／領域 x:${Math.round(r.x1)}, y:${Math.round(r.y1)}, 幅:${Math.round(r.width)}, 高さ:${Math.round(r.height)}</span></div>`;
    }).join('') + (missing.length?`<div class="note" style="margin-top:8px">未検出：${missing.map(k=>labels[k]).join('、')}。この段階では手動入力は行いません。</div>`:'<div class="note" style="margin-top:8px">必要な主要領域を検出しました。サブ武器・装衣は構造検出のみ行い、シミュレーターへの反映対象から除外します。</div>');
    $('layoutStatus').textContent=`自動検出完了：${regions.length}領域 / ${lines.length} OCR行 / ${(performance.now()-started)/1000|0}秒`;
    window.lastEquipmentRegions=regions;
  }catch(err){
    $('layoutStatus').textContent='構造検出エラー：'+String(err);
  }finally{
    if(worker)await worker.terminate();
    btn.disabled=false;
  }
}
$('detectLayout').onclick=detectLayoutFromImage;


function otsuThreshold(ctx,width,height){
  const img=ctx.getImageData(0,0,width,height), d=img.data;
  const histogram=new Array(256).fill(0);
  for(let i=0;i<d.length;i+=4){
    const g=Math.round(.299*d[i]+.587*d[i+1]+.114*d[i+2]); histogram[g]++;
  }
  const total=Math.max(1,width*height); let sum=0;
  for(let t=0;t<256;t++)sum+=t*histogram[t];
  let sumB=0,wB=0,bestVar=-1,threshold=128;
  for(let t=0;t<256;t++){
    wB+=histogram[t]; if(!wB)continue;
    const wF=total-wB; if(!wF)break;
    sumB+=t*histogram[t];
    const mB=sumB/wB,mF=(sum-sumB)/wF;
    const between=wB*wF*(mB-mF)*(mB-mF);
    if(between>bestVar){bestVar=between;threshold=t;}
  }
  for(let i=0;i<d.length;i+=4){
    const g=.299*d[i]+.587*d[i+1]+.114*d[i+2], z=g>threshold?255:0;
    d[i]=d[i+1]=d[i+2]=z;
  }
  ctx.putImageData(img,0,0); return threshold;
}

function whiteTextHSV(ctx,w,h){
  const img=ctx.getImageData(0,0,w,h), d=img.data;
  let sum=0; const vals=[];
  for(let i=0;i<d.length;i+=4){
    const r=d[i],g=d[i+1],b=d[i+2];
    const mx=Math.max(r,g,b), mn=Math.min(r,g,b);
    sum+=mx; vals.push(mx);
  }
  vals.sort((a,b)=>a-b);
  const p85=vals[Math.min(vals.length-1,Math.floor(vals.length*.85))]||160;
  const vCut=Math.max(135,Math.min(190,p85));
  const sCut=72;
  for(let i=0;i<d.length;i+=4){
    const r=d[i],g=d[i+1],b=d[i+2];
    const mx=Math.max(r,g,b), mn=Math.min(r,g,b);
    const sat=mx===0?0:Math.round(((mx-mn)/mx)*255);
    const keep=mx>=vCut && sat<=sCut;
    const z=keep?255:0;
    d[i]=d[i+1]=d[i+2]=z;
  }
  ctx.putImageData(img,0,0);
}


// Spike-only soft white extraction. Unlike hard thresholding, this keeps a
// continuous luminance mask so anti-aliased glyph edges are not discarded.
function softWhiteText(ctx,w,h){
  const img=ctx.getImageData(0,0,w,h),d=img.data;
  const values=[];
  for(let i=0;i<d.length;i+=4){
    const r=d[i],g=d[i+1],b=d[i+2],mx=Math.max(r,g,b),mn=Math.min(r,g,b);
    const sat=mx===0?0:((mx-mn)/mx)*255;
    values.push(mx);
  }
  values.sort((a,b)=>a-b);
  const p75=values[Math.min(values.length-1,Math.floor(values.length*.75))]||160;
  const v0=Math.max(100,Math.min(175,p75-20));
  const smooth=(x,a,b)=>{if(b<=a)return x>=b?1:0;const t=Math.max(0,Math.min(1,(x-a)/(b-a)));return t*t*(3-2*t)};
  for(let i=0;i<d.length;i+=4){
    const r=d[i],g=d[i+1],b=d[i+2],mx=Math.max(r,g,b),mn=Math.min(r,g,b);
    const gray=.299*r+.587*g+.114*b;
    const sat=mx===0?0:((mx-mn)/mx)*255;
    const whiteScore=smooth(mx,v0,v0+55)*smooth(sat,105,25);
    const z=Math.max(0,Math.min(255,Math.round(gray*.22+255*whiteScore*.78)));
    d[i]=d[i+1]=d[i+2]=z;
  }
  ctx.putImageData(img,0,0);
}

// Step 1.25-B v3.0: adaptive OCR preprocessing.
// Keep the source glyph anti-aliasing intact; thresholding/Otsu are rescue-only.
function clampNumber(v,min,max){ return Math.max(min,Math.min(max,Number(v)||0)); }
function dynamicOCRScale(region,cropHeight){
  const pitch=Math.max(20,Number(region?.pitch)||Number(cropHeight)||80);
  const iconH=Math.max(8,Number(region?.icon?.h)||pitch*0.68);
  // v4.0.5: for DB-icon anchors, estimate the actual glyph height from the
  // established UI proportion instead of treating the full icon/band height
  // as text height. The existing v3.1.2 target remains ~40px glyph height.
  const labelHeight=Math.max(8,Number(region?.labelHeight)||iconH*0.28);
  const estimatedTextHeight=region?.sourceType==='icon-anchor'
    ? Math.max(8,Math.min(labelHeight,iconH*0.28,Number(cropHeight||pitch)*0.55))
    : Math.max(8,Math.min(labelHeight,Number(cropHeight||pitch)*0.55));
  return clampNumber(40/estimatedTextHeight,1.5,4.5);
}
function applyLocalContrast(ctx,w,h){
  // Lightweight CLAHE-like local contrast: local mean/variance are approximated
  // with a small box window so this stays practical on iPhone Safari.
  const img=ctx.getImageData(0,0,w,h),src=img.data,out=new Uint8ClampedArray(src);
  const gray=new Uint8Array(w*h), integral=new Float64Array((w+1)*(h+1));
  for(let y=0;y<h;y++){
    let row=0;
    for(let x=0;x<w;x++){
      const i=(y*w+x)*4,g=Math.round(.299*src[i]+.587*src[i+1]+.114*src[i+2]);
      gray[y*w+x]=g; row+=g; integral[(y+1)*(w+1)+(x+1)]=integral[y*(w+1)+(x+1)]+row;
    }
  }
  const radius=Math.max(2,Math.min(7,Math.round(Math.min(w,h)/80)));
  const areaFor=(x0,y0,x1,y1)=>{
    const A=integral[y0*(w+1)+x0],B=integral[y0*(w+1)+(x1+1)],C=integral[(y1+1)*(w+1)+x0],D=integral[(y1+1)*(w+1)+(x1+1)];
    return [Math.max(1,(x1-x0+1)*(y1-y0+1)),D-B-C+A];
  };
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
    const x0=Math.max(0,x-radius),x1=Math.min(w-1,x+radius),y0=Math.max(0,y-radius),y1=Math.min(h-1,y+radius);
    const ar=areaFor(x0,y0,x1,y1),mean=ar[1]/ar[0],g=gray[y*w+x];
    const z=clampNumber(128+(g-mean)*1.65+(mean-128)*0.10,0,255);
    const i=(y*w+x)*4;out[i]=out[i+1]=out[i+2]=Math.round(z);out[i+3]=src[i+3];
  }
  img.data.set(out);ctx.putImageData(img,0,0);
}
function applyMildUnsharp(ctx,w,h){
  const img=ctx.getImageData(0,0,w,h),src=img.data,out=new Uint8ClampedArray(src);
  for(let y=1;y<h-1;y++)for(let x=1;x<w-1;x++){
    const i=(y*w+x)*4; const g=.299*src[i]+.587*src[i+1]+.114*src[i+2];
    let sum=0; for(let yy=-1;yy<=1;yy++)for(let xx=-1;xx<=1;xx++){const j=((y+yy)*w+(x+xx))*4;sum+=.299*src[j]+.587*src[j+1]+.114*src[j+2];}
    const blur=sum/9, z=clampNumber(g+(g-blur)*0.35,0,255),v=Math.round(z);out[i]=out[i+1]=out[i+2]=v;
  }
  img.data.set(out);ctx.putImageData(img,0,0);
}
function extractSubtypeTail(raw){
  const s=String(raw||'').normalize('NFKC').replace(/[\r\n]+/g,' ').replace(/[|｜]/g,' ').replace(/\s+/g,' ').trim();
  // Noise after the subtype is common in the Wilds UI OCR crop.
  const m=s.match(/(?:^|[^A-Za-z0-9])(80q|b6|bq|aq|nq|Bq|BQ|b|B|6|8|a|A|q|v|V|y|Y|ν|α|β|γ|𝛂|𝛽|𝛾)(?=\s*(?:[^A-Za-z0-9]*)$)/iu);
  return m?m[1]:'';
}
function subtypeTailRect(region,imageWidth,imageHeight){
  const name=equipmentNameCropRect(region,imageWidth,imageHeight); if(!name)return null;
  // The subtype is the rightmost short token; reserve a quarter of the name band.
  const width=Math.max(36,Math.round(name.width*0.24));
  return {x:Math.max(0,Math.round(name.x+name.width-width)),y:Math.max(0,Math.round(name.y)),width:Math.min(width,imageWidth-Math.round(name.x+name.width-width)),height:Math.min(Math.round(name.height),imageHeight-Math.round(name.y))};
}
async function recognizeSubtypeTail(worker,region){
  const rect=subtypeTailRect(region,imgW,imgH); if(!rect)return {raw:'',subtype:'',confidence:0};
  const c=document.createElement('canvas');
  const scale=dynamicOCRScale(region,rect.height);
  c.width=Math.max(1,Math.round(rect.width*scale));c.height=Math.max(1,Math.round(rect.height*scale));
  const ctx=c.getContext('2d',{willReadFrequently:true});ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high';
  ctx.drawImage($('img'),rect.x,rect.y,rect.width,rect.height,0,0,c.width,c.height);
  whiteTextHSV(ctx,c.width,c.height);
  const padded=addPaddingCustom(c,Math.max(15,Math.round(c.width*.10)),Math.max(15,Math.round(c.height*.20)),'#000000');
  const oldWhitelist='';
  await worker.setParameters({tessedit_pageseg_mode:'7',tessedit_char_whitelist:'αβγΑΒΓabqvvyYBQ0689'});
  const r=await worker.recognize(padded);
  await worker.setParameters({tessedit_pageseg_mode:'7',preserve_interword_spaces:'1',tessedit_char_whitelist:oldWhitelist});
  const raw=String(r?.data?.text||'').normalize('NFKC').replace(/[\r\n\s]+/g,'').trim();
  const subtype=parseSubtypeFromTail(raw);
  return {raw,subtype,confidence:Number(r?.data?.confidence||0)};
}

function prepareEquipmentOCRCanvas(region,mode='grayscale',band='name'){
  const iw=Math.max(1,Number(imgW)||1), ih=Math.max(1,Number(imgH)||1);
  const r0=equipmentNameCropRect(region,iw,ih);
  if(!r0) return document.createElement('canvas');
  const rect=clampRectToImage(r0,iw,ih);
  const sw=Math.max(1,Math.round(rect.width)), sh=Math.max(1,Math.round(rect.height));

  // v4.0.5: crop directly from the original image. Do not render through an
  // intermediate canvas before the OCR scale-up. The icon-anchor geometry is
  // already calibrated, so this stage only preserves source pixels and sets
  // the OCR scale; preprocessing remains the established v3.1.2 five passes.
  const scale=dynamicOCRScale(region,sh);
  const out=document.createElement('canvas');
  out.width=Math.max(1,Math.round(sw*scale));
  out.height=Math.max(1,Math.round(sh*scale));
  const ctx=out.getContext('2d',{willReadFrequently:true});
  ctx.imageSmoothingEnabled=true;
  ctx.imageSmoothingQuality='high';
  ctx.drawImage($('img'),rect.x,rect.y,sw,sh,0,0,out.width,out.height);

  if(mode==='raw_color') { /* keep original pixels */ }
  else if(mode==='soft_white') softWhiteText(ctx,out.width,out.height);
  else if(mode==='hsv_white') whiteTextHSV(ctx,out.width,out.height);
  else if(mode==='local_contrast'){applyLocalContrast(ctx,out.width,out.height);applyMildUnsharp(ctx,out.width,out.height);}
  else if(mode==='grayscale'){
    const d=ctx.getImageData(0,0,out.width,out.height);
    for(let i=0;i<d.data.length;i+=4){
      const g=.299*d.data[i]+.587*d.data[i+1]+.114*d.data[i+2];
      const z=clampNumber(128+(g-128)*1.20,0,255);
      d.data[i]=d.data[i+1]=d.data[i+2]=Math.round(z);
    }
    ctx.putImageData(d,0,0);
  } else if(mode==='otsu') otsuThreshold(ctx,out.width,out.height);
  else if(mode==='white_extract'){
    const d=ctx.getImageData(0,0,out.width,out.height);
    for(let i=0;i<d.data.length;i+=4){
      const g=.299*d.data[i]+.587*d.data[i+1]+.114*d.data[i+2];
      const z=g<130?0:Math.min(255,(g-130)*2);
      d.data[i]=d.data[i+1]=d.data[i+2]=Math.round(z);
    }
    ctx.putImageData(d,0,0);
  }
  const pad=(mode==='raw_color'||mode==='white_extract'||mode==='hsv_white'||mode==='soft_white'||mode==='local_contrast'||mode==='grayscale')?'#000000':'#FFFFFF';
  return addPaddingCustom(out,Math.max(15,Math.round(out.width*.04)),Math.max(15,Math.round(out.height*.10)),pad);
}
function equipmentRegionCanvas(region, mode='color', band='full'){
  if(mode==='color') return prepareEquipmentOCRCanvas(region,'grayscale',band);
  return prepareEquipmentOCRCanvas(region,mode,band);
}


// Step 1.25-B v2.8: domain-structure parsing for armor and talismans.
// OCR is still limited to the existing three image passes; these helpers only
// reinterpret the resulting text using Monster Hunter UI grammar.
const CATEGORY_ANCHORS={
  head:['ヘルム','キャップ','クラウン','ピアス','ヘッド'],
  chest:['メイル','ベスト','スーツ','ジャケット','ボディ'],
  arms:['アーム','グラブ','アームズ','カフス','バンテージ'],
  waist:['コイル','フォールド','ウエスト','ベルト','ループ'],
  legs:['グリーヴ','ブーツ','パンツ','トラウザー','レギンス']
};
function armorCategoryKey(category){
  const map={'頭防具':'head','胴防具':'chest','腕防具':'arms','腰防具':'waist','脚防具':'legs'};
  return map[category]||category||'';
}
function parseArmorStructure(rawOcrText,category){
  const anchors=CATEGORY_ANCHORS[armorCategoryKey(category)]||[];
  const clean=String(rawOcrText||'').normalize('NFKC').replace(/[\s\._|｜]+/g,'');
  let foundAnchor='',anchorIdx=-1;
  for(const anchor of anchors){const idx=clean.indexOf(anchor);if(idx!==-1&&(anchorIdx===-1||idx<anchorIdx)){foundAnchor=anchor;anchorIdx=idx;}}
  if(anchorIdx!==-1)return {hasAnchor:true,seriesPart:clean.substring(0,anchorIdx),anchorPart:foundAnchor,tailPart:clean.substring(anchorIdx+foundAnchor.length)};
  return {hasAnchor:false,seriesPart:clean,anchorPart:'',tailPart:''};
}
function armorDbStructure(itemName,category){
  const parsed=parseArmorStructure(itemName,category);
  if(parsed.hasAnchor)return parsed;
  const base=armorBaseName(itemName);
  return parseArmorStructure(base,category);
}
function matchArmorV25(ocrText,category,armorDb){
  const target=(Array.isArray(armorDb)?armorDb:[]).filter(item=>String(item?.category||item?.kind||'')===String(category));
  const parsed=parseArmorStructure(ocrText,category);
  const detectedSubtype=parseSubtypeFromTail(parsed.tailPart);
  let best=null;
  for(const item of target){
    const db=armorDbStructure(item.name,category);
    if(!db.seriesPart)continue;
    const seriesScore=robustArmorSeriesSimilarity(parsed.seriesPart,db.seriesPart);
    if(seriesScore<.20)continue;
    const anchorMatch=parsed.hasAnchor&&db.hasAnchor&&parsed.anchorPart===db.anchorPart;
    const anchorBonus=anchorMatch?.22:0;
    const subtype=splitEquipmentSubtype(item.name).subtype;
    const subtypeBonus=subtype&&detectedSubtype===subtype?.18:0;
    const subtypePenalty=subtype&&detectedSubtype&&detectedSubtype!==subtype?.18:0;
    const score=Math.min(1,.78*seriesScore+anchorBonus+subtypeBonus-subtypePenalty);
    const candidate={item,score,seriesScore,anchorPart:db.anchorPart,hasAnchorMatch:anchorMatch,detectedSubtype,subtype};
    if(!best||candidate.score>best.score)best=candidate;
  }
  return best;
}
function parseTalismanLevel(value){
  const raw=String(value||'').normalize('NFKC').replace(/[\r\n]+/g,' ').replace(/\s+/g,' ').trim();
  if(!raw)return '';
  const upper=raw.toUpperCase();
  if(/(?:IV|4)$/.test(upper))return 'Ⅳ';
  if(/(?:III|3)$/.test(upper))return 'Ⅲ';
  if(/(?:II|2)$/.test(upper))return 'Ⅱ';
  if(/(?:I|1)$/.test(upper))return 'Ⅰ';
  if(/(?:V|5)$/.test(upper))return 'Ⅴ';
  return '';
}
function parseTalismanStructure(rawOcrText){
  const clean=String(rawOcrText||'').normalize('NFKC').replace(/[\r\n]+/g,' ').replace(/[\s\._|｜]+/g,'').trim();
  if(!clean)return {anchorFound:false,prefixCandidate:'',suffixCandidate:'',anchor:'',level:''};
  const noIndex=clean.indexOf('の');
  if(noIndex>0)return {anchorFound:true,prefixCandidate:clean.substring(0,noIndex),suffixCandidate:clean.substring(noIndex+1),anchor:'の',level:parseTalismanLevel(clean.substring(noIndex+1))};
  const m=clean.match(/^(.*?)(護石|護|石|引)(.*)$/u);
  if(m&&m[1])return {anchorFound:true,prefixCandidate:m[1],suffixCandidate:m[2]+m[3],anchor:m[2],level:parseTalismanLevel(m[2]+m[3])};
  return {anchorFound:false,prefixCandidate:clean,suffixCandidate:'',anchor:'',level:''};
}
function talismanDbStructure(itemName){
  const clean=String(itemName||'').normalize('NFKC').replace(/[\s\._|｜]+/g,'');
  const m=clean.match(/^(.*?)の護石([ⅠⅡⅢⅣⅤ]*)$/u);
  if(m)return {prefix:m[1],level:m[2]||'',hasAnchor:true};
  const fallback=clean.match(/^(.*?)(?:護石)([ⅠⅡⅢⅣⅤ]*)$/u);
  return fallback?{prefix:fallback[1],level:fallback[2]||'',hasAnchor:true}:{prefix:clean,level:'',hasAnchor:false};
}
function matchTalismanV25(rawOcrText,talismanDb){
  const parsed=parseTalismanStructure(rawOcrText);
  const target=Array.isArray(talismanDb)?talismanDb:[];
  let best=null;
  for(const item of target){
    const db=talismanDbStructure(item.name); if(!db.prefix)continue;
    const prefixScore=robustArmorSeriesSimilarity(parsed.prefixCandidate,db.prefix);
    const anchorBonus=parsed.anchorFound&&db.hasAnchor?.15:0;
    const levelBonus=parsed.level&&db.level&&parsed.level===db.level?.15:0;
    const levelPenalty=parsed.level&&db.level&&parsed.level!==db.level?.10:0;
    const score=Math.min(1,.70*prefixScore+anchorBonus+levelBonus-levelPenalty);
    const candidate={item,score,prefixScore,anchorFound:parsed.anchorFound,level:db.level,detectedLevel:parsed.level};
    if(!best||candidate.score>best.score)best=candidate;
  }
  return best;
}

// Step 1.25-B v2.8: hierarchical armor recognition.
// Stage 1 compares only the armor series/base name. Alpha/beta/gamma are ignored.
// Stage 2 compares variants only inside the winning series family.
function armorBaseName(name){ return splitEquipmentSubtype(name).base; }
function armorSeriesKey(name){ return normalizeForNameScore(armorBaseName(name)).join(''); }
function armorSeriesScore(raw,itemName){
  const rawBase=armorBaseName(raw), itemBase=armorBaseName(itemName);
  return robustArmorSeriesSimilarity(rawBase,itemBase);
}
function parseSubtypeFromTail(tailStr){
  // MH Wilds equipment OCR commonly turns the terminal β marker into B6/BQ/bq.
  // Treat these as beta only when they occur in the terminal subtype tail.
  const clean=String(tailStr||'').normalize('NFKC').replace(/[\r\n]+/g,' ').replace(/\s+/g,' ').trim().toLowerCase();
  if(!clean)return '';
  const token=clean.replace(/[^a-zαβγν𝛂𝛽𝛾0-9]+$/iu,'').trim();
  if(/^(?:b6|bq|80q|β|b|6|8|𝛽)$/iu.test(token))return 'β';
  if(/^(?:aq|nq|α|a|q|𝛂)$/iu.test(token))return 'α';
  if(/^(?:γ|y|v|ν|𝛾)$/iu.test(token))return 'γ';
  return '';
}

function stripTailSubtypeToken(raw){
  const s=String(raw||'').normalize('NFKC').replace(/[\r\n]+/g,' ').replace(/\s+/g,' ').trim();
  const m=s.match(/^(.*?)(?:\s*(α|β|γ|a|aq|b|bq|6|80q|v|V|ν|y|Y))\s*[一ー―昌央1-9]*$/iu);
  return m?m[1].trim():s;
}
function armorEditSimilarity(a,b){
  const aa=Array.from(a),bb=Array.from(b); let prev=Array.from({length:bb.length+1},(_,i)=>i);
  for(let i=1;i<=aa.length;i++){const cur=new Array(bb.length+1);cur[0]=i;for(let j=1;j<=bb.length;j++){cur[j]=Math.min(prev[j]+1,cur[j-1]+1,prev[j-1]+(aa[i-1]===bb[j-1]?0:1));}prev=cur;}
  return prev[bb.length];
}
function robustArmorSeriesSimilarity(rawBase,itemBase){
  const norm=v=>Array.from(String(v||'').normalize('NFKC')).filter(ch=>!/[\s・･·•\-‐‑‒–—―＿_.,，。！？!?、:：;；/／\\|｜()[\]{}「」『』【】〈〉《》<>＋+＝=＊*#＃%％&＆@＠]/.test(ch));
  const a=norm(rawBase).join(''),b=norm(itemBase).join('');
  if(!a||!b)return 0;
  if(a===b)return 1;
  const edit=1-armorEditSimilarity(a,b)/Math.max(a.length,b.length);
  let lcsBest=0, prev=new Array(b.length+1).fill(0);
  for(let i=1;i<=a.length;i++){const cur=new Array(b.length+1).fill(0);for(let j=1;j<=b.length;j++){if(a[i-1]===b[j-1])cur[j]=prev[j-1]+1;else cur[j]=Math.max(prev[j],cur[j-1]);}lcsBest=Math.max(lcsBest,cur[b.length]);prev=cur;}
  const lcs=lcsBest/Math.max(a.length,b.length);
  const containment=a.includes(b)||b.includes(a)?0.92:0;
  return Math.max(0,Math.min(1,Math.max(edit,lcs*.90,containment)));
}
function matchArmorV24(ocrRawText,category,dbItems){
  const target=(Array.isArray(dbItems)?dbItems:[]).filter(item=>String(item?.category||item?.kind||'')===String(category));
  let best=null;
  for(const item of target){
    const dbMatch=String(item.name||'').match(/^(.*?)([αβγ])?$/u); const dbParts={base:(dbMatch?dbMatch[1]:String(item.name||'')).trim(),subtype:dbMatch&&dbMatch[2]?dbMatch[2]:null}; const rawText=String(ocrRawText||'').normalize('NFKC').replace(/[\r\n]+/g,' ').replace(/\s+/g,' ').trim(); const rawBase=rawText.replace(/(?:\s*(?:α|β|γ|a|aq|b|bq|6|80q|v|V|ν|y|Y))\s*[一ー―昌央1-9]*$/iu,'').trim();
    const series=robustArmorSeriesSimilarity(rawBase,dbParts.base);
    if(series<.35)continue;
    const rawClean=String(ocrRawText||'').normalize('NFKC').replace(/\s+/g,' ').trim();
    const rawTailMatch=rawClean.match(/(?:α|β|γ|aq|a|bq|b|80q|6|v|V|ν|y|Y)\s*[一ー―昌央1-9]*$/iu);
    const tail=rawTailMatch?rawTailMatch[0].replace(/[一ー―昌]+$/u,'').trim():'';
    const detected=parseSubtypeFromTail(tail);
    let score=.88*series;
    if(dbParts.subtype){
      if(detected===dbParts.subtype)score+=.12;
      else if(detected && detected!==dbParts.subtype)score-=.18;
    }
    const candidate={item,baseName:dbParts.base,subtype:dbParts.subtype,seriesScore:series,subtypeScore:detected?(detected===dbParts.subtype?1:0):.5,score,detectedSubtype:detected};
    if(!best||candidate.score>best.score)best=candidate;
  }
  return best;
}

function armorSeriesEvidence(rows,candidateName){
  const list=Array.isArray(rows)?rows:[]; if(!list.length)return {score:0,support:0,confAvg:0};
  const scores=list.map(r=>{const score=armorSeriesScore(r?.raw||'',candidateName);return {score,conf:Number(r?.conf||0)};});
  const supporting=scores.filter(x=>x.score>=.60);
  const confAvg=supporting.length?supporting.reduce((s,x)=>s+x.conf,0)/supporting.length:0;
  const avg=supporting.length?supporting.reduce((s,x)=>s+x.score,0)/supporting.length:0;
  const supportRatio=supporting.length/list.length;
  const supportBoost=supportRatio>=.66?.08:supportRatio>0?.04:0;
  return {score:Math.min(1,.82*avg+.18*supportRatio+supportBoost),support:supporting.length,confAvg};
}
function rankHierarchicalArmorCandidates(raw,conf,items){
  const pool=Array.isArray(items)?items:[];
  const category=pool.length?String(pool[0]?.category||''):'';
  const structure=parseArmorStructure(raw,category);
  const families=new Map();
  for(const item of pool){
    const key=armorSeriesKey(item.name); if(!key)continue;
    if(!families.has(key))families.set(key,{key,baseName:armorBaseName(item.name),items:[]});
    families.get(key).items.push(item);
  }
  const familyRank=[...families.values()].map(f=>{
    const db=armorDbStructure(f.baseName,category);
    let seriesScore=armorSeriesScore(raw,f.baseName);
    if(structure.hasAnchor&&db.hasAnchor&&structure.anchorPart===db.anchorPart){
      seriesScore=Math.min(1,Math.max(seriesScore,robustArmorSeriesSimilarity(structure.seriesPart,db.seriesPart))+.18);
    }
    return {...f,seriesScore:Math.min(1,seriesScore),seriesRaw:f.baseName,structure:db};
  }).sort((a,b)=>b.seriesScore-a.seriesScore);
  if(!familyRank.length)return [];
  const topFamilies=familyRank.slice(0,3),cw=confidenceWeight(conf),variants=[];
  const detectedSubtype=parseSubtypeFromTail(structure.tailPart);
  for(const family of topFamilies){
    for(const item of family.items){
      const parts=splitEquipmentSubtype(item.name);
      const subtype=parts.subtype;
      const sub=detectedSubtype&&subtype?(detectedSubtype===subtype?1:0):equipmentSubtypeScore(raw,item.name);
      const subtypeContribution=subtype?(detectedSubtype===subtype?.18:(detectedSubtype?- .18:0)):0;
      const anchorContribution=structure.hasAnchor&&family.structure.hasAnchor&&structure.anchorPart===family.structure.anchorPart?.10:0;
      const base=family.seriesScore;
      const score=Math.min(1,.72*base+.10*cw+.10*base+subtypeContribution+anchorContribution);
      variants.push({...item,nameScore:base,seriesScore:base,subtypeScore:sub,score,confidenceWeight:cw,
        seriesName:family.baseName,subtype,stage:'シリーズ→部位→型式',anchorPart:family.structure.anchorPart,anchorMatched:anchorContribution>0});
    }
  }
  return variants.sort((a,b)=>b.score-a.score);
}

// Step 1.25-B v2.8: robust series-first recognition.
// Each OCR pass is scored independently; no concatenation of noisy OCR strings.
function v26NormalizeArmorText(value){
  return Array.from(String(value||'').normalize('NFKC')).filter(ch=>!/[\s・･·•\-‐‑‒–—―＿_.,，。！？!?、:：;；/／\\|｜()[\]{}「」『』【】〈〉《》<>＋+＝=＊*#＃%％&＆@＠]/.test(ch)).join('');
}
function v26Ngrams(value,n=2){
  const a=Array.from(v26NormalizeArmorText(value)); const out=[]; for(let i=0;i<=a.length-n;i++)out.push(a.slice(i,i+n).join('')); return out;
}
function v26NgramSimilarity(a,b){
  const aa=v26Ngrams(a),bb=v26Ngrams(b); if(!aa.length||!bb.length)return 0;
  const setB=new Set(bb); let hit=0; for(const x of aa)if(setB.has(x))hit++;
  return hit/Math.max(aa.length,bb.length);
}
function v26SeriesPassScore(raw,itemName,category){
  const structure=parseArmorStructure(raw,category);
  const db=armorDbStructure(itemName,category);
  const seriesRaw=structure.seriesPart||v26NormalizeArmorText(raw);
  const seriesDb=db.seriesPart||v26NormalizeArmorText(itemName);
  const seriesRobust=robustArmorSeriesSimilarity(seriesRaw,seriesDb);
  const seriesNgram=v26NgramSimilarity(seriesRaw,seriesDb);
  const fullRaw=stripTailSubtypeToken(String(raw||''));
  const fullDb=stripTailSubtypeToken(String(itemName||''));
  const fullRobust=robustArmorSeriesSimilarity(fullRaw,fullDb);
  const fullNgram=v26NgramSimilarity(fullRaw,fullDb);
  const anchor=structure.hasAnchor&&db.hasAnchor&&structure.anchorPart===db.anchorPart?1:0;
  return Math.min(1,.50*seriesRobust+.15*seriesNgram+.25*fullRobust+.05*fullNgram+.05*anchor);
}
function armorSeriesEvidenceV26(rows,candidateName){
  const list=Array.isArray(rows)?rows:[]; if(!list.length)return {score:0,best:0,passes:[]};
  const category=String(list[0]?.category||'頭防具');
  const passes=list.map(r=>({score:v26SeriesPassScore(r.raw,candidateName,category),conf:Number(r.conf||0),raw:r.raw}));
  const sorted=passes.map(x=>x.score).sort((a,b)=>b-a);
  const best=sorted[0]||0;
  const weighted=passes.reduce((sum,x,i)=>sum+x.score*(i===0?1.0:i===1?.85:.70),0)/passes.reduce((sum,_,i)=>sum+(i===0?1.0:i===1?.85:.70),0);
  return {score:Math.min(1,.78*weighted+.22*best),best,passes};
}
function v26FamilyKey(item){return v26NormalizeArmorText(splitEquipmentSubtype(item.name).base);}
function rankArmorSeriesV26(raw,conf,items,category){
  const pool=Array.isArray(items)?items:[]; const families=new Map();
  for(const item of pool){
    const key=v26FamilyKey(item); if(!key)continue;
    if(!families.has(key))families.set(key,{key,seriesName:splitEquipmentSubtype(item.name).base,items:[]});
    families.get(key).items.push(item);
  }
  const scored=[...families.values()].map(f=>{
    const score=v26SeriesPassScore(raw,f.seriesName,category);
    const structure=parseArmorStructure(raw,category);
    const db=armorDbStructure(f.seriesName,category);
    const anchorMatched=!!(structure.hasAnchor&&db.hasAnchor&&structure.anchorPart===db.anchorPart);
    return {...f,seriesScore:score,anchorMatched};
  }).sort((a,b)=>b.seriesScore-a.seriesScore);
  return scored.slice(0,5);
}
function aggregateHierarchicalArmorCandidatesV26(rows,items,category,allArmorItems){
  // v4.5.11: subtype evidence is authoritative when OCR identifies α/β/γ;
  // do not allow equal series scores to leave α/β tied.

  const list=Array.isArray(rows)?rows.filter(r=>equipmentOCRUsableText(r?.raw)):[]; if(!list.length)return []; const agg=new Map();
  const searchPool=Array.isArray(allArmorItems)&&allArmorItems.length?allArmorItems:items;
  for(const row of list){
    const ranked=rankArmorSeriesV26(row.raw,row.conf,searchPool,category); if(!ranked.length)continue;
    const wantKind=armorCategoryKey(category);
    // DB rows are normalized with kind=head/chest/arms/waist/legs. Never compare
    // that internal kind directly with the Japanese display category.
    const familyWithCategory=ranked.find(f=>f.items.some(item=>String(item?.category||item?.kind||'')===String(category)||String(item?.kind||'')===wantKind));
    if(!familyWithCategory){
      // Series-first retrieval can legitimately fail on very noisy OCR. Recover
      // candidates with the generic matcher rather than returning an empty result.
      const fallback=aggregateGenericEquipmentCandidates(list,[...searchPool].filter(item=>String(item?.kind||'')===wantKind||String(item?.category||'')===String(category)));
      if(fallback.length){
        row.ranked=fallback.slice(0,3);
        for(const cand of fallback.slice(0,3)){
          const key=cand.name; const old=agg.get(key)||{...cand,support:0,seriesRows:[],subtypeMatches:0,subtypeObserved:0,confSum:0,topRows:[],total:list.length,seriesName:armorBaseName(cand.name),subtype:splitEquipmentSubtype(cand.name).subtype};
          old.support+=1; old.confSum+=Number(row.conf||0); old.seriesRows.push(Number(cand.nameScore||0));
          old.topRows.push({rank:0,score:Number(cand.score||0),seriesScore:Number(cand.nameScore||0),subtypeScore:null,conf:Number(row.conf||0),raw:row.raw,anchorMatched:false});
          agg.set(key,old);
        }
      }
      continue;
    }
    const topFamily=familyWithCategory;
    const categoryVariants=topFamily.items.filter(item=>String(item?.category||item?.kind||'')===String(category)||String(item?.kind||'')===wantKind);
    if(!categoryVariants.length)continue;
    row.ranked=categoryVariants.map(item=>({item,seriesName:topFamily.seriesName}));
    const rawSubtype=parseSubtypeFromTail(parseArmorStructure(row.raw,category).tailPart);
    // The full-name OCR contains the actual terminal token (e.g. B6 in "護雷顎竜ヘルムB6").
    // Prefer that explicit evidence over the separate narrow-tail OCR, which can misread a short token.
    const detected=rawSubtype||row.subtypeDetected;
    for(const item of categoryVariants){
      const parts=splitEquipmentSubtype(item.name); const subtype=parts.subtype;
      const subtypeEvidence=subtype&&detected?(detected===subtype?1:0):-1;
      const key=item.name;
      const old=agg.get(key)||{...item,support:0,seriesRows:[],subtypeMatches:0,subtypeObserved:0,confSum:0,topRows:[],total:list.length,seriesName:topFamily.seriesName,subtype};
      old.seriesRows.push(topFamily.seriesScore);
      if(subtype && detected){old.subtypeObserved++; if(subtypeEvidence===1){old.subtypeMatches++;old.support++;old.confSum+=Number(row.conf||0);}}
      old.topRows.push({rank:subtypeEvidence===1?0:1,score:topFamily.seriesScore,seriesScore:topFamily.seriesScore,subtypeScore:subtypeEvidence===1?1:(subtypeEvidence===0?0:null),conf:Number(row.conf||0),raw:row.raw,anchorMatched:topFamily.anchorMatched});
      old.anchorMatched=old.anchorMatched||topFamily.anchorMatched; agg.set(key,old);
    }
  }
  return [...agg.values()].map(x=>{
    const seriesAvg=x.seriesRows.length?x.seriesRows.reduce((a,b)=>a+b,0)/x.seriesRows.length:0;
    const subtypeConf=x.subtypeObserved?x.subtypeMatches/x.subtypeObserved:0;
    const confAvg=x.support?x.confSum/x.support:0;
    const supportRatio=x.support/Math.max(1,list.length);
    const supportBonus=supportRatio>=.66?.06:supportRatio>0?.03:0;
    const anchorBonus=x.anchorMatched?.03:0;
    const subtypeComponent=x.subtypeObserved?(0.18*subtypeConf):0;
    const total=Math.min(1,.67*seriesAvg+.10*seriesAvg+.10*(confAvg/100)+subtypeComponent+supportBonus+anchorBonus);
    return {...x,avgNameScore:seriesAvg,avgSeriesScore:seriesAvg,confAvg,subtypeAvg:subtypeConf,subtypeConfidence:subtypeConf,totalScore:total,final:total,
      hierarchy:{seriesScore:seriesAvg,subtypeScore:subtypeConf,totalScore:total,anchorMatched:x.anchorMatched}};
  }).sort((a,b)=>b.totalScore-a.totalScore);
}
function equipmentDecisionV26(top,second){
  if(!top)return {level:'manual',label:'手動入力'};
  const gap=second?top.totalScore-second.totalScore:null;
  const series=Number(top.avgSeriesScore||0), subtype=Number(top.subtypeConfidence||0);
  const subtypeRequired=!!top.subtype;
  if(series>=.80 && (!subtypeRequired || subtype>=.70) && top.confAvg>=45 && (gap==null||gap>=.05))return {level:'auto',label:'自動確定候補'};
  if(series>=.55 && (gap==null||gap>=.03))return {level:'confirm',label:'ユーザー確認'};
  if(series>=.40)return {level:'ambiguous',label:'候補選択'};
  return {level:'manual',label:'手動入力'};
}

function aggregateHierarchicalArmorCandidates(rows,items){
  const agg=new Map();
  const list=Array.isArray(rows)?rows:[];
  for(const row of list){
    const familyCandidates=rankHierarchicalArmorCandidates(row.raw,row.conf,items);
    if(!familyCandidates.length)continue;
    const winningFamily=familyCandidates[0].seriesName;
    const familyVariants=familyCandidates.filter(c=>c.seriesName===winningFamily).sort((a,b)=>b.score-a.score);
    const subtypeWinner=familyVariants[0]; row.ranked=familyVariants.slice(0,3);
    familyVariants.forEach((cand,rank)=>{
      const old=agg.get(cand.name)||{...cand,support:0,sumSeries:0,sumScore:0,bestSeries:0,confSum:0,topRows:[],total:list.length,seriesSupport:0,subtypeSum:0,subtypeEvidenceCount:0};
      old.sumSeries+=cand.seriesScore; old.sumScore+=cand.score; old.bestSeries=Math.max(old.bestSeries,cand.seriesScore); old.seriesSupport++;
      const isSubtypeWinner=cand.name===subtypeWinner.name;
      if(isSubtypeWinner){old.support++;old.confSum+=row.conf;}
      old.subtypeSum+=Number(cand.subtypeScore||0);old.subtypeEvidenceCount++;
      old.topRows.push({rank:isSubtypeWinner?0:rank+1,score:cand.score,nameScore:cand.seriesScore,conf:row.conf,seriesScore:cand.seriesScore,subtypeScore:cand.subtypeScore,seriesWinner:true,anchorMatched:cand.anchorMatched});
      old.id=cand.id;old.gameId=cand.gameId;old.kind=cand.kind;old.seriesName=cand.seriesName;old.subtype=cand.subtype;old.anchorPart=cand.anchorPart;old.anchorMatched=old.anchorMatched||cand.anchorMatched;
      agg.set(cand.name,old);
    });
  }
  return [...agg.values()].map(x=>{
    const familyRows=x.topRows||[];
    const avgSeries=familyRows.length?familyRows.reduce((s,r)=>s+Number(r.seriesScore||0),0)/familyRows.length:0;
    const subtypeAvg=x.subtypeEvidenceCount?x.subtypeSum/x.subtypeEvidenceCount:0;
    const confAvg=x.support?x.confSum/x.support:0;
    const supportRatio=x.support/Math.max(1,list.length);
    const supportBonus=supportRatio>=.66?.08:supportRatio>0?.04:0;
    const anchorBonus=x.anchorMatched?.06:0;
    const totalScore=Math.min(1,.72*avgSeries+.10*avgSeries+.10*(confAvg/100)+.12*subtypeAvg+supportBonus+anchorBonus);
    return {...x,avgNameScore:avgSeries,avgSeriesScore:avgSeries,confAvg,subtypeAvg,totalScore,final:totalScore,
      hierarchy:{seriesScore:avgSeries,subtypeScore:subtypeAvg,totalScore,anchorMatched:x.anchorMatched}};
  }).sort((a,b)=>b.totalScore-a.totalScore);
}
function aggregateTalismanCandidates(rows,items){
  const agg=new Map(); const list=Array.isArray(rows)?rows:[];
  for(const row of list){
    const ranked=matchTalismanV25(row.raw,items);
    if(!ranked)continue;
    const key=ranked.item.name;
    const old=agg.get(key)||{...ranked.item,support:0,sumScore:0,sumPrefix:0,confSum:0,total:list.length,rows:[]};
    old.support++;old.sumScore+=ranked.score;old.sumPrefix+=ranked.prefixScore;old.confSum+=row.conf;old.rows.push(row);
    old.id=ranked.item.id;old.gameId=ranked.item.gameId;old.kind=ranked.item.kind;agg.set(key,old);
  }
  return [...agg.values()].map(x=>{
    const n=Math.max(1,x.support),avgScore=x.sumScore/n,avgPrefix=x.sumPrefix/n,confAvg=x.confSum/n;
    const supportBonus=x.support===list.length&&list.length>=2?.08:x.support>=2?.04:x.support===1&&list.length===1?.04:0;
    const totalScore=Math.min(1,.72*avgPrefix+.13*avgScore+.15*(confAvg/100)+supportBonus);
    return {...x,avgNameScore:avgPrefix,confAvg,totalScore,final:totalScore,hierarchy:{seriesScore:avgPrefix,subtypeScore:0,totalScore}};
  }).sort((a,b)=>b.totalScore-a.totalScore);
}
function rankGenericEquipmentCandidates(raw,conf,items){
  const pool=Array.isArray(items)?items:[];
  return pool.map(item=>{const w=weightedNameDistance(raw,item.name);const cw=confidenceWeight(conf);return {...item,nameScore:w.score,score:.85*w.score+.15*cw,confidenceWeight:cw,details:w.details,matched:w.matched};}).sort((a,b)=>b.score-a.score);
}
function aggregateGenericEquipmentCandidates(rows,items){
  const list=Array.isArray(rows)?rows.filter(r=>equipmentOCRUsableText(r?.raw)):[];
  if(!list.length)return [];
  const agg=new Map();
  for(const row of list){
    const ranked=rankGenericEquipmentCandidates(row.raw,row.conf,items).slice(0,3); row.ranked=ranked;
    ranked.forEach((cand,rank)=>{const rw=rank===0?1:rank===1?.65:.4;const old=agg.get(cand.name)||{...cand,support:0,sumName:0,sumScore:0,bestName:0,confSum:0,total:list.length};if(rank===0)old.support++;old.sumName+=cand.nameScore*rw;old.sumScore+=cand.score*rw;old.bestName=Math.max(old.bestName,cand.nameScore);old.confSum+=rank===0?row.conf*1:0;old.id=cand.id;old.gameId=cand.gameId;old.kind=cand.kind;agg.set(cand.name,old);});
  }
  return [...agg.values()].map(x=>{const supportRows=Math.max(1,x.support);const avgName=x.sumName/Math.max(1,list.length);const confAvg=x.support?x.confSum/x.support:0;const supportBonus=x.support===list.length&&list.length>=2?.08:x.support>=2?.04:x.support===1&&list.length===1?.04:0;const total=Math.min(1,.78*avgName+.15*x.bestName+.07*(confAvg/100)+supportBonus);return {...x,avgNameScore:avgName,bestNameScore:x.bestName,confAvg,totalScore:total,supportBonus};}).sort((a,b)=>b.totalScore-a.totalScore);
}
function equipmentDecision(top,second){
  if(!top)return {level:'manual',label:'手動入力'};
  const gap=second?top.totalScore-second.totalScore:null;
  if(top.totalScore>=.72&&top.avgNameScore>=.50&&top.confAvg>=45&&(gap==null||gap>=.05))return {level:'auto',label:'自動確定候補'};
  if(top.totalScore>=.55&&(gap==null||gap>=.03))return {level:'confirm',label:'ユーザー確認'};
  if(top.totalScore>=.40)return {level:'ambiguous',label:'候補選択'};
  return {level:'manual',label:'手動入力'};
}
function equipmentOCRShouldStop(ranked, rows) {
  if (!Array.isArray(ranked) || !ranked.length || rows.length < 2) return false;
  const top=ranked[0], second=ranked[1];
  const gap=second ? top.totalScore-second.totalScore : 1;
  return top.totalScore>=0.78 && top.avgNameScore>=0.60 && top.confAvg>=55 && gap>=0.07;
}
const EQUIPMENT_OCR_STANDARD_PASSES=[
  ['raw_color','元画像'],
  ['grayscale','グレースケール'],
  ['soft_white','ソフト白文字'],
  ['hsv_white','白文字・色除去']
];
const EQUIPMENT_OCR_RESCUE_PASSES=[
  ['local_contrast','局所コントラスト救済'],
  ['otsu','Otsu救済']
];
const PREPROCESS_PASSES=[...EQUIPMENT_OCR_STANDARD_PASSES,...EQUIPMENT_OCR_RESCUE_PASSES];
const PREPROCESS_TARGETS=['mainWeapon','head','chest','arms','waist','legs','charm'];

// v3.1 is an evaluation-only Spike. These passes are intentionally separate
// from the production standard passes so their OCR cost/results can be compared
// on real screenshots before changing the default pipeline.
const SPIKE_PREPROCESS_PASSES=[
  ['soft_white','ソフト白文字抽出'],
  ['grayscale','グレースケール'],
  ['local_contrast','CLAHE比較'],
  ['otsu','Otsu救済比較']
];
const SPIKE_TARGETS=['mainWeapon','head','chest','arms','waist','legs','charm'];
async function renderPreprocessSpike(){
  if(!$('img').src){$('preprocessStatus').textContent='先に画像を選択してください。';return}
  const regions=Array.isArray(window.lastEquipmentRegions)?window.lastEquipmentRegions:[];
  if(regions.length!==9){$('preprocessStatus').textContent='先に「画面構造を自動検出」を実行してください。';return}
  const btn=$('runPreprocessSpike');btn.disabled=true;
  const started=performance.now(); const rows=[];
  let worker=null;
  try{
    worker=await Tesseract.createWorker('jpn');
    await worker.setParameters({tessedit_pageseg_mode:'7',preserve_interword_spaces:'1'});
    for(const key of SPIKE_TARGETS){
      const region=regions.find(r=>r.key===key); if(!region)continue;
      const slotStarted=performance.now();
      for(const [mode,label] of SPIKE_PREPROCESS_PASSES){
        $('preprocessStatus').textContent=`Spike：${equipmentSlotLabel(key)} / ${label}`;
        const t0=performance.now();
        const c=equipmentRegionCanvas(region,mode,'name');
        const r=await worker.recognize(c);
        const raw=cleanOCR(r?.data?.text||'').replace(/(?:メイン武器|サブ武器|頭防具|胴防具|腕防具|腰防具|脚防具|護石|装衣)/g,' ').replace(/\s+/g,' ').trim();
        rows.push({key,mode,label,raw,confidence:Number(r?.data?.confidence||0),ms:performance.now()-t0});
      }
      rows.push({key,mode:'__slot__',label:'部位合計',raw:'',confidence:0,ms:performance.now()-slotStarted});
    }
    window.lastPreprocessSpike=rows;
    const total=(performance.now()-started)/1000;
    const cards=SPIKE_TARGETS.map(key=>{
      const slot=rows.filter(r=>r.key===key&&r.mode!=='__slot__');
      const sum=rows.find(r=>r.key===key&&r.mode==='__slot__');
      const cells=slot.map(r=>`<div style="border:1px solid #c8baa0;border-radius:8px;padding:7px;margin-top:5px"><b>${r.label}</b><br><span class="note">OCR: ${r.raw||'（空）'} / Confidence ${Math.round(r.confidence)}% / ${Math.round(r.ms)}ms</span></div>`).join('');
      return `<div class="card" style="margin:8px 0;padding:10px"><b>${equipmentSlotLabel(key)}</b>${cells}<div class="note" style="margin-top:6px">部位合計 ${Math.round(sum?.ms||0)}ms</div></div>`;
    }).join('');
    $('preprocessPreview').innerHTML=`<div class="note"><b>Spike結果</b>：4方式 × 7部位 / 合計 ${total.toFixed(1)}秒。これは比較専用で、本番OCRの方式は変更していません。</div>`+cards;
    $('preprocessStatus').textContent=`前処理Spike完了：${SPIKE_PREPROCESS_PASSES.length}方式 × ${SPIKE_TARGETS.length}部位 / ${total.toFixed(1)}秒`;
  }catch(err){$('preprocessStatus').textContent='前処理Spikeエラー：'+String(err)}
  finally{if(worker)await worker.terminate();btn.disabled=false}
}
$('runPreprocessSpike').onclick=renderPreprocessSpike;
function renderPreprocessPreview(){
  const host=$('preprocessPreview');
  const status=$('preprocessStatus');
  const regions=Array.isArray(window.lastEquipmentRegions)?window.lastEquipmentRegions:[];
  if(!$('img').src){status.textContent='先に画像を選択してください。';return;}
  if(regions.length!==9){status.textContent='先に「画面構造を自動検出」を実行してください。';return;}
  const labels={mainWeapon:'メイン武器',head:'頭防具',chest:'胴防具',arms:'腕防具',waist:'腰防具',legs:'脚防具',charm:'護石'};
  const started=performance.now();
  host.innerHTML='';
  const records=[];
  for(const key of PREPROCESS_TARGETS){
    const region=regions.find(r=>r.key===key);
    if(!region)continue;
    const card=document.createElement('div');
    card.style='border:1px solid #c8baa0;border-radius:9px;padding:9px;margin-top:8px';
    const title=document.createElement('div');
    title.innerHTML=`<b>${labels[key]||key}</b> <span class="note">装備名OCR領域</span>`;
    card.appendChild(title);
    const row=document.createElement('div');
    row.style='display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin-top:8px';
    const passRecords=[];
    for(const [mode,label] of PREPROCESS_PASSES){
      const wrap=document.createElement('div');
      const lab=document.createElement('div'); lab.className='note'; lab.textContent=label; wrap.appendChild(lab);
      const c=equipmentRegionCanvas(region,mode,'name');
      const frame=document.createElement('div');
      frame.style='height:72px;display:flex;align-items:center;justify-content:center;background:#111;border-radius:6px;margin-top:4px;overflow:hidden';
      c.style='width:auto;height:auto;max-width:100%;max-height:100%;display:block';
      frame.appendChild(c);
      wrap.appendChild(frame); row.appendChild(wrap);
      passRecords.push({mode,label,canvas:c});
    }
    card.appendChild(row);
    host.appendChild(card);
    records.push({key,passes:passRecords});
  }
  window.lastPreprocessPreview=records;
  status.textContent=`前処理確認完了：${records.length}部位 × ${PREPROCESS_PASSES.length}方式 / OCR未実行 / ${(performance.now()-started).toFixed(1)}ms`;
}

function renderCropOnlySpike(){
  const host=$('preprocessPreview');
  const status=$('preprocessStatus');
  const regions=Array.isArray(window.lastEquipmentRegions)?window.lastEquipmentRegions:[];
  if(!$('img').src){status.textContent='先に画像を選択してください。';return;}
  if(regions.length!==9){status.textContent='先に「画面構造を自動検出」を実行してください。';return;}

  const labels={
    mainWeapon:'メイン武器',head:'頭防具',chest:'胴防具',arms:'腕防具',
    waist:'腰防具',legs:'脚防具',charm:'護石'
  };
  const started=performance.now();
  host.innerHTML='';

  const intro=document.createElement('div');
  intro.className='note';
  intro.textContent='OCRは実行せず、検出した装備名の切り出し範囲だけを確認します。各部位は「現在方式」を基準に、比較用の広幅・余白付き範囲も表示します。';
  host.appendChild(intro);

  const records=[];
  for(const key of PREPROCESS_TARGETS){
    const region=regions.find(r=>r.key===key);
    if(!region)continue;

    const card=document.createElement('div');
    card.style='border:1px solid #c8baa0;border-radius:9px;padding:9px;margin-top:8px';

    const title=document.createElement('div');
    title.innerHTML=`<b>${labels[key]||key}</b> <span class="note">切り出し境界のみ</span>`;
    card.appendChild(title);

    const variants=buildEquipmentNameCropVariantsV311(region,imgW,imgH);
    const row=document.createElement('div');
    row.style='display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin-top:8px';

    const variantRecords=[];
    for(const variant of variants){
      const wrap=document.createElement('div');
      const lab=document.createElement('div');
      lab.className='note';
      lab.textContent=variant.label;
      wrap.appendChild(lab);

      const rect=clampRectToImage(variant.rect,imgW,imgH);
      const c=document.createElement('canvas');
      const sx=Math.max(0,Math.round(rect.x));
      const sy=Math.max(0,Math.round(rect.y));
      const sw=Math.max(1,Math.min(imgW-sx,Math.round(rect.width)));
      const sh=Math.max(1,Math.min(imgH-sy,Math.round(rect.height)));
      const scale=Math.min(3,1200/Math.max(sw,sh));
      c.width=Math.max(1,Math.round(sw*scale));
      c.height=Math.max(1,Math.round(sh*scale));
      c.getContext('2d').drawImage($('img'),sx,sy,sw,sh,0,0,c.width,c.height);
      c.style='width:100%;height:auto;display:block;background:#111;border-radius:6px;margin-top:4px';
      wrap.appendChild(c);
      row.appendChild(wrap);
      variantRecords.push({id:variant.id,label:variant.label,rect,canvas:c});
    }

    card.appendChild(row);
    host.appendChild(card);
    records.push({key,variants:variantRecords});
  }

  window.lastCropOnlyPreview=records;
  status.textContent=`切り出し確認完了：${records.length}部位 × 4方式 / OCR未実行 / ${(performance.now()-started).toFixed(1)}ms`;
}

if(typeof renderCropOnlySpike==='function') $('previewCropOnly').onclick=renderCropOnlySpike;
$('previewPreprocess').onclick=renderPreprocessPreview;


// ---- 装飾品DB（Step 1.25-C v4.5.1） ----
// MHDB Japanese decoration list: one row per decoration. OCR never depends on
// this network call; the DB is a post-OCR candidate source and is cached locally.
const DECORATION_API='https://wilds.mhdb.io/ja/decorations';
const DECORATION_CACHE_KEY='DEV_MWWSKILLSIM_OCR_DECORATIONS_V1';
let decorationDB=[];
let decorationDBReady=false;
let decorationDBPromise=null;
let decorationGramIndex=new Map();

function setDecorationDBStatus(text, cls=''){
  const el=$('decorationDBStatus');
  if(el) el.innerHTML=`装飾品DB：<span class="${cls}">${text}</span>`;
}
function normalizeDecorationName(v){
  return String(v||'').normalize('NFKC').replace(/[［］]/g,'【').replace(/[\[\]]/g,'【').replace(/\s+/g,'').trim();
}
function normalizeDecorationRows(rows){
  const seen=new Set(); const out=[];
  for(const d of (Array.isArray(rows)?rows:[])){
    const name=normalizeDecorationName(d?.name);
    if(!name)continue;
    const row={
      id:d?.id??null, gameId:d?.gameId??null, name,
      description:d?.description??null,
      value:d?.value??null,
      slot:Number.isFinite(Number(d?.slot))?Number(d.slot):null,
      rarity:Number.isFinite(Number(d?.rarity))?Number(d.rarity):null,
      kind:String(d?.kind||''),
      skills:Array.isArray(d?.skills)?d.skills.map(x=>({
        id:x?.skill?.id??null, gameId:x?.skill?.gameId??null,
        name:x?.skill?.name??null, level:x?.level??null, description:x?.description??null
      })):[],
      icon:d?.icon?{color:d.icon.color??null,colorId:d.icon.colorId??null}:null
    };
    const key=`${row.gameId??''}\u0000${row.id??''}\u0000${row.name}\u0000${row.slot??''}\u0000${row.kind}`;
    if(seen.has(key))continue; seen.add(key); out.push(row);
  }
  return out;
}
function rebuildDecorationGramIndex(){
  decorationGramIndex=new Map();
  decorationDB.forEach((item,idx)=>{
    const n=normJPLoose(item.name.replace(/[【［].*?[】］]/g,''));
    const seen=new Set();
    for(let i=0;i<n.length-1;i++){
      const g=n.slice(i,i+2); if(seen.has(g))continue; seen.add(g);
      if(!decorationGramIndex.has(g))decorationGramIndex.set(g,new Set());
      decorationGramIndex.get(g).add(idx);
    }
  });
}
async function fetchDecorationPage(offset){
  const projection={id:true,gameId:true,name:true,description:true,value:true,slot:true,rarity:true,kind:true,skills:true,icon:true};
  const u=`${DECORATION_API}?limit=250&offset=${offset}&p=${encodeURIComponent(JSON.stringify(projection))}`;
  const r=await fetch(u,{cache:'no-store',mode:'cors'});
  if(!r.ok)throw new Error(`装飾品DB HTTP ${r.status}`);
  const data=await r.json();
  if(!Array.isArray(data))throw new Error('装飾品DBの応答が配列ではありません');
  return data;
}
async function loadDecorationDB(force=false){
  if(decorationDBReady&&!force)return decorationDB;
  if(decorationDBPromise&&!force)return decorationDBPromise;
  decorationDBPromise=(async()=>{
    let cachedRows=[];
    try{const c=JSON.parse(localStorage.getItem(DECORATION_CACHE_KEY)||'null');cachedRows=normalizeDecorationRows(c?.rows||c);}catch(e){}
    if(!force&&cachedRows.length){decorationDB=cachedRows;rebuildDecorationGramIndex();decorationDBReady=true;setDecorationDBStatus(`${decorationDB.length.toLocaleString()}件（保存済みDB）`,'ok');return decorationDB;}
    try{
      setDecorationDBStatus('全件取得中…','info');const all=[];let offset=0;
      for(let page=0;page<100;page++){const part=await fetchDecorationPage(offset);all.push(...part);setDecorationDBStatus(`全件取得中… ${all.length.toLocaleString()}件`,'info');if(part.length<250)break;offset+=250;}
      const rows=normalizeDecorationRows(all);if(!rows.length)throw new Error('装飾品DBが0件でした');
      decorationDB=rows;rebuildDecorationGramIndex();decorationDBReady=true;
      try{localStorage.setItem(DECORATION_CACHE_KEY,JSON.stringify({savedAt:new Date().toISOString(),rows}));}catch(e){}
      setDecorationDBStatus(`${decorationDB.length.toLocaleString()}件（最新取得）`,'ok');return decorationDB;
    }catch(e){
      if(cachedRows.length){decorationDB=cachedRows;rebuildDecorationGramIndex();decorationDBReady=true;setDecorationDBStatus(`${decorationDB.length.toLocaleString()}件（保存済みDBを使用）`,'warn');return decorationDB;}
      setDecorationDBStatus('取得失敗：'+e.message,'bad');throw e;
    }
  })();
  try{return await decorationDBPromise}catch(e){decorationDBPromise=null;decorationDBReady=false;throw e}finally{decorationDBPromise=null}
}
function decorationKindForEquipmentKey(key){
  return key==='mainWeapon'||key==='subWeapon'?'weapon':'armor';
}
function decorationBaseName(raw){
  return normJPLoose(String(raw||'')
    .replace(/[【［\[].*?[】］\]]/g,'')
    .replace(/\bLv\.?\s*[1-3]\b/ig,'')
    .replace(/[0-9]+$/g,''));
}
function decorationCoreName(raw){
  // 「珠」までをシリーズ核として扱う。
  const s=decorationBaseName(raw).replace(/[|｜]/g,'');
  const i=s.indexOf('珠');
  return i>=0 ? s.slice(0,i+1) : s.replace(/(?:I{1,3}|V|[１２３]|[旧昌号告])$/,'');
}
function decorationVariantKey(raw){
  // 同じ核・同じslotでも II / III のような別DB行があるため、
  // 核だけで選ばず枝番号も照合する。認識不能な末尾は空文字にして
  // 勝手にIII等へ決め打ちしない。
  const s=normJPLoose(String(raw||'')).replace(/[【［\[].*?[】］\]]/g,'').trim();
  const m=s.match(/(?:珠)\s*(I{1,3}|V|[1-3]|[１２３])(?![A-Za-z0-9])/i);
  if(!m)return '';
  const v=m[1].toUpperCase().replace(/[１２３]/g,x=>({'１':'1','２':'2','３':'3'}[x]));
  return v==='1'?'I':v==='2'?'II':v==='3'?'III':v;
}
function decorationVariantCompatible(raw,cand){
  const a=decorationVariantKey(raw), b=decorationVariantKey(cand?.name);
  if(!a || !b)return null;
  return a===b;
}
function searchDecorationItems(raw, maxSlot=null, expectedKind=null){
  if(!decorationDB.length)return [];
  let pool=decorationDB;
  if(expectedKind) pool=pool.filter(x=>String(x.kind)===String(expectedKind));
  // 装備側のslotは「装着可能な上限」。装飾品自身のslotとは別情報。
  if(maxSlot!=null) pool=pool.filter(x=>Number(x.slot)<=Number(maxSlot));
  // OCRで【1】【2】【3】を読めた場合は装飾品自身のslot/Lv情報として強く利用する。
  const ocrSlot=parseDecorationSlotLevel(raw);
  if(ocrSlot!=null){
    const exactSlot=pool.filter(x=>Number(x.slot)===Number(ocrSlot));
    if(exactSlot.length) pool=exactSlot;
  }
  return pool;
}
function scoreDecorationCandidate(raw,cand,maxSlot=null,expectedKind=null){
  const a=decorationBaseName(raw), b=decorationBaseName(cand.name);
  const ac=decorationCoreName(raw), bc=decorationCoreName(cand.name);
  if(!a||!b||!ac||!bc)return {score:0,coreScore:0,exactCore:false};
  const edit=1-lev(a,b)/Math.max(a.length,b.length,1);
  const coreScore=1-lev(ac,bc)/Math.max(ac.length,bc.length,1);
  const exactCore=ac===bc;
  const variant=decorationVariantCompatible(raw,cand);
  const rawLv=parseDecorationSlotLevel(raw);
  const contain=(a.includes(b)||b.includes(a))?0.05:0;
  const exact=a===b?0.20:0;
  const variantBonus=variant===true?0.24:(variant===false?-0.28:0);
  // OCRで明示された【3】等は候補slotとの一致を強く評価する。
  const slotMatch=(rawLv!=null && Number(cand.slot)===Number(rawLv));
  const slot=(rawLv!=null) ? (slotMatch ? 0.28 : -0.35) : 0;
  const kind=(expectedKind && cand.kind===expectedKind)?0.05:0;
  const score=Math.max(0,Math.min(1,coreScore*0.55+edit*0.16+contain+exact+variantBonus+slot+kind));
  return {score,coreScore,exactCore,variant,rawLv,slotMatch};
}
function normalizeDecorationOCRForDB(raw){
  // OCRで「3」が「IL / Il / lL / ll」等に崩れるケースを、
  // 装飾品DBに照合するときだけ「3」として再評価する。
  // 画面表示用の生OCR文字列は変更しない。DBに実在する候補が
  // 見つからなければ、補正結果だけで装飾品を生成・確定しない。
  let s=String(raw||'').normalize('NFKC');
  s=s.replace(/珠(?:IL|Il|lL|ll)(?=【|［|\[|$)/g,'珠3');
  return s;
}
function matchDecorationCandidates(raw,maxSlot=null,expectedKind=null){
  const matchRaw=normalizeDecorationOCRForDB(raw);
  if(!raw||!decorationDB.length)return [];
  const pool=searchDecorationItems(matchRaw,maxSlot,expectedKind);
  if(!pool.length)return [];
  const ac=decorationCoreName(matchRaw);
  const exactCorePool=pool.filter(c=>decorationCoreName(c.name)===ac);
  const targetPool=exactCorePool.length ? exactCorePool : pool;
  const scored=targetPool.map(c=>{const m=scoreDecorationCandidate(matchRaw,c,maxSlot,expectedKind);return {...c,matchScore:m.score,coreMatchScore:m.coreScore,exactCore:m.exactCore,variantMatch:m.variant};});
  const rawVariant=decorationVariantKey(matchRaw);
  const variantPool=rawVariant ? scored.filter(c=>c.variantMatch===true) : scored;
  const finalPool=rawVariant && variantPool.length ? variantPool : scored;
  finalPool.sort((a,b)=>b.matchScore-a.matchScore);
  if(!exactCorePool.length && (!finalPool[0] || finalPool[0].coreMatchScore<0.62))return [];
  return finalPool.slice(0,5);
}
$('loadDecorationDB')?.addEventListener('click',async()=>{const b=$('loadDecorationDB');b.disabled=true;try{await loadDecorationDB(true)}catch(e){}finally{b.disabled=false}});
$('clearDecorationDB')?.addEventListener('click',()=>{try{localStorage.removeItem(DECORATION_CACHE_KEY)}catch(e){} decorationDB=[];decorationDBReady=false;decorationDBPromise=null;decorationGramIndex=new Map();setDecorationDBStatus('未取得')});

function normalizeDecorationSlotLevels(value) {
  const out=[];
  const seen=new Set();
  const push=(v,depth=0)=>{
    if(v==null || depth>6)return;
    if(typeof v==='number' && Number.isFinite(v)){ const n=Math.round(v); if(n>=1&&n<=3) out.push(n); return; }
    if(typeof v==='string'){
      const ms=v.match(/[1-3]/g)||[];
      ms.forEach(m=>out.push(Number(m)));
      return;
    }
    if(Array.isArray(v)){ v.forEach(x=>push(x,depth+1)); return; }
    if(typeof v==='object'){
      if(seen.has(v))return; seen.add(v);
      // Prefer the actual slot collections. Do not stop after the first key:
      // a previous implementation returned after the first nested value and
      // could reduce [2,1] to [2].
      let usedCollection=false;
      for(const k of ['slotLevels','decorationSlots','slots','levels']){
        if(v[k]!=null){ usedCollection=true; push(v[k],depth+1); }
      }
      if(!usedCollection){
        for(const k of ['level','slotLevel','size','rank','value']){
          if(v[k]!=null) push(v[k],depth+1);
        }
      }
      // API/cache variants can expose slots as slot1/slot2/slot3 or level1/2/3.
      // Read these keys in numeric order so [2,1] cannot collapse to [2].
      const keyed=Object.keys(v)
        .filter(k=>/^(?:slot|decorationSlot|level)?\s*[1-3]$/i.test(k))
        .sort((a,b)=>Number((a.match(/[1-3]/)||['0'])[0])-Number((b.match(/[1-3]/)||['0'])[0]));
      keyed.forEach(k=>push(v[k],depth+1));
    }
  };
  push(value);
  return out.slice(0,3);
}


function extractDecorationSlotLevels(row) {
  if(!row)return [];
  const explicit=normalizeDecorationSlotLevels(row?.limitBreakSlotLevels ?? row?.maxLimitBreakSlots);
  if(explicit.length)return explicit;
  const base=normalizeDecorationSlotLevels(row?.baseSlotLevels ?? row?.slotLevels ?? row?.decorationSlots ?? row?.slots);
  const kind=String(row?.kind||'');
  if(['head','chest','arms','waist','legs'].includes(kind)) return maxLimitBreakArmorSlotLevels(base,row?.rarity);
  return base;
}

function runEquipmentSlotExtractionSelfTest() {
  const cases = [
    {name:'mainWeapon', value:{slots:[3,3,3]}, expected:[3,3,3]},
    {name:'subWeapon', value:{slots:[3,3,1]}, expected:[3,3,1]},
    {name:'head', value:{slots:[3,1]}, expected:[3,1]},
    {name:'chest', value:{slots:[3,2]}, expected:[3,2]},
    {name:'arms', value:{slots:[2,1]}, expected:[2,1]},
    {name:'waist', value:{slots:[2,1]}, expected:[2,1]},
    {name:'legs', value:{slots:[3,3]}, expected:[3,3]},
    {name:'charm', value:{slots:[1,1,1]}, expected:[1,1,1]},
    {name:'nested', value:{decorationSlots:{slots:[2,1]}}, expected:[2,1]},
    {name:'numericKeys', value:{slot1:2,slot2:1}, expected:[2,1]}
  ];
  const basic=cases.every(c=>JSON.stringify(normalizeDecorationSlotLevels(c.value))===JSON.stringify(c.expected));
  const limitCases=[
    {name:'rare6 one slot',base:[1],rarity:6,expected:[2,1]},
    {name:'rare6 two slots',base:[2,1],rarity:6,expected:[3,2]},
    {name:'rare6 three slots',base:[2,2,1],rarity:6,expected:[3,3,2]},
    {name:'rare8 unchanged',base:[3,2],rarity:8,expected:[3,2]},
    {name:'rare6 no slots',base:[],rarity:6,expected:[1,1]}
  ];
  const limitOk=limitCases.every(c=>JSON.stringify(maxLimitBreakArmorSlotLevels(c.base,c.rarity))===JSON.stringify(c.expected));
  return basic&&limitOk;
}

function getEquipmentExpectedGroupSlots(key) {
  const ctx=window.equipmentContext;
  const row=ctx?.results?.find(x=>x.key===key);
  return extractDecorationSlotLevels(row?.best);
}

function updateEquipmentContext() {
  const output = Array.isArray(window.lastEquipmentOCR) ? window.lastEquipmentOCR : [];
  window.equipmentContext = output.length ? {
    source: 'equipment',
    analyzedAt: new Date().toISOString(),
    results: output.map(x => ({
      key: x.key,
      best: x.best ? {
        id: x.best.id ?? null, gameId: x.best.gameId ?? null, kind: x.best.kind ?? null,
        name: x.best.name || null,
        totalScore: Number(x.best.totalScore ?? x.best.final ?? 0),
        decision: x.best.decision?.level || null,
        slots: x.best.slots || x.best.decorationSlots || null,
        slotLevels: extractDecorationSlotLevels(x.best),
        raw: x.rows?.map(r => r.raw).filter(Boolean) || []
      } : null,
      ranked: Array.isArray(x.ranked) ? x.ranked.map(c => ({
        id: c.id ?? null, gameId: c.gameId ?? null, kind: c.kind ?? null,
        name: c.name || null,
        totalScore: Number(c.totalScore ?? c.final ?? 0),
        decision: c.decision?.level || null,
        slots: c.slots || c.decorationSlots || null,
        slotLevels: extractDecorationSlotLevels(c)
      })) : []
    }))
  } : null;
  return window.equipmentContext;
}

function updateDecorationContext() {
  const r = window.decorationSlotResult || null;
  window.decorationContext = r ? {
    source: 'decoration',
    analyzedAt: new Date().toISOString(),
    imageW: r.imageW, imageH: r.imageH,
    gameArea: r.gameArea,
    rowCount: Array.isArray(r.rois) ? r.rois.length : 0,
    slotCount: Array.isArray(r.groups) ? r.groups.reduce((n,g)=>n+g.slots.length,0) : 0,
    groupCount: Array.isArray(r.groups) ? r.groups.length : 0,
    buildGroupCount: Array.isArray(r.groups) ? r.groups.filter(g=>g.reflect!==false).length : 0,
    buildSlotCount: Array.isArray(r.groups) ? r.groups.filter(g=>g.reflect!==false).reduce((n,g)=>n+g.slots.length,0) : 0,
    groups: Array.isArray(r.groups) ? r.groups.map(g => ({
      groupIndex:g.groupIndex, equipmentKey:g.equipmentKey || null, label:g.label || null,
      expectedSlotLevels:(getEquipmentExpectedGroupSlots(g.equipmentKey) || g.expectedSlotLevels || []),
      slots:g.slots.map(x=>({slotIndex:x.slotIndex,slotInGroup:x.slotInGroup,slotLevel:x.slotLevel||null,
        x:x.x,y:x.y,w:x.w,h:x.h,pitch:x.pitch,ocr:x.ocr||null,jewel:x.jewel||null,decorationCandidates:x.decorationCandidates||x.ocr?.candidates||[],decorationBest:x.decorationBest||x.ocr?.dbBest||null}))
    })) : [],
    buildGroups: Array.isArray(r.groups) ? r.groups.filter(g=>g.reflect!==false).map(g=>({groupIndex:g.groupIndex,equipmentKey:g.equipmentKey,label:g.label,expectedSlotLevels:(getEquipmentExpectedGroupSlots(g.equipmentKey)||g.expectedSlotLevels||[]),slots:g.slots})) : [],
    rois: Array.isArray(r.rois) ? r.rois.map(x => ({
      slotIndex: x.slotIndex, groupIndex: x.groupIndex, slotInGroup: x.slotInGroup,
      isSeparator: !!x.isSeparator, x: x.x, y: x.y, w: x.w, h: x.h, pitch: x.pitch,
      ocr: x.ocr || (Array.isArray(r.ocr) ? r.ocr.find(o=>o.slotIndex===x.slotIndex) || null : null), jewel: x.jewel || null
    })) : []
  } : null;
  return window.decorationContext;
}

function selfTestDecorationStructureV454(){
  const labels=['メイン武器','サブ武器','頭防具','胴防具','腕防具','腰防具','脚防具','護石'];
  const keys=['mainWeapon','subWeapon','head','chest','arms','waist','legs','charm'];
  const sizes=[3,3,2,2,2,2,2,3];
  const mock=[]; let slotIndex=0;
  sizes.forEach((n)=>{for(let j=0;j<n;j++)mock.push({slotIndex:slotIndex++,isSeparator:false});});
  const groups=[];
  for(let i=0,gi=0;i<mock.length;i+=sizes[gi++]){
    const block=mock.slice(i,i+sizes[gi-1]);
    groups.push({groupIndex:gi-1,slots:block.map((r,j)=>({...r,groupIndex:gi-1,slotInGroup:j}))});
  }
  const ids=groups.flatMap(g=>g.slots.map(s=>`${g.groupIndex}:${s.slotInGroup}`));
  const unique=new Set(ids).size===ids.length;
  const orderOk=labels.join('|')===DECORATION_GROUP_ORDER.map(x=>x.label).join('|') && keys.join('|')===DECORATION_GROUP_ORDER.map(x=>x.key).join('|');
  const ok=groups.length===8&&mock.length===19&&unique&&orderOk&&groups.every(g=>g.slots.length<=3);
  return {ok,groups:groups.length,slots:mock.length,uniqueIds:unique,orderOk,sizes:groups.map(g=>g.slots.length),labels};
}
window.selfTestDecorationStructureV454=selfTestDecorationStructureV454;
window.selfTestDecorationStructureV453=selfTestDecorationStructureV454;

function renderBuildReflectionState(state) {
  const eqCount = state.equipment ? state.equipment.results.length : 0;
  const decoCount = state.decoration ? state.decoration.slotCount : 0;
  const groupCount = state.decoration ? state.decoration.groupCount : 0;
  const buildGroupCount = state.decoration ? state.decoration.buildGroupCount : 0;
  const buildSlotCount = state.decoration ? state.decoration.buildSlotCount : 0;
  let html = `<div class="result ok"><b>ビルド反映データを作成しました</b><div class="mono">` +
    `装備解析=${state.equipment ? 'あり' : 'なし'} / 装飾品解析=${state.decoration ? 'あり' : 'なし'} / ` +
    `装備結果=${eqCount}部位 / 装飾品=${groupCount}表示グループ・${decoCount}スロット / ビルド反映=${buildGroupCount}グループ・${buildSlotCount}スロット` +
    `</div></div>`;
  if (state.equipment) html += `<div class="result"><b>装備</b><div class="mono">${state.equipment.results.map(x => `${equipmentSlotLabel(x.key)}：${x.best?.name || '候補なし'}${x.best?.slotLevels?.length?' / DBスロット['+x.best.slotLevels.join(',')+']':''}`).join('<br>')}</div></div>`;
  if (state.decoration) html += `<div class="result"><b>装飾品グループ</b><div class="mono">${state.decoration.buildGroups.map(g => `${g.groupIndex+1}. ${g.label||'装備グループ'}：${g.slots.length}スロット${g.expectedSlotLevels.length?' / 上限['+g.expectedSlotLevels.join(',')+']':''} → ${g.slots.map(x=>x.ocr?.raw||'未OCR').join(' / ')}`).join('<br>')}</div></div>`;
  if (!state.equipment && !state.decoration) html = `<div class="result warn"><b>反映対象がありません</b><div class="mono">装備画面または装飾品画面を先に解析してください。</div></div>`;
  $('buildReflectionOut').innerHTML = html;
}

function reflectAnalysisToBuild() {
  const equipment = updateEquipmentContext();
  const decoration = updateDecorationContext();
  const state = { version: 'beta-integrated-ocr-1.0', reflectedAt: new Date().toISOString(), equipment, decoration };
  window.buildReflectionState = state;
  const charmBest=(equipment?.results||[]).find(x=>x.key==='charm')?.best||null;
  const importPayload = {
    version: state.version, createdAt: state.reflectedAt,
    equipment: (equipment?.results||[]).map(x=>({key:x.key,id:x.best?.id??null,gameId:x.best?.gameId??null,kind:x.best?.kind??null,name:x.best?.name??null,decision:x.best?.decision??null,slotLevels:x.best?.slotLevels||[]})),
    decorations: (decoration?.buildGroups||[]).map(g=>({equipmentKey:g.equipmentKey||null,slots:(g.slots||[]).map(s=>({slotIndex:s.slotIndex,slotInGroup:s.slotInGroup,id:s.jewel?.id??s.decorationBest?.id??s.ocr?.dbBest?.id??null,name:s.jewel?.name??s.decorationBest?.name??s.ocr?.dbBest?.name??null,slot:Number(s.jewel?.slot??s.decorationBest?.slot??s.ocr?.dbBest?.slot??0)||0}))})),
    charm: charmBest?{id:charmBest.id??null,name:charmBest.name??null,slotLevels:charmBest.slotLevels||[]}:null
  };
  window.dispatchEvent(new CustomEvent('mhWildsBuildReflect', { detail: state }));
  renderBuildReflectionState(state);
  try{window.applyOCRImportPayload(importPayload);$('buildReflectionStatus').textContent='OCRで解析したビルドを現在の装備セットへ直接反映しました。';}catch(e){$('buildReflectionStatus').textContent='β版への反映に失敗しました：'+(e?.message||e);console.error(e)}
}

function equipmentOCRUsableText(raw){
  const s=String(raw||'').normalize('NFKC').replace(/[\r\n]+/g,' ').replace(/\s+/g,'').trim();
  if(!s)return false;
  // Never turn punctuation, a single digit, or a lone OCR artifact into a DB
  // candidate. At least two meaningful Japanese/Latin characters are required.
  const meaningful=Array.from(s).filter(ch=>/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}A-Za-z]/u.test(ch));
  if(meaningful.length<2)return false;
  if(/^[\[\]（）(){}【】<>:：・.,，。/／\\|｜0-9]+$/.test(s))return false;
  return true;
}
function cleanEquipmentOCRText(raw){
  return cleanOCR(raw||'')
    .replace(/(?:メイン武器|サブ武器|頭防具|胴防具|腕防具|腰防具|脚防具|護石|装衣)/g,' ')
    .replace(/\s+/g,' ').trim();
}

async function recognizeEquipmentAll(){
  if(!$('img').src){$('equipmentOCRStatus').textContent='先に装備画像を選択してください。';return}
  let roiResult=window.equipmentROIResult;
  if(!roiResult){
    try{
      roiResult=calculateEquipmentROIsRefined($('img'));
      window.equipmentROIResult=roiResult;
      drawEquipmentROIs($('img'),roiResult);
      renderEquipmentROIResult(roiResult);
    }catch(e){$('equipmentOCRStatus').textContent='装備ROI算出エラー：'+e.message;return}
  }
  const regions=roiResult.rois||{};
  const targets=['mainWeapon','head','chest','arms','waist','legs','charm'];
  const btn=$('recognizeEquipment');btn.disabled=true;
  const workflowBtn=$('workflowEquipmentOCR'); if(workflowBtn) workflowBtn.disabled=true;
  const started=performance.now();
  let dbErrors=[];
  try{
    // v4.6.5: DB取得はこの画面の外（テスト用DB取得）で先に完了させる。
    // OCR開始時にネットワーク取得を発生させず、テスト時の再現性を優先する。
    if(!weaponDBReady || !armorReady || !charmReady){
      throw new Error('先に「β版DBを読み込む」を実行してください。β版の取得済みDBが必要です。');
    }
    $('equipmentOCRStatus').textContent='装備OCR準備中…（取得済みDBを使用）';
    setEquipmentDBStatus(`武器 ${weaponDB.length.toLocaleString()}件 / 防具 ${armorDB.length.toLocaleString()}件 / 護石 ${charmDB.length.toLocaleString()}件`,'ok');

    const worker=await Tesseract.createWorker('jpn');
    // DB未取得でも漢字を欠落させないため、v4.5.1では装備OCRに文字whitelistを掛けない。
    // OCRは原文を広く取得し、その後にDB照合・部位制約で候補を絞る。
    await worker.setParameters({
      tessedit_pageseg_mode:'7',
      preserve_interword_spaces:'1'
    });
    const output=[];
    for(const key of targets){
      const region=regions[key==='mainWeapon'?'weaponMain':key==='arms'?'arm':key==='legs'?'leg':key]; const items=equipmentRowsForSlot(key); const rows=[];
      const passes=EQUIPMENT_OCR_STANDARD_PASSES;
      for(const [mode,label] of passes){
        $('equipmentOCRStatus').textContent=`${equipmentSlotLabel(key)}をOCR中… ${label}`;
        const c=equipmentRegionCanvas(region,mode,'name'); const r=await worker.recognize(c);const raw=cleanEquipmentOCRText(r?.data?.text||'');const conf=Number(r?.data?.confidence||0);if(equipmentOCRUsableText(raw))rows.push({raw,conf,mode:label});
        const interim=key==='mainWeapon' ? aggregateGenericEquipmentCandidates(rows,items) : (key==='charm' ? aggregateTalismanCandidates(rows,items) : aggregateHierarchicalArmorCandidatesV26(rows,items,key==='head'?'頭防具':key==='chest'?'胴防具':key==='arms'?'腕防具':key==='waist'?'腰防具':'脚防具',armorDB));
        if(equipmentOCRShouldStop(interim,rows)) break;
      }
      if(key!=='mainWeapon'&&key!=='charm'&&rows.length){
        const subtype=await recognizeSubtypeTail(worker,region);
        if(subtype.subtype) rows[0].subtypeDetected=subtype.subtype;
        rows.subtypeEvidence=subtype;
      }
      let ranked=key==='mainWeapon' ? aggregateGenericEquipmentCandidates(rows,items) : (key==='charm' ? aggregateTalismanCandidates(rows,items) : aggregateHierarchicalArmorCandidatesV26(rows,items,key==='head'?'頭防具':key==='chest'?'胴防具':key==='arms'?'腕防具':key==='waist'?'腰防具':'脚防具',armorDB));
      // Otsu is a rescue path only. It is intentionally skipped when the standard
      // adaptive passes already produced a usable candidate set.
      if(key!=='mainWeapon'&&key!=='charm'&&(!ranked.length || ranked[0].avgSeriesScore<.40)){
        for(const [mode,label] of EQUIPMENT_OCR_RESCUE_PASSES){
          $('equipmentOCRStatus').textContent=`${equipmentSlotLabel(key)}を救済OCR中… ${label}`;
          const c=equipmentRegionCanvas(region,mode,'name'); const r=await worker.recognize(c); const raw=cleanEquipmentOCRText(r?.data?.text||''); const conf=Number(r?.data?.confidence||0);
          if(equipmentOCRUsableText(raw))rows.push({mode:label,raw,conf});
          ranked=aggregateHierarchicalArmorCandidatesV26(rows,items,key==='head'?'頭防具':key==='chest'?'胴防具':key==='arms'?'腕防具':key==='waist'?'腰防具':'脚防具',armorDB);
          if(ranked.length&&ranked[0].avgSeriesScore>=.40)break;
        }
      }
      const best=ranked[0],second=ranked[1];if(best)best.decision=(key==='mainWeapon'||key==='charm')?equipmentDecision(best,second):equipmentDecisionV26(best,second);if(best)best.gap=second?best.totalScore-second.totalScore:null;
      output.push({key,rows,ranked:ranked.slice(0,3),best,region});
      const pct=best?Math.round(best.totalScore*100):0;
      $('equipmentResults').innerHTML=output.map(renderEquipmentResult).join('');
    }
    await worker.terminate();
    // Re-rank once with the same already-loaded DB state, without re-running OCR.
    for(const x of output){
      const key=x.key;
      const items=equipmentRowsForSlot(key);
      let ranked=[];
      if(key==='mainWeapon') ranked=aggregateGenericEquipmentCandidates(x.rows,items);
      else if(key==='charm') ranked=aggregateTalismanCandidates(x.rows,items);
      else ranked=aggregateHierarchicalArmorCandidatesV26(x.rows,items,key==='head'?'頭防具':key==='chest'?'胴防具':key==='arms'?'腕防具':key==='waist'?'腰防具':'脚防具',armorDB);
      x.ranked=ranked.slice(0,3);
      x.best=x.ranked[0];
      const second=x.ranked[1];
      if(x.best) x.best.decision=(key==='mainWeapon'||key==='charm')?equipmentDecision(x.best,second):equipmentDecisionV26(x.best,second);
      if(x.best) x.best.gap=second?x.best.totalScore-second.totalScore:null;
    }
    window.lastEquipmentOCR=output;
    updateEquipmentContext();
    const elapsed=(performance.now()-started)/1000;
    const auto=output.filter(x=>x.best?.decision?.level==='auto').length;
    $('equipmentOCRStatus').textContent=`装備名OCR完了：${output.length}部位 / ${auto}部位が自動確定候補 / ${elapsed.toFixed(1)}秒${dbErrors.length?` / ${dbErrors.length}系統のDB取得失敗（生OCRは保持）`:''}`;
  }catch(err){$('equipmentOCRStatus').textContent='装備名OCRエラー：'+String(err)}
  finally{btn.disabled=false; if(workflowBtn) workflowBtn.disabled=false}
}
function renderEquipmentResult(x){
  const title=equipmentSlotLabel(x.key);const b=x.best;const label=b?.decision?.label||'候補なし';
  const raw=x.rows.map(r=>`${r.mode}: ${r.raw} (${Math.round(r.conf)}%)`).join(' / ')||'OCR文字なし（DB照合は実施しません）';
  const candidates=(x.ranked||[]).map((c,i)=>{const hierarchy=c.hierarchy?` / シリーズ ${Math.round(c.hierarchy.seriesScore*100)}% / 型式 ${Math.round(c.hierarchy.subtypeScore*100)}%`:'';return `<div style="border:1px solid #c8baa0;border-radius:8px;padding:7px;margin-top:5px"><b>${i+1}位 ${c.name}</b> ${i===0?`<span class="corrected-tag">${label}</span>`:''}<br><span class="note">総合 ${Math.round(c.totalScore*100)}pt / 文字 ${Math.round(c.avgNameScore*100)}% / OCR ${Math.round(c.confAvg)}% / 支持 ${c.support}/${x.rows.length}${c.gap!=null?` / 候補差 ${Math.round(c.gap*100)}pt`:''}${hierarchy}</span></div>`}).join('');
  return `<div class="card" style="margin:8px 0;padding:10px"><b>${title}</b><div class="note">${x.region?.sourceType==='icon-anchor'?'領域：DBアイコンアンカー（適応文字帯）':(x.region?.inferred?'領域：構造推定':'領域：OCRアンカー')} / 装備名1行をPSM7でOCR（元画像直接クロップ） / 生OCR：${raw}</div>${candidates||'<div class="note">該当候補なし</div>'}</div>`;
}
$('recognizeEquipment').onclick=recognizeEquipmentAll;
$('ocr').onclick=async()=>{
  if(!$('img').src){$('ocrStatus').textContent='先に画像を選択してください。';return}
  updateCrop();updateNameCrop();$('ocr').disabled=true;
  const started=performance.now();
  try{
    await ensureWeaponDB();
    const worker=await Tesseract.createWorker('jpn');
    const dict=getDictionary();
    const ocrWhitelist=buildOCRWhitelist(dict);
    await worker.setParameters({
      tessedit_pageseg_mode:'7',
      preserve_interword_spaces:'1',
      tessedit_char_whitelist:ocrWhitelist
    });


    // Step 1.9:
    // OCR信頼度を「表示値」から正式な判定根拠へ昇格。
    // 高信頼OCR + 高辞書一致なら即終了し、低信頼OCRは複数支持で補う。
    const fast=[
      {name:'base・2値化155・PSM7',mode:'threshold155',dx:0,dy:0,dw:0,dh:0},
      {name:'base・白黒反転・PSM7',mode:'invert',dx:0,dy:0,dw:0,dh:0},
      {name:'y+2・2値化155・PSM7',mode:'threshold155',dx:0,dy:2,dw:0,dh:-2},
      {name:'tight・2値化155・PSM7',mode:'threshold155',dx:2,dy:2,dw:-4,dh:-2}
    ];
    const extra=[
      {name:'base・コントラスト強調155・PSM7',mode:'contrast155',dx:0,dy:0,dw:0,dh:0},
      {name:'y+2・2値化140・PSM7',mode:'threshold',threshold:140,dx:0,dy:2,dw:0,dh:-2}
    ];
    const rows=[];

    // Step 1.9: Tesseractの文字単位信頼度を補助証拠として利用。
    // 全体confidenceだけでなく、候補名の各文字がOCR結果のどこで高信頼に読まれたかを見る。
    const symbolInfo=(r)=>{
      const syms=Array.isArray(r?.data?.symbols)?r.data.symbols:[];
      return syms.map(x=>({text:String(x?.text||''),conf:Number(x?.confidence||0)}))
        .filter(x=>x.text);
    };
    const charConfFor=(raw, symbols, candidate)=>{
      const rr=normJPLoose(raw||'');
      const cc=normJPLoose(candidate||'');
      if(!rr||!cc||!symbols?.length)return {score:0,coverage:0,matched:0};
      const chars=Array.from(symbols).map(x=>({text:normJPLoose(x.text),conf:x.conf})).filter(x=>x.text);
      const flat=chars.map(x=>Array.from(x.text).map(ch=>({ch,conf:x.conf}))).flat();
      const rchars=Array.from(rr);
      const cchars=Array.from(cc);
      // Find the best ordered alignment of candidate characters inside OCR text.
      let best={score:0,coverage:0,matched:0};
      for(let start=0;start<rchars.length;start++){
        let pos=start,total=0,matched=0,confSum=0;
        for(const ch of cchars){
          let found=-1;
          for(let k=pos;k<Math.min(rchars.length,pos+4);k++) if(rchars[k]===ch){found=k;break;}
          if(found<0)continue;
          matched++; confSum+=flat[found]?.conf||0; total+=1; pos=found+1;
        }
        if(total){
          const coverage=matched/cchars.length;
          const avg=(confSum/matched)/100;
          const score=.65*coverage+.35*avg;
          if(score>best.score)best={score,coverage,matched};
        }
      }
      return best;
    };

    const rankRow=(raw,conf,symbols)=>{
      return getWeaponItems(raw).map(item=>{
        const w=weightedNameDistance(raw,item.name);
        const cw=confidenceWeight(conf);
        const char=charConfFor(raw,symbols,item.name);
        // OCR confidence is a secondary signal; the main score is the explicit
        // 100-point DB-name error model.
        const score=.78*w.score+.12*cw+.10*char.score;
        return {id:item.id,gameId:item.gameId,kind:item.kind,name:item.name,nameScore:w.score,score,confidenceWeight:cw,charConfidence:char.score,charCoverage:char.coverage,details:w.details,matched:w.matched,basePoints:w.basePoints};
      }).sort((a,b)=>b.score-a.score);
    };

    // DB candidate integration: do not require OCR strings to resemble each
    // other. Each OCR independently votes for DB candidates; the same DB name
    // appearing repeatedly is the main evidence. Top-3 candidates from every
    // pass are retained so a noisy pass cannot erase a good candidate.
    const aggregate=()=>{
      const agg=new Map();
      for(const row of rows){
        const ranked=rankRow(row.raw,row.conf,row.symbols);
        row.ranked=ranked.slice(0,3);
        row.best=ranked[0]||null;
        row.second=ranked[1]||null;
        row.candidates=row.ranked;
        row.ranked.forEach((cand,rank)=>{
          const rankWeight=rank===0?1:rank===1?.70:.45;
          const evidence=cand.score*rankWeight*(.70+.30*confidenceWeight(row.conf));
          const old=agg.get(cand.name)||{name:cand.name,id:cand.id,gameId:cand.gameId,kind:cand.kind,support:0,weightedSupport:0,bestRowScore:0,bestConf:0,sumScore:0,sumNameScore:0,bestNameScore:0,topRows:[],rankSum:0};
          if(rank===0)old.support++;
          old.weightedSupport+=evidence;old.sumScore+=cand.score*rankWeight;old.sumNameScore+=cand.nameScore*rankWeight;
          old.bestRowScore=Math.max(old.bestRowScore,cand.score);old.bestConf=Math.max(old.bestConf,row.conf);old.bestNameScore=Math.max(old.bestNameScore,cand.nameScore);
          old.rankSum+=rankWeight;
          old.topRows.push({rank,score:cand.score,nameScore:cand.nameScore,conf:row.conf,details:cand.details});
          agg.set(cand.name,old);
        });
      }
      const ranked=[...agg.values()].map(x=>{
        const support=x.support;
        // Step 1.24: use every OCR pass that selected this candidate as #1.
        // Do not average only the top three rows and do not mix rank-2/3 evidence.
        const supportRatio=support/Math.max(1,rows.length);
        const convergence=.55*supportRatio+.45*Math.min(1,x.rankSum/Math.max(1,rows.length));
        const evidence=summarizeCandidateEvidence({...x,supportRatio,total:rows.length});
        const bonus=evidence.supportBonus;
        return {...x,total:rows.length,avgNameScore:evidence.avgNameScore,avgRowScore:evidence.avgRowScore,confAvg:evidence.confAvg,bestNameScore:evidence.bestNameScore,convergence,totalScore:evidence.totalScore,charScore:evidence.charScore,ocrConfidence:evidence.ocrConfidence,final:evidence.totalScore,supportRatio,supportBonus:bonus,integration:{supportRatio,convergence,supportBonus:bonus,charScore:evidence.charScore,ocrConfidence:evidence.ocrConfidence,totalScore:evidence.totalScore}};
      }).sort((a,b)=>(b.totalScore??b.final)-(a.totalScore??a.final));
      for(let i=0;i<ranked.length;i++)ranked[i].margin=(ranked[i].totalScore??ranked[i].final)-(ranked[i+1]?.totalScore??ranked[i+1]?.final??0);
      return ranked;
    };

    const autoConfirm=ranked=>candidateDecision(ranked[0],ranked[1]?.final ?? null).level==='auto';

    const runPass=async(p)=>{
      $('ocrStatus').textContent=`OCR ${rows.length+1}回目：${p.name}`;
      const c=makeNameOCRCanvas(p.mode,p.dx,p.dy,p.dw,p.dh);
      if(p.mode==='threshold'){
        const ctx=c.getContext('2d',{willReadFrequently:true}),d=ctx.getImageData(0,0,c.width,c.height);
        for(let i=0;i<d.data.length;i+=4){
          const y=.299*d.data[i]+.587*d.data[i+1]+.114*d.data[i+2],z=y>p.threshold?255:0;
          d.data[i]=d.data[i+1]=d.data[i+2]=z;
        }
        ctx.putImageData(d,0,0);
      }
      const r=await worker.recognize(c);
      const raw=cleanOCR(r?.data?.text||'');
      const conf=Number(r?.data?.confidence||0);
      const symbols=symbolInfo(r);
      if(raw)rows.push({name:p.name,raw,conf,symbols});
    };

    for(const p of fast){
      await runPass(p);
      const ranked=aggregate();
      if(autoConfirm(ranked)){
        $('ocrStatus').textContent=`OCR ${rows.length}回で十分な一致を確認：追加OCRを省略`;
        break;
      }
    }

    let ranked=aggregate();
    if(!autoConfirm(ranked)){
      for(const p of extra){
        await runPass(p);
        ranked=aggregate();
        if(autoConfirm(ranked)){
          $('ocrStatus').textContent=`OCR ${rows.length}回で十分な一致を確認：追加OCRを省略`;
          break;
        }
      }
    }

    await worker.terminate();
    ranked=aggregate();

    const best=ranked[0],second=ranked[1];
    const margin=best&&second?best.final-second.final:null;
    if(best)best.decision=candidateDecision(best,second?.final ?? null);
    if(best)best.margin=margin;
    const confirmed=!!best&&best.decision.level==='auto';
    const elapsed=(performance.now()-started)/1000;

    if(best){
      const pct=Math.round(Math.min(99,best.final*100));
      const mode=confirmed?'DB候補確定':'判定保留';
      $('recognized').innerHTML=`${confirmed?best.name:`候補：${best.name}`} <span class="corrected-tag">${mode} ${pct}% / 支持 ${best.support}/${rows.length}</span>`;
    }else{
      $('recognized').textContent='該当候補なし（OCR文字は取得できましたが、全武器DBに十分な一致がありません）';
    }

    $('raw').textContent=rows.map((r,i)=>{
      const b=r.best;
      const d=b?.details||{};
      return `【${i+1} ${r.name} / OCR信頼度 ${Math.round(r.conf)}%】\n・生OCR：${r.raw}\n・1位DB候補：${b?.name||'(なし)'}${b?`（文字評価 ${Math.round(b.nameScore*100)}点 / 行総合 ${Math.round(b.score*100)}%）`:''}\n・減点内訳：通常 ${d.normal||0} / 軽微 ${d.light||0} / 濁点 ${d.dakuten||0} / 欠落 ${d.missing||0} / 余分文字 ${d.extra||0}`;
    }).join('\n\n');
    if(best){
      const second=ranked[1];
      $('raw').textContent += `\n\n【DB候補統合（新方式）】\n・最有力候補：${best.name}\n・総合スコア：${Math.round((best.totalScore??best.final)*100)}pt\n・DB候補支持：${best.support}/${rows.length}回\n・文字評価（統合寄与）：${Math.round((best.charScore||0)*100)}pt\n・支持補正：+${Math.round((best.supportBonus||0)*100)}pt\n・OCR信頼度補正：+${Math.round((best.ocrConfidence||0)*100)}pt\n・候補差：${best.margin==null?'—（2位候補なし）':Math.round(best.margin*100)+'pt'}\n・OCR間一致：最終判定には使用しない`;
    }

    renderCandidates(ranked,{
      total:rows.length,
      decision:best?.decision?.reason||'候補を形成できませんでした.'
    });

    $('ocrStatus').textContent=`解析完了：${rows.length}回の有効OCR / ${elapsed.toFixed(1)}秒 / ${confirmed?'自動確定候補':'判定保留'}`;
  }catch(err){
    $('ocrStatus').textContent='OCRエラー：'+String(err);
  }finally{$('ocr').disabled=false}
};;

const originalFileOnloadMessage=$("fileStatus");


// ============================================================================
// Step 1.25-C v4.0.4
// DB icon anchor -> 9-row grid -> existing v3.1.2 adaptive OCR.
// The v3.1.2 OCR engine is intentionally retained; this block only replaces
// the upstream screen-layout detection when the icon-anchor run succeeds.
// ============================================================================
const V400_ICON_TARGETS=[
  {key:'mainWeapon',label:'メイン武器',row:0},
  {key:'subWeapon',label:'サブ武器',row:1},
  {key:'head',label:'頭防具',row:2},
  {key:'chest',label:'胴防具',row:3},
  {key:'arms',label:'腕防具',row:4},
  {key:'waist',label:'腰防具',row:5},
  {key:'legs',label:'脚防具',row:6},
  {key:'charm',label:'護石',row:7},
  {key:'mantle',label:'装衣',row:8}
];
let v400IconItems=[];
let v400IconCandidates=[];
let v400IconGrid=null;
function v400Median(values){const a=values.filter(Number.isFinite).slice().sort((x,y)=>x-y);if(!a.length)return null;const m=Math.floor(a.length/2);return a.length%2?a[m]:(a[m-1]+a[m])/2;}
function v400LoadImage(file){return new Promise((resolve,reject)=>{const u=URL.createObjectURL(file),im=new Image();im.onload=()=>{URL.revokeObjectURL(u);resolve(im)};im.onerror=reject;im.src=u;});}
function v400ImageData(im){const w=Number(im.naturalWidth||im.width),h=Number(im.naturalHeight||im.height);if(!Number.isFinite(w)||!Number.isFinite(h)||w<1||h<1)throw new Error(`画像サイズが不正です：${w}×${h}`);const c=document.createElement('canvas');c.width=w;c.height=h;const ctx=c.getContext('2d',{willReadFrequently:true});ctx.drawImage(im,0,0);return {data:ctx.getImageData(0,0,w,h),w,h};}
function v400Gray(src){const id=src?.data instanceof ImageData?src.data:src;const a=id?.data,w=Number(id?.width??src?.w),h=Number(id?.height??src?.h);if(!a||!Number.isFinite(w)||!Number.isFinite(h)||w<1||h<1)throw new Error(`グレースケール化する画像サイズが不正です：${w}×${h}`);const g=new Float32Array(w*h),mask=new Float32Array(w*h);for(let i=0,p=0;i<g.length;i++,p+=4){g[i]=.299*a[p]+.587*a[p+1]+.114*a[p+2];mask[i]=(a[p+3]??255)/255;}return {g,mask,w,h};}
function v400Downsample(src,factor){const w=Math.max(1,Math.floor(src.w/factor)),h=Math.max(1,Math.floor(src.h/factor));const c=document.createElement('canvas');c.width=w;c.height=h;const ctx=c.getContext('2d',{willReadFrequently:true});const tmp=document.createElement('canvas');tmp.width=src.w;tmp.height=src.h;const tx=tmp.getContext('2d',{willReadFrequently:true});const id=tx.createImageData(src.w,src.h);for(let i=0,p=0;i<src.g.length;i++,p+=4){const v=Math.max(0,Math.min(255,src.g[i]));id.data[p]=id.data[p+1]=id.data[p+2]=v;id.data[p+3]=Math.round(255*(src.mask?.[i]??1));}tx.putImageData(id,0,0);ctx.imageSmoothingEnabled=true;ctx.drawImage(tmp,0,0,w,h);return v400Gray(ctx.getImageData(0,0,w,h));}
async function v400LoadBundledIcons(){
  v400IconItems=[];
  const targets=[
    ['greatsword','大剣'],['sword_shield','片手剣'],['longsword','太刀'],['dual_blades','双剣'],
    ['hammer','ハンマー'],['lance','ランス'],['light_bowgun','ライトボウガン'],['heavy_bowgun','ヘビィボウガン'],
    ['bow','弓'],['charge_blade','チャージアックス'],['switch_axe','スラッシュアックス'],['hunting_horn','狩猟笛'],
    ['insect_glaive','操虫棍'],['gunlance','ガンランス']
  ];
  for(const [id,name] of targets){
    const path=`db_icons/weapon/${id}.png`;
    const r=await fetch(path,{cache:'no-store'});
    if(!r.ok)throw new Error(`${path} HTTP ${r.status}`);
    const b=await r.blob();
    const f=new File([b],`${id}.png`,{type:'image/png'});
    const im=await v400LoadImage(f);
    v400IconItems.push({name,im,file:f,row:0,id});
  }
  $('anchorDBStatus').textContent=`DBアンカー基準：${v400IconItems.length}枚（検出検索には使用しません）`;
}
function v400EstimateSlotColumn(img, rows, startX, endX){
  // v4.0.4: keep the OCR band to the equipment-name column. The Wilds UI
  // places slot icons as a separate column; on low-resolution screenshots a
  // pixel/color detector is too unstable, so use the icon itself as the scale
  // reference and return a conservative boundary.
  if(!rows?.length) return null;
  const sample=rows[0]?.icon;
  const w=Math.max(1,Number(sample?.w)||45);
  const ax=Math.max(0,Number(sample?.x||0)+w);
  const candidate=Math.round(ax+w*3.45);
  return Math.max(Math.round(ax+w*2.6),Math.min(Math.round(endX),candidate));
}
function v400BuildGrid(anchor,candidates,width,height){
  if(!anchor)throw new Error('採用アンカーがありません');
  const fallbackPitch=height*.0855;
  const main=candidates.find(c=>c.row===0),head=candidates.find(c=>c.row===2),chest=candidates.find(c=>c.row===3);
  const topPitch=(main&&head)?(head.y-main.y)/2:null;
  const armorPitch=fallbackPitch;
  const mainY=main?.y??(anchor.row===0?anchor.y:null);
  const headY=head?.y??(anchor.row===2?anchor.y:(mainY!=null&&topPitch?mainY+topPitch*2:null));
  const chestY=chest?.y??(anchor.row===3?anchor.y:(headY!=null?headY+armorPitch:null));
  const x=v400Median(candidates.map(c=>c.x))??anchor.x;
  const w=v400Median(candidates.map(c=>c.w).filter(v=>v>0))??anchor.w;
  const h=v400Median(candidates.map(c=>c.h).filter(v=>v>0))??anchor.h;
  const rows=[];
  for(let i=0;i<9;i++){
    let y;
    if(i===0&&mainY!=null)y=mainY;
    else if(i===1&&mainY!=null&&topPitch)y=mainY+topPitch;
    else if(i===2&&headY!=null)y=headY;
    else if(i>=3&&chestY!=null)y=chestY+(i-3)*armorPitch;
    else y=anchor.y+(i-anchor.row)*armorPitch;
    const t=V400_ICON_TARGETS[i],rowAx=x+w,ay=y+h;
    const iconObj={x:Math.round(x),y:Math.round(y),w:Math.round(w),h:Math.round(h)};
    rows.push({key:t.key,label:t.label,row:i,icon:iconObj,anchor:{x:Math.round(rowAx),y:Math.round(ay)}});
  }
  // v4.0.9: the DB icon bottom-right is the vertical center of the OCR band.
  // The actual OCR crop is supplied by equipmentNameCropRectV312 via region.ocr.
  const slotX=v400EstimateSlotColumn($('img'),rows,x+w*1.7,x+w*7.2);
  for(const r of rows){
    const icon=r.icon;
    const legacyX=icon.x+icon.w;
    const legacyY=icon.y+icon.h*0.5;
    const legacyW=icon.w*7;
    const legacyH=icon.h;
    const clipped=clampRectToImage(
      {x:legacyX,y:legacyY,width:legacyW,height:legacyH,source:'v3.1.6-icon-anchor-regression'},
      width,height
    );
    r.ocr={x:clipped.x,y:clipped.y,w:clipped.width,h:clipped.height};
    r.slotX=slotX;
  }
  const ocrRight=Math.max(...rows.map(r=>r.ocr.x+r.ocr.w));
  return {rows,topPitch:topPitch??0,armorPitch,calibration:{main,head,chest},anchor,slotX,ocrRight};
}
function v400RegionsFromGrid(grid){
  return grid.rows.map(r=>{
    const labelHeight=Math.max(10,Math.round(r.icon.h*0.28));
    return {
      key:r.key,
      x:r.ocr.x,y:r.ocr.y,width:r.ocr.w,height:r.ocr.h,
      x1:r.ocr.x,y1:r.ocr.y,x2:r.ocr.x+r.ocr.w,y2:r.ocr.y+r.ocr.h,
      confidence:100,labelConfidence:100,label:r.label,
      // This geometry is established by a matched DB icon, so it is NOT an
      // inferred OCR-layout region. Keep the source explicit for downstream
      // cropping and UI diagnostics.
      inferred:false,
      sourceType:'icon-anchor',
      pitch:r.row>=3?grid.armorPitch:(grid.topPitch||grid.armorPitch),
      labelHeight,
      labelX:r.ocr.x,labelY:r.ocr.y,anchorY:r.ocr.y,
      nameAnchor:{x:r.ocr.x,y:r.ocr.y,width:r.ocr.w,height:labelHeight},
      iconAnchorRect:{x:r.ocr.x,y:r.ocr.y,width:r.ocr.w,height:r.ocr.h},
      slotX:Math.min(imgW,r.ocr.x+r.ocr.w),
      icon:r.icon,
      anchor:r.anchor
    };
  });
}
function v400Draw(img,grid){const host=$('iconAnchorStage'),c=$('iconAnchorView');host.style.display='block';const iw=img.naturalWidth||img.width,ih=img.naturalHeight||img.height;c.width=iw;c.height=ih;const ctx=c.getContext('2d');ctx.drawImage(img,0,0);const a=grid.anchor;ctx.strokeStyle='#ff3b30';ctx.lineWidth=4;ctx.strokeRect(a.x,a.y,a.w,a.h);ctx.fillStyle='#ff3b30';ctx.font='bold 18px sans-serif';ctx.fillText(`ANCHOR ${a.name} ${a.score.toFixed(4)}`,a.x+5,Math.max(22,a.y-7));ctx.fillStyle='#9cff57';ctx.beginPath();ctx.arc(a.x+a.w,a.y+a.h,6,0,Math.PI*2);ctx.fill();for(const r of grid.rows){ctx.strokeStyle='#00d5ff';ctx.lineWidth=2;ctx.strokeRect(r.icon.x,r.icon.y,r.icon.w,r.icon.h);ctx.strokeStyle='#ffd000';ctx.lineWidth=3;ctx.strokeRect(r.ocr.x,r.ocr.y,r.ocr.w,r.ocr.h);ctx.fillStyle='#00d5ff';ctx.font='bold 16px sans-serif';ctx.fillText(`${r.row+1}:${r.label}`,r.icon.x+3,Math.max(18,r.icon.y-4));}}
function v400Render(){const g=v400IconGrid,a=g.anchor,cal=g.calibration;const fmt=c=>c?`x=${c.x} y=${c.y} score=${c.score.toFixed(4)}`:'未検出';$('iconAnchorOut').innerHTML=`<div class="result ok"><b>採用アンカー：</b>${a.name}<br><span class="mono">score=${a.score.toFixed(4)} / row=${a.row+1} / icon x=${a.x} y=${a.y} w=${a.w} h=${a.h}<br>OCR入力：v0.9.3検証済み式 / X=icon右 / Y=icon上+50%H / H=100%H / W=7×iconW / 推定字高=${Math.round(Math.max(8,Number(g.anchor?.h||45)*0.28))}px / 目標字高=40px / scale≈${(40/Math.max(8,Number(g.anchor?.h||45)*0.28)).toFixed(2)}x<br>右下角 = (${a.x+a.w}, ${a.y+a.h})<br>上段ピッチ = ${g.topPitch.toFixed(2)} px / 防具ピッチ = ${g.armorPitch.toFixed(2)} px / OCR右端 = ${g.ocrRight ?? 'fallback'} px / スロット列 = ${g.slotX ?? '未検出'}<br>校正：メイン[${fmt(cal.main)}] / 頭[${fmt(cal.head)}] / 胴[${fmt(cal.chest)}]</span></div>`+v400IconCandidates.map(c=>`<div class="result"><b>${c.name}</b> / ${V400_ICON_TARGETS[c.row]?.label||''}<div class="mono">score=${c.score.toFixed(4)} / x=${c.x} y=${c.y} w=${c.w} h=${c.h}${c===a?' ← 採用アンカー':''}</div></div>`).join('')+`<div class="result"><b>生成された9行</b><div class="mono">${g.rows.map(r=>`${r.row+1}. ${r.label}: icon (${r.icon.x},${r.icon.y}) ${r.icon.w}x${r.icon.h} / right-bottom (${r.anchor.x},${r.anchor.y}) / OCR (${r.ocr.x},${r.ocr.y}) ${r.ocr.w}x${r.ocr.h}`).join('\n')}</div></div>`;}

// ============================================================================
// Step 1.25-C v4.2.0
// IMPORTANT DESIGN RULE:
// 1) Find icon boxes from the screenshot itself. NO weapon DB template matching.
// 2) After a 9-row icon column is found, DB icons are used only as a geometric
//    reference for the frame/anchor (bottom-right). They never decide WHERE an
//    icon exists on the screen.
// ============================================================================
function v412Integral(a,w,h){
  const out=new Float32Array((w+1)*(h+1));
  for(let y=0;y<h;y++){
    let row=0;
    const src=y*w, dst=(y+1)*(w+1), prev=y*(w+1);
    for(let x=0;x<w;x++){row+=a[src+x];out[dst+x+1]=out[prev+x+1]+row;}
  }
  return out;
}
function v412RectSum(I,w,x,y,rw,rh){
  if(rw<=0||rh<=0)return 0;
  const x1=Math.max(0,Math.floor(x)),y1=Math.max(0,Math.floor(y));
  const x2=Math.min(w,Math.ceil(x+rw)),y2=Math.min(Math.floor(I.length/(w+1))-1,Math.ceil(y+rh));
  const W=w+1;
  return I[y2*W+x2]-I[y1*W+x2]-I[y2*W+x1]+I[y1*W+x1];
}
function v412BuildFeatureImage(src,factor=2){
  const sw=Number(src?.w||0), sh=Number(src?.h||0);
  const srcData=src?.data instanceof ImageData ? src.data.data : null;
  const w=Math.max(1,Math.floor(sw/factor)),h=Math.max(1,Math.floor(sh/factor));
  const c=document.createElement('canvas');c.width=w;c.height=h;
  const ctx=c.getContext('2d',{willReadFrequently:true});ctx.imageSmoothingEnabled=true;
  const tmp=document.createElement('canvas');tmp.width=sw;tmp.height=sh;
  const tx=tmp.getContext('2d',{willReadFrequently:true});
  if(srcData){
    const id=new ImageData(new Uint8ClampedArray(srcData),sw,sh);
    tx.putImageData(id,0,0);
  }else{
    const id=tx.createImageData(sw,sh);
    for(let i=0,p=0;i<(src?.g?.length||0);i++,p+=4){const v=src.g[i];id.data[p]=id.data[p+1]=id.data[p+2]=v;id.data[p+3]=255;}
    tx.putImageData(id,0,0);
  }
  ctx.drawImage(tmp,0,0,w,h);
  const rgb=ctx.getImageData(0,0,w,h).data;
  const g=new Float32Array(w*h),sat=new Float32Array(w*h);
  for(let i=0,p=0;i<g.length;i++,p+=4){
    g[i]=.299*rgb[p]+.587*rgb[p+1]+.114*rgb[p+2];
    const mx=Math.max(rgb[p],rgb[p+1],rgb[p+2]),mn=Math.min(rgb[p],rgb[p+1],rgb[p+2]);
    sat[i]=mx-mn;
  }
  const gx=new Float32Array(w*h),gy=new Float32Array(w*h),mag=new Float32Array(w*h);
  for(let y=1;y<h-1;y++)for(let x=1;x<w-1;x++){
    const i=y*w+x;
    const a=g[i-w-1],b=g[i-w],d=g[i-w+1],e=g[i-1],f=g[i+1],q=g[i+w-1],r=g[i+w],t=g[i+w+1];
    const dx=-a+d-2*e+2*f-q+t,dy=-a-2*b-d+q+2*r+t;mag[i]=Math.sqrt(dx*dx+dy*dy);
  }
  return {w,h,g,sat,mag,Ig:v412Integral(mag,w,h),Is:v412Integral(sat,w,h),Is2:v412Integral(sat.map(v=>v*v),w,h)};
}
function v412CandidateScore(F,x,y,s){
  const bw=Math.max(2,Math.round(s*.10));
  const ring=(v412RectSum(F.Ig,F.w,x,y,s,bw)+v412RectSum(F.Ig,F.w,x,y+s-bw,s,bw)+v412RectSum(F.Ig,F.w,x,y,bw,s)+v412RectSum(F.Ig,F.w,x+s-bw,y,bw,s))/(4*bw*s);
  const ix=x+bw,iy=y+bw,iw=Math.max(2,s-2*bw),ih=iw,n=iw*ih;
  const sm=v412RectSum(F.Is,F.w,ix,iy,iw,ih)/n;
  const sm2=v412RectSum(F.Is2,F.w,ix,iy,iw,ih)/n;
  const std=Math.sqrt(Math.max(0,sm2-sm*sm));
  return .45*Math.min(ring/80,2)+.35*sm/160+.20*Math.min(std/70,2);
}
function v412Nms(cands,limit=1800){
  const sorted=cands.slice().sort((a,b)=>b.score-a.score),out=[];
  for(const c of sorted){let keep=true;for(const q of out){const ix=Math.max(0,Math.min(c.x+c.s,q.x+q.s)-Math.max(c.x,q.x));const iy=Math.max(0,Math.min(c.y+c.s,q.y+q.s)-Math.max(c.y,q.y));const inter=ix*iy,union=c.s*c.s+q.s*q.s-inter;if(inter/Math.max(1,union)>.50){keep=false;break;}}if(keep){out.push(c);if(out.length>=limit)break;}}
  return out;
}
function v432DetectIconComponents(src){
  // v4.3.7: detect the FULL equipment icon frame, not a small dark interior core.
  // Coordinate space is the actual ImageData/canvas pixel space only.
  // DB template matching remains disabled.
  const w=Number(src?.w||0),h=Number(src?.h||0);
  const id=src?.data instanceof ImageData ? src.data : null;
  if(!id) throw new Error('元画像のImageDataがありません');
  if(!Number.isFinite(w)||!Number.isFinite(h)||w<1||h<1) throw new Error(`実画像サイズが不正です：${w}×${h}`);

  // v4.3.8: the icon size must scale with BOTH capture dimensions, not
  // height alone. A portrait 706×1536 capture and a landscape 3840×2160
  // capture can have very different heights while the UI icon scale follows
  // the display's short-side scale more reliably.
  // Reference capture: 706×1536, icon frame ≈60～65 px.
  // Therefore use the shorter image dimension as the scale basis.
  // This also fixes the previous 3840×2160 case where h/1536=1.406 made
  // the detector search only 70～115 px objects, far below the actual UI icon.
  const refShort=706;
  const shortSide=Math.min(w,h);
  const scale=Math.max(.55,Math.min(5.0,shortSide/refShort));
  const minS=Math.round(50*scale);
  const maxS=Math.round(82*scale);
  const step=Math.max(2,Math.round(2*scale));

  // The icon itself extends beyond 15% of this 706 px image (~106 px).
  // Therefore 15% is used as the candidate LEFT-edge zone, while the full
  // square is allowed to extend rightward. This preserves the strong left-UI
  // constraint without truncating the icon frame.
  const searchLeftMax=Math.max(1,Math.min(w,Math.round(w*.15)));
  const xStart=0;
  const xEnd=Math.min(w- minS, searchLeftMax + Math.round(maxS*.55));
  const yMin=Math.max(0,Math.round(h*.10));
  const yMax=Math.min(h-maxS,Math.round(h*.90));

  const F=v412BuildFeatureImage(src,2);
  const ds=2;
  const candidates=[];
  const minSd=Math.max(20,Math.floor(minS/ds)), maxSd=Math.max(minSd+1,Math.ceil(maxS/ds));
  const xEndD=Math.floor(xEnd/ds), yMinD=Math.floor(yMin/ds), yMaxD=Math.floor(yMax/ds);

  // Scan square windows for the characteristic rounded icon frame:
  // strong edge energy around the perimeter + meaningful interior structure.
  for(let sd=minSd;sd<=maxSd;sd+=Math.max(1,Math.round(step/ds))){
    const s=sd*ds;
    const bw=Math.max(2,Math.round(sd*.12));
    for(let y=yMinD;y<=yMaxD;y+=Math.max(1,Math.round(step/ds))){
      for(let x=0;x<=xEndD;x+=Math.max(1,Math.round(step/ds))){
        const ring=(
          v412RectSum(F.Ig,F.w,x,y,sd,bw)+
          v412RectSum(F.Ig,F.w,x,y+sd-bw,sd,bw)+
          v412RectSum(F.Ig,F.w,x,y,bw,sd)+
          v412RectSum(F.Ig,F.w,x+sd-bw,y,bw,sd)
        )/(4*bw*sd);
        const ix=x+bw,iy=y+bw,iw=Math.max(2,sd-2*bw),n=iw*iw;
        const sm=v412RectSum(F.Is,F.w,ix,iy,iw,iw)/n;
        const sm2=v412RectSum(F.Is2,F.w,ix,iy,iw,iw)/n;
        const std=Math.sqrt(Math.max(0,sm2-sm*sm));
        // Reject weak/plain background first.
        if(ring<20 || std<10)continue;
        const score=Math.min(1.5,
          .56*Math.min(ring/75,1.5)+
          .24*Math.min(sm/110,1.5)+
          .20*Math.min(std/65,1.5)
        );
        if(score<.62)continue;
        candidates.push({x:x*ds,y:y*ds,w:s,h:s,score,ring,std,sm});
      }
    }
  }

  // Non-maximum suppression. Keep only spatially distinct square frames.
  candidates.sort((a,b)=>b.score-a.score);
  const kept=[];
  for(const c of candidates){
    const overlap=kept.some(q=>{
      const ix=Math.max(0,Math.min(c.x+c.w,q.x+q.w)-Math.max(c.x,q.x));
      const iy=Math.max(0,Math.min(c.y+c.h,q.y+q.h)-Math.max(c.y,q.y));
      const inter=ix*iy, union=c.w*c.h+q.w*q.h-inter;
      return inter/Math.max(1,union)>.55;
    });
    if(!overlap)kept.push(c);
    if(kept.length>=80)break;
  }
  kept.sort((a,b)=>a.y-b.y || a.x-b.x);
  kept.searchRatio=.15;
  kept.searchXMax=searchLeftMax;
  kept.searchXEnd=xEnd;
  kept.coreRange={minW:minS,maxW:maxS,minH:minS,maxH:maxS};
  kept.scaleBasis='short-side';
  kept.shortSide=shortSide;
  kept.refShort=refShort;
  kept.sceneWidth=w;
  kept.sceneHeight=h;
  kept.detector='full-icon-frame-scan-v4.3.7';
  kept.scale=scale;
  return kept;
}

// v4.3.3 geometry calibration:
// The screenshot core is the detection truth. DB images are NOT overlaid and
// are NOT searched against the screenshot. They only define the calibrated
// relationship from the detected dark core to the virtual icon bottom-right.
// Ratios are intentionally relative to the detected core size so the geometry
// follows screenshot scale instead of using fixed pixels.
const V433_GEOMETRY_CALIBRATION={
  anchorOffsetXRatio:0.22,
  anchorOffsetYRatio:0.21,
  ocrWidthRatio:7.0,
  ocrHeightRatio:1.0,
  ocrCenterYOffsetRatio:0
};

function v433CalibrateAnchor(core){
  const w=Math.max(1,Number(core?.w)||1);
  const h=Math.max(1,Number(core?.h)||1);
  const ax=Number(core.x)+w+Math.round(w*V433_GEOMETRY_CALIBRATION.anchorOffsetXRatio);
  const ay=Number(core.y)+h+Math.round(h*V433_GEOMETRY_CALIBRATION.anchorOffsetYRatio);
  return {x:Math.round(ax),y:Math.round(ay),
    deltaX:Math.round(w*V433_GEOMETRY_CALIBRATION.anchorOffsetXRatio),
    deltaY:Math.round(h*V433_GEOMETRY_CALIBRATION.anchorOffsetYRatio)};
}

function v435Median(a){
  const v=a.filter(Number.isFinite).slice().sort((x,y)=>x-y);
  if(!v.length)return 0;
  const m=Math.floor(v.length/2);
  return v.length%2?v[m]:(v[m-1]+v[m])/2;
}

function v435GridScore(candidates, seedX, seedY, pitch, width, height){
  const sizes=candidates.map(c=>Math.max(1,(Number(c.w)||1)+(Number(c.h)||1))/2);
  const medSize=Math.max(1,v435Median(sizes));
  const xTol=Math.max(8,Math.min(48,medSize*0.95));
  const yTol=Math.max(10,Math.min(60,medSize*0.90));
  const picks=[];
  let xErr=0,pitchErr=0,matched=0;
  for(let i=0;i<9;i++){
    const targetY=seedY+pitch*i;
    let best=null,bestCost=Infinity;
    for(const c of candidates){
      const cx=c.x+c.w*.5,cy=c.y+c.h*.5;
      const dx=Math.abs(cx-seedX),dy=Math.abs(cy-targetY);
      if(dx>xTol||dy>yTol)continue;
      const cost=(dx/xTol)*(dx/xTol)+(dy/yTol)*(dy/yTol)-Math.min(.25,Number(c.score)||0)*.1;
      if(cost<bestCost){bestCost=cost;best=c;}
    }
    if(best && !picks.includes(best)){
      picks.push(best);matched++;
      const cx=best.x+best.w*.5,cy=best.y+best.h*.5;
      xErr+=Math.abs(cx-seedX)/xTol;
      const prev = picks.length >= 2 ? picks[picks.length - 2] : null;
      if(prev && Number.isFinite(prev.y) && Number.isFinite(prev.h)){
        const py=prev.y+prev.h*.5;
        pitchErr+=Math.abs((cy-py)-pitch)/Math.max(1,pitch);
      }
    }
  }
  const coverage=matched/9;
  const xConsistency=matched?Math.max(0,1-xErr/matched):0;
  const pitchConsistency=matched>1?Math.max(0,1-pitchErr/Math.max(1,matched-1)):0;
  const score=coverage*.62+xConsistency*.20+pitchConsistency*.18;
  return {score,matched,picks,coverage,xConsistency,pitchConsistency,xTol,yTol};
}

function v435FindVerticalGrid(candidates,width,height){
  if(candidates.length<9)return {ok:false,reason:'候補数9未満',score:0,matched:0};
  const usable=candidates.slice().filter(c=>Number.isFinite(c.x)&&Number.isFinite(c.y)&&c.w>0&&c.h>0);
  if(usable.length<9)return {ok:false,reason:'有効候補9未満',score:0,matched:0};
  const medH=Math.max(1,v435Median(usable.map(c=>c.h)));
  const medW=Math.max(1,v435Median(usable.map(c=>c.w)));
  const seeds=[];
  // RANSAC-like seeds: every pair proposes a 1..8-row separation.
  for(let a=0;a<usable.length;a++)for(let b=a+1;b<usable.length;b++){
    const ca=usable[a],cb=usable[b];
    const xa=ca.x+ca.w*.5,xb=cb.x+cb.w*.5;
    const ya=ca.y+ca.h*.5,yb=cb.y+cb.h*.5;
    const dx=Math.abs(xa-xb),dy=Math.abs(yb-ya);
    if(dy<Math.max(2*medH,24))continue;
    if(dx>Math.max(12,2.0*medW))continue;
    for(let steps=1;steps<=8;steps++){
      const pitch=dy/steps;
      if(pitch<Math.max(1.65*medH,45)||pitch>Math.min(height/4,7.0*medH))continue;
      const y0=steps===1?Math.min(ya,yb):Math.min(ya,yb);
      seeds.push({x:(xa+xb)/2,y:y0,pitch});
      seeds.push({x:(xa+xb)/2,y:Math.max(0,Math.max(ya,yb)-pitch*steps),pitch});
    }
  }
  // Add simple median-X / pair-derived seeds so sparse detections remain testable.
  const medianX=v435Median(usable.map(c=>c.x+c.w*.5));
  const ys=usable.map(c=>c.y+c.h*.5).sort((a,b)=>a-b);
  for(let i=0;i<ys.length;i++)for(let j=i+1;j<ys.length;j++){
    const dy=ys[j]-ys[i];
    for(let steps=1;steps<=8;steps++){
      const pitch=dy/steps;
      if(pitch>=Math.max(1.65*medH,45)&&pitch<=Math.min(height/4,7.0*medH)){
        for(let k=0;k<9;k++){
          const y=ys[i]-pitch*k;
          if(y>=0&&y<=height){seeds.push({x:medianX,y,pitch});}
        }
      }
    }
  }
  let best=null;
  const seen=new Set();
  for(const seed of seeds){
    const key=`${Math.round(seed.x/4)}:${Math.round(seed.y/4)}:${Math.round(seed.pitch/4)}`;
    if(seen.has(key))continue;seen.add(key);
    const r=v435GridScore(usable,seed.x,seed.y,seed.pitch,width,height);
    if(!best||r.score>best.score)best={...r,seed};
  }
  if(!best)return {ok:false,reason:'グリッド候補なし',score:0,matched:0};
  // Strict acceptance: a valid equipment column must contain all 9 rows.
  if(best.matched<9)return {...best,ok:false,reason:`9行中${best.matched}行しか整合しません`};
  const chosen=best.picks.slice().sort((a,b)=>(a.y+a.h/2)-(b.y+b.h/2));
  // Final strict geometry checks.
  const centers=chosen.map(c=>({x:c.x+c.w/2,y:c.y+c.h/2}));
  const xMed=v435Median(centers.map(p=>p.x));
  const xResidual=Math.max(...centers.map(p=>Math.abs(p.x-xMed)));
  const gaps=[];for(let i=1;i<centers.length;i++)gaps.push(centers[i].y-centers[i-1].y);
  const pitchMed=v435Median(gaps);
  const pitchSd=Math.sqrt(v435Median(gaps.map(g=>(g-pitchMed)*(g-pitchMed))));
  const strictXTol=Math.max(10,Math.min(55,v435Median(chosen.map(c=>c.w))*1.2));
  const strictPitchTol=Math.max(12,pitchMed*.16);
  if(xResidual>strictXTol||gaps.some(g=>Math.abs(g-pitchMed)>strictPitchTol)){
    return {...best,ok:false,reason:`最終幾何条件不成立（X偏差${xResidual.toFixed(1)}px / pitch=${pitchMed.toFixed(1)}px）`,xResidual,pitch:pitchMed,pitchSd};
  }
  return {...best,ok:true,reason:'9行縦列構造成立',chosen,xResidual,pitch:pitchMed,pitchSd};
}

function v433BuildRows(candidates,width,height){
  const grid=v435FindVerticalGrid(candidates,width,height);
  if(!grid.ok)return null;
  const ordered=grid.chosen.slice().sort((a,b)=>a.y-b.y);
  const rows=ordered.map((c,i)=>{
    const t=V400_ICON_TARGETS[i];
    const icon={x:c.x,y:c.y,w:c.w,h:c.h};
    const calibrated=v433CalibrateAnchor(icon);
    const ocr=clampRectToImage({
      x:calibrated.x,
      y:calibrated.y-icon.h*0.5+icon.h*V433_GEOMETRY_CALIBRATION.ocrCenterYOffsetRatio,
      width:icon.w*V433_GEOMETRY_CALIBRATION.ocrWidthRatio,
      height:icon.h*V433_GEOMETRY_CALIBRATION.ocrHeightRatio,
      source:'v4.3.5-core-grid-db-geometry'
    },width,height);
    return {key:t.key,label:t.label,row:i,icon,
      anchor:{x:calibrated.x,y:calibrated.y,deltaX:calibrated.deltaX,deltaY:calibrated.deltaY},
      ocr:{x:ocr.x,y:ocr.y,w:ocr.width,h:ocr.height},candidate:c};
  });
  return {rows,anchor:{...rows[0].icon,name:'core基準＋縦列Grid＋DB geometry補正',score:rows[0].candidate.score,row:0},
    topPitch:grid.pitch,armorPitch:grid.pitch,grid,
    calibration:{profile:'core→vertical-grid→virtual-icon-bottom-right',offsetXRatio:V433_GEOMETRY_CALIBRATION.anchorOffsetXRatio,offsetYRatio:V433_GEOMETRY_CALIBRATION.anchorOffsetYRatio,ocrWidthRatio:V433_GEOMETRY_CALIBRATION.ocrWidthRatio,ocrHeightRatio:V433_GEOMETRY_CALIBRATION.ocrHeightRatio},
    slotX:null,ocrRight:Math.max(...rows.map(r=>r.ocr.x+r.ocr.w)),detectionMode:'dark-component-ransac-grid',dbRole:'geometry-calibration-only'};
}

function v432Draw(img,grid,cands){
  const host=$('iconAnchorStage'),c=$('iconAnchorView');host.style.display='block';
  const iw=img.naturalWidth||img.width,ih=img.naturalHeight||img.height;c.width=iw;c.height=ih;
  const ctx=c.getContext('2d');ctx.clearRect(0,0,iw,ih);ctx.drawImage(img,0,0);
  cands.forEach((q,i)=>{
    ctx.strokeStyle=i<9?'#00d5ff':'#888';ctx.lineWidth=2;ctx.strokeRect(q.x,q.y,q.w,q.h);
    ctx.fillStyle='#00d5ff';ctx.font='bold 14px sans-serif';ctx.fillText(`#${i+1}`,q.x,q.y-4);
  });
  if(grid){for(const r of grid.rows){ctx.strokeStyle='#ff3b30';ctx.lineWidth=3;ctx.strokeRect(r.icon.x,r.icon.y,r.icon.w,r.icon.h);ctx.strokeStyle='#ffd000';ctx.lineWidth=3;ctx.strokeRect(r.ocr.x,r.ocr.y,r.ocr.w,r.ocr.h);ctx.fillStyle='#ff3b30';ctx.font='bold 14px sans-serif';ctx.fillText(`${r.row+1}:${r.label}`,r.icon.x,r.icon.y-6);ctx.fillStyle='#9cff57';ctx.beginPath();ctx.arc(r.anchor.x,r.anchor.y,4,0,Math.PI*2);ctx.fill();}}
}

function v432Render(cands,grid){
  const dbCount=v400IconItems.length;
  const head=`<div class="result ok"><b>v4.3.8 短辺基準スケール適応＋フルアイコン枠検出＋左端15%＋縦列Grid検証</b><br><span class="mono">DB一致検索=0回 / DB geometry samples=${dbCount} / 縦列Grid/RANSAC検証 / 実画像座標・左端15%基準＋アイコン全体探索 / DB役割=geometry-calibration-only</span></div>`;
  const candText=cands.map((c,i)=>`${i+1}. core (${c.x},${c.y}) ${c.w}x${c.h} / score=${c.score.toFixed(4)}`).join('\n');
  const scaleText=`scene=${cands.sceneWidth||'-'}×${cands.sceneHeight||'-'}px / 短辺=${cands.shortSide||'-'}px / 短辺基準=${cands.scaleBasis||'-'} / scale=${Number(cands.scale||0).toFixed(3)} / 左端基準X=${cands.searchXMax||'-'}px (15%) / 実探索X終端=${cands.searchXEnd||'-'}px / アイコン枠=${cands.coreRange?`${cands.coreRange.minW}～${cands.coreRange.maxW} × ${cands.coreRange.minH}～${cands.coreRange.maxH}px`:'-'}`;
  let html=head+`<div class="result"><b>サイズ補正</b><div class="mono">${scaleText}</div></div><div class="result"><b>検出候補 ${cands.length}個</b><div class="mono">${candText||'候補なし'}</div></div>`;
  if(grid){
    html+=`<div class="result"><b>縦列Grid検証＋Geometry補正</b><div class="mono">matched=${grid.grid.matched}/9 / score=${grid.grid.score.toFixed(3)} / X偏差=${grid.grid.xResidual.toFixed(1)}px / pitch=${grid.grid.pitch.toFixed(1)}px / pitchSD=${grid.grid.pitchSd.toFixed(1)}px<br>core→anchor: +${grid.calibration.offsetXRatio}W / +${grid.calibration.offsetYRatio}H / OCR幅=${grid.calibration.ocrWidthRatio}W / OCR高=${grid.calibration.ocrHeightRatio}H</div></div>`;
    html+=`<div class="result"><b>9行生成</b><div class="mono">${grid.rows.map(r=>`${r.row+1}. ${r.label}: core (${r.icon.x},${r.icon.y}) ${r.icon.w}x${r.icon.h} / anchor (${r.anchor.x},${r.anchor.y}) Δ(+${r.anchor.deltaX},+${r.anchor.deltaY}) / OCR (${r.ocr.x},${r.ocr.y}) ${r.ocr.w}x${r.ocr.h}`).join('\n')}</div></div>`;
  }else{
    html+=`<div class="result warn"><b>縦列Gridが成立しないため装備部位への割り当ては行いません。</b><br>${grid&&grid.grid?`候補=${cands.length}個 / 整合=${grid.grid.matched||0}/9 / 理由=${grid.grid.reason||"幾何条件不成立"}`:`候補=${cands.length}個 / 理由=9行縦列を構成できません`}<br>誤った9行生成で後続OCRを壊さない設計です。</div>`;
  }
  $('iconAnchorOut').innerHTML=html;
}

async function v432Detect(){
  if(!$('img').src){$('iconAnchorStatus').textContent='先に画像を選択してください。';return}
  const btn=$('detectIconAnchor');btn.disabled=true;const t0=performance.now();
  try{
    $('iconAnchorStatus').textContent='画面左側からアイコン候補を検出→9行縦列Gridを検証中…';
    const scene=v400ImageData($('img'));
    const cands=v432DetectIconComponents(scene);
    const grid=v433BuildRows(cands,scene.w,scene.h);
    v432Draw($('img'),grid,cands);
    v432Render(cands,grid);
    if(grid){
      v400IconCandidates=cands.slice(0,9).map((c,i)=>({...c,name:`検出アイコン${i+1}`,row:i}));
      v400IconGrid=grid;window.v400IconGrid=grid;window.lastEquipmentRegions=v400RegionsFromGrid(grid);
      $('recognizeEquipment').disabled=false;
      $('layoutStatus').textContent='v4.3.8：9個のアイコン枠＋短辺基準スケール適応＋縦列Grid検証＋DB geometry補正が成立';
      $('iconAnchorStatus').textContent=`完了：アイコン候補${cands.length}個 / 9行生成 / ${(performance.now()-t0).toFixed(0)}ms / DB一致検索0回  / 縦列Grid pitch評価 / 短辺基準スケール＋実画像座標＋左端15%＋フルアイコン枠＋縦列Grid検証＋geometry補正`;
    }else{
      v400IconCandidates=[];v400IconGrid=null;window.lastEquipmentRegions=[];$('recognizeEquipment').disabled=true;
      $('iconAnchorStatus').textContent=`完了：アイコン候補${cands.length}個 / 9個未成立 / ${(performance.now()-t0).toFixed(0)}ms / DB一致検索0回  / 縦列Grid pitch評価 / 短辺基準スケール＋実画像座標＋左端15%＋フルアイコン枠＋縦列Grid検証`;
    }
  }catch(e){console.error(e);$('iconAnchorStatus').textContent='アイコン検出エラー：'+e.message}
  finally{btn.disabled=false}
}
// ==============================
// ==============================
// v4.4.1 coordinate audit retained in v4.4.2
// ==============================
function auditCoordinates(){
  const im=$('img');
  if(!im || !im.src){
    $('coordinateAuditStatus').textContent='先に画像を選択してください。';
    return;
  }
  const rawW=Number(im.naturalWidth||im.width);
  const rawH=Number(im.naturalHeight||im.height);

  // Exact analysis path used by v4.4.0:
  // natural size -> same-size canvas -> ImageData.
  const c=document.createElement('canvas');
  c.width=rawW; c.height=rawH;
  const ctx=c.getContext('2d',{willReadFrequently:true});
  ctx.drawImage(im,0,0);
  const id=ctx.getImageData(0,0,rawW,rawH);

  const rect=im.getBoundingClientRect();
  const top=$('topDownView');
  const topRect=top?top.getBoundingClientRect():null;
  const r=window.topDownGridResult||null;

  const sceneW=r?.sceneWidth ?? null;
  const sceneH=r?.sceneHeight ?? null;
  const sx=(sceneW&&rawW)?rawW/sceneW:null;
  const sy=(sceneH&&rawH)?rawH/sceneH:null;
  const pitchNorm=(r?.pitch&&sceneH)?r.pitch/sceneH:null;

  const lines=[
    `RAW IMAGE       natural=${rawW}×${rawH}`,
    `IMG CSS         client=${rect.width.toFixed(1)}×${rect.height.toFixed(1)}`,
    `ANALYSIS        ImageData=${id.width}×${id.height}`,
    `RAW→ANALYSIS    X=${(id.width/rawW).toFixed(6)} / Y=${(id.height/rawH).toFixed(6)}`,
    `TOPDOWN CANVAS  buffer=${top?top.width+'×'+top.height:'-'} / CSS=${topRect?topRect.width.toFixed(1)+'×'+topRect.height.toFixed(1):'-'}`,
    `GRID SOURCE     ${sceneW&&sceneH?sceneW+'×'+sceneH:'未実行'}`,
    `GRID→RAW        ${sx!==null?'X='+sx.toFixed(6)+' / Y='+sy.toFixed(6):'未算出'}`,
    `GRID NORMALIZED ${pitchNorm!==null?'pitch/H='+pitchNorm.toFixed(6):'未実行'}`
  ];

  const mismatch=sceneW&&sceneH&&(sceneW!==rawW||sceneH!==rawH);
  $('coordinateAuditStatus').textContent=mismatch
    ? '要確認：Gridの座標系とRaw画像サイズが一致していません。'
    : '監査完了：Raw画像と解析ImageDataの座標を確認しました。';

  let out=`<div class="result ${mismatch?'warn':'ok'}"><b>=== 座標系 統合監査ログ ===</b><div class="mono">${lines.join('\n')}</div></div>`;

  if(r?.ok){
    out+=`<div class="result"><b>Grid境界 / 9行</b><div class="mono">境界=${(r.separators||[]).join(', ')}
pitch=${Number(r.pitch).toFixed(3)}
9行=${(r.rows||[]).map(x=>`${x.row+1}: y=${x.y}, h=${x.height}`).join(' / ')}</div></div>`;
  }
  $('coordinateAuditOut').innerHTML=out;
  return {rawW,rawH,analysisW:id.width,analysisH:id.height,sceneW,sceneH,sx,sy,pitchNorm};
}
$('auditCoordinates').onclick=()=>{
  try{auditCoordinates()}catch(e){
    console.error(e);
    $('coordinateAuditStatus').textContent='座標監査エラー：'+e.message;
  }
};
// ==============================
// v4.4.2 Top-down equipment-row detector
// Coordinate rule: RAW image pixels only.
// Core idea:
//   1) find the left equipment-panel candidate width from vertical luminance structure
//   2) inside each candidate panel width, score a 10-boundary / 9-row grid
//   3) use long horizontal separator occupancy rather than generic edge magnitude
//   4) require all 9 rows to stay inside the image
//   5) reject grids whose normalized pitch/span are implausible
// No icon DB matching is used here.
// ==============================
function tdClamp(v,a,b){return Math.max(a,Math.min(b,v));}
function tdMedian(a){const v=a.filter(Number.isFinite).slice().sort((x,y)=>x-y);if(!v.length)return 0;const m=Math.floor(v.length/2);return v.length%2?v[m]:(v[m-1]+v[m])/2;}
function tdSmooth(a,r){if(r<=0)return a.slice();const out=new Float64Array(a.length);for(let i=0;i<a.length;i++){let st=Math.max(0,i-r),en=Math.min(a.length-1,i+r),s=0;for(let j=st;j<=en;j++)s+=a[j];out[i]=s/(en-st+1);}return out;}
function tdPercentile(a,p){const v=Array.from(a).filter(Number.isFinite).sort((x,y)=>x-y);if(!v.length)return 0;const k=tdClamp(Math.round((v.length-1)*p),0,v.length-1);return v[k];}

function tdHorizontalOccupancy(src,x0,x1,threshold){
  const w=src.w,h=src.h,d=src.data;
  const p=new Float32Array(h);
  const span=Math.max(1,x1-x0);
  for(let y=1;y<h;y++){
    let hit=0;
    for(let x=x0;x<x1;x++){
      const i=(y*w+x)*4, j=((y-1)*w+x)*4;
      const a=.299*d[i]+.587*d[i+1]+.114*d[i+2];
      const b=.299*d[j]+.587*d[j+1]+.114*d[j+2];
      if(Math.abs(a-b)>=threshold)hit++;
    }
    p[y]=hit/span;
  }
  return p;
}

function tdHorizontalMeanGradient(src,x0,x1){
  const w=src.w,h=src.h,d=src.data,p=new Float32Array(h),span=Math.max(1,x1-x0);
  for(let y=1;y<h;y++){
    let s=0;
    for(let x=x0;x<x1;x++){
      const i=(y*w+x)*4,j=((y-1)*w+x)*4;
      const a=.299*d[i]+.587*d[i+1]+.114*d[i+2];
      const b=.299*d[j]+.587*d[j+1]+.114*d[j+2];
      s+=Math.abs(a-b);
    }
    p[y]=s/span;
  }
  return p;
}

function tdVerticalMeanGradient(src){
  const w=src.w,h=src.h,d=src.data,p=new Float32Array(w);
  const y0=Math.max(1,Math.round(h*.08)),y1=Math.min(h-1,Math.round(h*.92));
  for(let x=1;x<w;x++){
    let s=0;
    for(let y=y0;y<y1;y++){
      const i=(y*w+x)*4,j=(y*w+x-1)*4;
      const a=.299*d[i]+.587*d[i+1]+.114*d[i+2];
      const b=.299*d[j]+.587*d[j+1]+.114*d[j+2];
      s+=Math.abs(a-b);
    }
    p[x]=s/Math.max(1,y1-y0);
  }
  return p;
}

function tdCandidatePanelXs(src){
  const w=src.w, vp=tdVerticalMeanGradient(src);
  const lo=Math.max(1,Math.round(w*.10)), hi=Math.min(w-2,Math.round(w*.75));
  const peaks=[];
  for(let x=lo+1;x<hi-1;x++){
    if(vp[x]>=vp[x-1]&&vp[x]>=vp[x+1])peaks.push({x,score:vp[x]});
  }
  peaks.sort((a,b)=>b.score-a.score);
  const kept=[];
  const minDist=Math.max(8,Math.round(w*.018));
  for(const p of peaks){
    if(kept.every(q=>Math.abs(q.x-p.x)>=minDist))kept.push(p);
    if(kept.length>=18)break;
  }
  // A few normalized probes protect against a weak panel edge.
  for(const f of [.14,.18,.22,.28,.34,.42,.52,.62,.70]){
    const x=Math.round(w*f);
    if(x>=lo&&x<=hi&&kept.every(q=>Math.abs(q.x-x)>=minDist))kept.push({x,score:vp[x]||0});
  }
  kept.sort((a,b)=>a.x-b.x);
  return {candidates:kept,profile:vp};
}

function tdFindPeaks(profile,minY,maxY,minDist,threshold){
  const peaks=[];
  for(let y=Math.max(1,minY);y<=Math.min(profile.length-2,maxY);y++){
    const v=profile[y];
    if(v<threshold||v<profile[y-1]||v<profile[y+1])continue;
    peaks.push({y,score:v});
  }
  peaks.sort((a,b)=>b.score-a.score);
  const kept=[];
  for(const p of peaks){
    if(kept.every(q=>Math.abs(q.y-p.y)>=minDist))kept.push(p);
  }
  return kept.sort((a,b)=>a.y-b.y);
}

function tdBestGridForPanel(src,panelX){
  const w=src.w,h=src.h,x0=Math.max(1,Math.round(w*.018)),x1=Math.max(x0+20,panelX);
  const minPitch=h*.070,maxPitch=h*.095;
  const thresholdSet=[8,16,24];
  let best=null;

  for(const threshold of thresholdSet){
    const occ=tdSmooth(tdHorizontalOccupancy(src,x0,x1,threshold),Math.max(1,Math.round(Math.min(w,h)/900)));
    const mean=tdSmooth(tdHorizontalMeanGradient(src,x0,x1),Math.max(1,Math.round(Math.min(w,h)/900)));
    const occQ=tdPercentile(Array.from(occ).slice(Math.round(h*.05),Math.round(h*.95)),.85)||1;
    const meanQ=tdPercentile(Array.from(mean).slice(Math.round(h*.05),Math.round(h*.95)),.90)||1;

    // Ten boundaries describe nine rows: top edge + 8 internal separators + bottom edge.
    // Outer edges may be weaker; internal separators carry most of the score.
    const pitchSteps=72, ySteps=100;
    for(let pi=0;pi<=pitchSteps;pi++){
      const pitch=minPitch+(maxPitch-minPitch)*pi/pitchSteps;
      const yMin=h*.08, yMax=Math.min(h*.22,h-pitch*9.2);
      for(let yi=0;yi<=ySteps;yi++){
        const y0=yMin+(yMax-yMin)*yi/ySteps;
        const ys=new Array(10);
        for(let k=0;k<10;k++)ys[k]=y0+pitch*k;
        if(ys[0]<0||ys[9]>=h)continue;

        let score=0,residual=0;
        const vals=[];
        for(let k=0;k<10;k++){
          const target=ys[k];
          const radius=Math.max(2,Math.round(pitch*.018));
          const lo=Math.max(1,Math.floor(target-radius));
          const hi=Math.min(h-2,Math.ceil(target+radius));
          let bestY=lo,bestV=-1;
          for(let y=lo;y<=hi;y++){
            // Occupancy is the primary separator signal; mean gradient is secondary.
            const v=.72*Math.min(1,occ[y]/Math.max(.05,occQ))+
                    .28*Math.min(1,mean[y]/Math.max(1,meanQ));
            if(v>bestV){bestV=v;bestY=y;}
          }
          vals.push(bestV);
          residual+=Math.abs(bestY-target)/Math.max(1,pitch);
          score += bestV*(k===0||k===9?0.45:1.0);
        }

        const internalMean=vals.slice(1,9).reduce((a,b)=>a+b,0)/8;
        const outerMean=(vals[0]+vals[9])/2;
        const internalMin=Math.min(...vals.slice(1,9));
        const fit=Math.max(0,1-residual/10);
        const consistency=Math.max(0,1-(Math.max(...vals.slice(1,9))-Math.min(...vals.slice(1,9))));
        const normalizedPitch=pitch/h;
        const pitchPrior=Math.max(0,1-Math.abs(normalizedPitch-.083)/.018);
        const spanPrior=Math.max(0,1-Math.abs((pitch*8/h)-.666)/.145);

        const total =
          internalMean*0.52 +
          internalMin*0.18 +
          fit*0.10 +
          consistency*0.06 +
          pitchPrior*0.08 +
          spanPrior*0.06 +
          outerMean*0.03;

        if(!best||total>best.score){
          best={score:total,panelX,pitch,y0,ys,vals,residual,internalMean,internalMin,
            normalizedPitch,span:pitch*8/h,threshold};
        }
      }
    }
  }
  return best;
}

function tdValidateGrid(g,src){
  if(!g)return {ok:false,reason:'Grid候補なし'};
  const h=src.h,w=src.w;
  const rows=[];
  for(let i=0;i<9;i++){
    const y=Math.round(g.y0+g.pitch*i);
    const bottom=Math.round(y+g.pitch);
    if(y<0||bottom>h)return {ok:false,reason:`行${i+1}が画像外（y=${y}, bottom=${bottom}, H=${h}）`,candidate:g};
    rows.push({
      row:i,
      label:['メイン武器','サブ武器','頭防具','胴防具','腕防具','腰防具','脚防具','護石','装衣'][i],
      x:Math.round(w*.018),
      y,
      width:Math.max(1,Math.round(g.panelX-w*.018)),
      height:Math.round(g.pitch)
    });
  }
  if(g.normalizedPitch<.070||g.normalizedPitch>.095)
    return {ok:false,reason:`正規化pitch範囲外（pitch/H=${g.normalizedPitch.toFixed(4)}）`,candidate:g};
  if(g.span<.56||g.span>.78)
    return {ok:false,reason:`9行全体の高さが不自然（8pitch/H=${g.span.toFixed(4)}）`,candidate:g};
  if(g.internalMin<.42)
    return {ok:false,reason:`内部境界の連続性不足（min=${g.internalMin.toFixed(2)}）`,candidate:g};
  if(g.internalMean<.58)
    return {ok:false,reason:`内部境界の平均強度不足（mean=${g.internalMean.toFixed(2)}）`,candidate:g};
  if(g.score<.64)
    return {ok:false,reason:`Grid総合スコア不足（${g.score.toFixed(3)}）`,candidate:g};
  return {ok:true,rows};
}

function tdDetectTopDown(src){
  const pc=tdCandidatePanelXs(src);
  const trials=[];
  for(const p of pc.candidates){
    const g=tdBestGridForPanel(src,p.x);
    if(g)trials.push(g);
  }
  trials.sort((a,b)=>b.score-a.score);

  for(const g of trials){
    const v=tdValidateGrid(g,src);
    if(v.ok){
      return {
        ok:true,
        sceneWidth:src.w,sceneHeight:src.h,
        profileX:[Math.round(src.w*.018),g.panelX],
        smoothRadius:Math.max(1,Math.round(Math.min(src.w,src.h)/900)),
        separators:g.ys.slice(1,9).map(y=>Math.round(y)),
        boundaries:g.ys.map(y=>Math.round(y)),
        pitch:g.pitch,pitchSd:0,
        rows:v.rows,top:g.y0,bottom:g.y0+g.pitch*9,
        panelX:g.panelX,panelWidth:g.panelX-Math.round(src.w*.018),
        score:g.score,internalMean:g.internalMean,internalMin:g.internalMin,
        normalizedPitch:g.normalizedPitch,span:g.span,threshold:g.threshold,
        panelCandidates:pc.candidates.map(p=>({x:p.x,score:p.score})),
        rejectedCandidates:trials.filter(x=>x!==g).slice(0,8).map(x=>({panelX:x.panelX,score:x.score,pitch:x.pitch,y0:x.y0}))
      };
    }
  }
  const top=trials[0];
  return {
    ok:false,
    sceneWidth:src.w,sceneHeight:src.h,
    profileX:[Math.round(src.w*.018),top?.panelX||Math.round(src.w*.2)],
    smoothRadius:Math.max(1,Math.round(Math.min(src.w,src.h)/900)),
    reason:top ? tdValidateGrid(top,src).reason : '候補Gridなし',
    candidate:top||null,
    panelCandidates:pc.candidates.map(p=>({x:p.x,score:p.score}))
  };
}

function tdDraw(img,result){
  const host=$('topDownStage'),c=$('topDownView');host.style.display='block';
  const iw=img.naturalWidth||img.width,ih=img.naturalHeight||img.height;c.width=iw;c.height=ih;
  const ctx=c.getContext('2d');ctx.clearRect(0,0,iw,ih);ctx.drawImage(img,0,0);
  if(!result||!result.ok)return;
  for(const y of result.boundaries){
    ctx.strokeStyle='#ff3b30';ctx.lineWidth=Math.max(2,Math.round(Math.min(iw,ih)/500));
    ctx.beginPath();ctx.moveTo(result.profileX[0],y);ctx.lineTo(result.panelX,y);ctx.stroke();
  }
  result.rows.forEach(r=>{
    ctx.strokeStyle='#00d5ff';ctx.lineWidth=2;ctx.strokeRect(r.x,r.y,r.width,r.height);
    ctx.fillStyle='#ffd000';ctx.font=`bold ${Math.max(12,Math.round(Math.min(iw,ih)/55))}px sans-serif`;
    ctx.fillText(`${r.row+1}:${r.label}`,r.x+4,r.y+18);
  });
  ctx.strokeStyle='#00ff80';ctx.lineWidth=Math.max(2,Math.round(Math.min(iw,ih)/450));
  ctx.strokeRect(result.profileX[0],result.top,result.panelWidth,result.bottom-result.top);
}

function tdRender(result){
  if(!result){$('topDownOut').innerHTML='';return;}
  const base=`<div class="result ok"><b>v4.4.2 トップダウン装備9行グリッド</b><br><span class="mono">アイコン検出=0回 / DB一致検索=0回 / 10境界候補→9行検証 / RAW座標のみ</span></div>`;
  const scene=`<div class="result"><b>入力座標</b><div class="mono">raw=${result.sceneWidth||'-'}×${result.sceneHeight||'-'}px / 解析X=${result.profileX?result.profileX[0]+'～'+result.profileX[1]:'-'} / 平滑化半径=${result.smoothRadius||'-'}px</div></div>`;
  if(!result.ok){
    $('topDownOut').innerHTML=base+scene+`<div class="result warn"><b>9行グリッド未成立</b><div class="mono">${result.reason||'不成立'}<br>${result.candidate?`候補: panelX=${Math.round(result.candidate.panelX)}, pitch=${result.candidate.pitch.toFixed(1)}, pitch/H=${result.candidate.normalizedPitch.toFixed(4)}, score=${result.candidate.score.toFixed(3)}`:''}</div></div>`;
    return;
  }
  const rows=result.rows.map(r=>`${r.row+1}. ${r.label}: x=${r.x}, y=${r.y}, ${r.width}×${r.height}`).join('\n');
  const cand=(result.panelCandidates||[]).map(p=>`${p.x}(${p.score.toFixed(1)})`).join(', ');
  $('topDownOut').innerHTML=base+scene+
    `<div class="result"><b>装備UI領域</b><div class="mono">panelX=${result.panelX} / panelWidth=${result.panelWidth} / GridScore=${result.score.toFixed(3)} / 境界強度mean=${result.internalMean.toFixed(2)} min=${result.internalMin.toFixed(2)}</div></div>`+
    `<div class="result"><b>Yグリッド</b><div class="mono">内部境界8本=${result.separators.join(', ')}<br>pitch=${result.pitch.toFixed(1)}px / pitch/H=${result.normalizedPitch.toFixed(4)} / 8pitch/H=${result.span.toFixed(4)}<br>10境界=${result.boundaries.join(', ')}</div></div>`+
    `<div class="result"><b>パネル候補X</b><div class="mono">${cand}</div></div>`+
    `<div class="result"><b>生成された9行</b><div class="mono">${rows}</div></div>`;
}

async function tdRun(){
  if(!$('img').src){$('topDownStatus').textContent='先に画像を選択してください。';return;}
  const btn=$('detectTopDownGrid');btn.disabled=true;const t0=performance.now();
  try{
    $('topDownStatus').textContent='装備UI領域→10境界→9行Gridを総当たり検証中（速度より正確性優先）…';
    const scene=v400ImageData($('img'));
    const result=tdDetectTopDown(scene);
    tdDraw($('img'),result);tdRender(result);
    $('topDownStatus').textContent=result.ok
      ? `完了：9行グリッド成立 / ${(performance.now()-t0).toFixed(0)}ms / アイコン検出0回 / DB一致0回`
      : `完了：9行グリッド未成立 / ${(performance.now()-t0).toFixed(0)}ms / ${result.reason||'不成立'}`;
    window.topDownGridResult=result;
  }catch(e){console.error(e);$('topDownStatus').textContent='トップダウン検出エラー：'+e.message;}
  finally{btn.disabled=false}
}


// ============================================================
// v4.4.3 Gemini引継ぎ：装備名OCR ROI計算
// - 16:9有効ゲーム領域を先に確定
// - 7部位のみ対象（サブ武器・装衣は除外）
// - 固定pxではなくゲーム領域比率で計算
// - OCR本体への自動接続は、ROI位置検証完了後に行う
// ============================================================
const TARGET_EQUIPMENTS = [
  { key: 'weaponMain', label: 'メイン武器', row: 0, yOffsetRatio: -0.004 },
  { key: 'head',       label: '頭防具',     row: 2, yOffsetRatio:  0.000 },
  { key: 'chest',      label: '胴防具',     row: 3, yOffsetRatio:  0.000 },
  { key: 'arm',        label: '腕防具',     row: 4, yOffsetRatio:  0.000 },
  { key: 'waist',      label: '腰防具',     row: 5, yOffsetRatio:  0.000 },
  { key: 'leg',        label: '脚防具',     row: 6, yOffsetRatio:  0.000 },
  { key: 'charm',      label: '護石',       row: 7, yOffsetRatio:  0.004 }
];

function calculate16by9Area(imgW, imgH) {
  const targetRatio = 16 / 9;
  const currentAspect = imgW / imgH;

  if (currentAspect > targetRatio) {
    // 横長：左右に黒帯相当の余白があるものとして中央16:9を使用
    const gameH = imgH;
    const gameW = imgH * targetRatio;
    const offsetX = (imgW - gameW) / 2;
    return { x: offsetX, y: 0, w: gameW, h: gameH };
  }

  if (currentAspect < targetRatio) {
    // 縦長：上下に黒帯相当の余白があるものとして中央16:9を使用
    const gameW = imgW;
    const gameH = imgW / targetRatio;
    const offsetY = (imgH - gameH) / 2;
    return { x: 0, y: offsetY, w: gameW, h: gameH };
  }

  return { x: 0, y: 0, w: imgW, h: imgH };
}

function calculateEquipmentROIs(imgW, imgH) {
  const gameArea = calculate16by9Area(imgW, imgH);

  const startXRatio = 0.048;
  const startYRatio = 0.147;
  const pitchYRatio = 0.0904;
  const widthRatio = 0.123;
  const heightRatio = 0.032;

  const cropX = gameArea.x + (gameArea.w * startXRatio);
  const cropW = gameArea.w * widthRatio;
  const cropH = gameArea.h * heightRatio;

  const rois = {};
  for (const item of TARGET_EQUIPMENTS) {
    const calculatedYRatio =
      startYRatio +
      (item.row * pitchYRatio) +
      item.yOffsetRatio;

    rois[item.key] = {
      key: item.key,
      label: item.label,
      row: item.row,
      x: Math.round(cropX),
      y: Math.round(gameArea.y + (gameArea.h * calculatedYRatio)),
      w: Math.round(cropW),
      h: Math.round(cropH),
      // 浮動小数点の基準値も保持して監査可能にする
      xExact: cropX,
      yExact: gameArea.y + (gameArea.h * calculatedYRatio),
      wExact: cropW,
      hExact: cropH
    };
  }

  return { gameArea, rois };
}

function equipmentROIValidation(imgW, imgH, result) {
  const errors = [];
  const g = result.gameArea;

  if (!(g.w > 0 && g.h > 0)) errors.push('16:9ゲーム領域が0以下');
  if (Math.abs((g.w / g.h) - (16 / 9)) > 1e-9) errors.push('ゲーム領域のアスペクト比が16:9ではない');

  for (const item of Object.values(result.rois)) {
    if (item.x < 0 || item.y < 0 ||
        item.x + item.w > imgW ||
        item.y + item.h > imgH) {
      errors.push(`${item.label}: ROIが画像外`);
    }
    if (item.x < g.x || item.x + item.w > g.x + g.w ||
        item.y < g.y || item.y + item.h > g.y + g.h) {
      errors.push(`${item.label}: ROIが16:9ゲーム領域外`);
    }
  }

  return errors;
}

function drawEquipmentROIs(img, result) {
  const host = $('equipmentROIStage');
  const canvas = $('equipmentROIView');
  host.style.display = 'block';

  const iw = img.naturalWidth || img.width;
  const ih = img.naturalHeight || img.height;
  canvas.width = iw;
  canvas.height = ih;

  const c = canvas.getContext('2d');
  c.clearRect(0, 0, iw, ih);
  c.drawImage(img, 0, 0);

  // 16:9有効ゲーム領域
  c.strokeStyle = '#00ff80';
  c.lineWidth = Math.max(2, Math.round(Math.min(iw, ih) / 450));
  c.strokeRect(
    Math.round(result.gameArea.x),
    Math.round(result.gameArea.y),
    Math.round(result.gameArea.w),
    Math.round(result.gameArea.h)
  );

  const fontSize = Math.max(12, Math.round(Math.min(iw, ih) / 55));
  c.font = `bold ${fontSize}px sans-serif`;

  for (const item of TARGET_EQUIPMENTS) {
    const r = result.rois[item.key];
    c.strokeStyle = '#00d5ff';
    c.lineWidth = Math.max(2, Math.round(Math.min(iw, ih) / 500));
    c.strokeRect(r.x, r.y, r.w, r.h);

    c.fillStyle = '#00d5ff';
    c.fillText(
      `${r.label} (row ${r.row})`,
      r.x,
      Math.max(fontSize + 2, r.y - 4)
    );
  }
}

function renderEquipmentROIResult(result, selfTestRows = null) {
  const img = $('img');
  const iw = img.naturalWidth || img.width;
  const ih = img.naturalHeight || img.height;
  const errors = equipmentROIValidation(iw, ih, result);

  const g = result.gameArea;
  let html =
    `<div class="result ${errors.length ? 'warn' : 'ok'}">` +
    `<b>v4.5.5 7部位ROI＋装飾品24スロット切出し</b><br>` +
    `<span class="mono">` +
    `入力=${iw}×${ih} / ` +
    `16:9領域=x:${g.x.toFixed(2)}, y:${g.y.toFixed(2)}, ` +
    `w:${g.w.toFixed(2)}, h:${g.h.toFixed(2)}` +
    `</span></div>`;

  html += `<div class="result"><b>ROI座標（7部位）</b><div class="mono">`;
  html += TARGET_EQUIPMENTS.map(item => {
    const r = result.rois[item.key];
    const base = result.baselineROIs?.[item.key];
    const refine = r.refined ? ` / 基準Y=${base?.y ?? r.y}→補正Y=${r.y} (Δ${r.refineDelta>=0?'+':''}${r.refineDelta}px, score=${r.refineScore})` : ` / 補正なし (score=${r.refineScore||0})`;
    return `${item.row}. ${item.label}: x=${r.x}, y=${r.y}, ${r.w}×${r.h}${refine}`;
  }).join('<br>');
  html += `</div></div>`;

  html += `<div class="result"><b>計算比率</b><div class="mono">` +
    `X=4.8% / Y開始=14.7% / pitch=9.04% / W=12.3% / H=3.2% / ` +
    `武器Y補正=-0.4% / 護石Y補正=+0.4%` +
    `</div></div>`;

  if (errors.length) {
    html += `<div class="result warn"><b>ROI検証NG</b><div class="mono">${errors.join('<br>')}</div></div>`;
  } else {
    html += `<div class="result ok"><b>ROI検証OK</b><div class="mono">全7部位が画像内かつ16:9ゲーム領域内に収まっています。</div></div>`;
  }

  if (selfTestRows) {
    html += `<div class="result"><b>サイズ自己検証</b><div class="mono">${selfTestRows.join('<br>')}</div></div>`;
  }

  $('equipmentROIOut').innerHTML = html;
}


function refineEquipmentNameROI(img, baseROI, gameArea) {
  const iw = img.naturalWidth || img.width;
  const ih = img.naturalHeight || img.height;
  const canvas = document.createElement('canvas');
  canvas.width = iw; canvas.height = ih;
  const c = canvas.getContext('2d', {willReadFrequently:true});
  c.drawImage(img, 0, 0);

  // v4.5.1: The base ROI is a layout anchor, not the final OCR crop.
  // In the Wilds equipment UI the category label and equipment name are two
  // lines. The old refinement found the name-line peak correctly, but the
  // downstream crop helper shifted it a second time and often cut the glyphs.
  // Here the detected peak is carried explicitly as nameAnchor so OCR consumes
  // the same band that the refinement actually detected.
  const baseY = Number(baseROI?.yExact ?? baseROI?.y ?? 0);
  const baseH = Number(baseROI?.hExact ?? baseROI?.h ?? gameArea.h*0.032);
  const searchTop = Math.max(gameArea.y, baseY + gameArea.h * 0.012);
  const searchBottom = Math.min(gameArea.y + gameArea.h, baseY + gameArea.h * 0.070);
  const x0 = Math.max(0, Math.floor(baseROI.x));
  const x1 = Math.min(iw, Math.ceil(baseROI.x + baseROI.w));
  const y0 = Math.max(0, Math.floor(searchTop));
  const y1 = Math.min(ih, Math.ceil(searchBottom));
  if (x1 <= x0 || y1 <= y0) return {...baseROI, refined:false, refineScore:0};

  const data = c.getImageData(x0, y0, x1-x0, y1-y0).data;
  const w=x1-x0, h=y1-y0;
  const profile=new Float64Array(h);
  for(let y=0;y<h;y++){
    let hit=0;
    for(let x=0;x<w;x++){
      const i=(y*w+x)*4, r=data[i],g=data[i+1],b=data[i+2];
      const mx=Math.max(r,g,b), mn=Math.min(r,g,b);
      const lum=.299*r+.587*g+.114*b;
      // White/gray glyphs on the dark translucent UI. Keep a second, softer
      // luminance contribution so anti-aliased edges are not discarded.
      if(lum>=125 && (mx-mn)<=68) hit += lum>=160 ? 1.0 : 0.45;
    }
    profile[y]=hit;
  }
  const smooth=new Float64Array(h);
  for(let y=0;y<h;y++){
    let sum=0,n=0;
    for(let k=-2;k<=2;k++){const yy=y+k;if(yy>=0&&yy<h){sum+=profile[yy];n++;}}
    smooth[y]=sum/Math.max(1,n);
  }
  let peak=-1,score=0;
  for(let y=1;y<h-1;y++){
    if(smooth[y]>=smooth[y-1] && smooth[y]>=smooth[y+1] && smooth[y]>score){score=smooth[y];peak=y;}
  }
  if(peak<0 || score<1.5) return {...baseROI, refined:false, refineScore:Number(score.toFixed(2))};

  const peakY=y0+peak;
  // Estimate the glyph band from game height. At 760px this is ~14px; at
  // 2160px it is ~39px, matching the UI text scale much better than baseH.
  const glyphH=Math.max(10, Math.min(gameArea.h*0.022, gameArea.h*0.032));
  const bandH=Math.max(14, glyphH*1.55);
  const bandY=Math.max(gameArea.y, Math.round(peakY-bandH*0.48));
  const refined={
    ...baseROI,
    x:Math.round(baseROI.x), y:bandY,
    w:Math.round(baseROI.w), h:Math.round(bandH),
    xExact:baseROI.x, yExact:bandY, wExact:baseROI.w, hExact:bandH,
    refined:true, baselineY:baseROI.y, refinePeakY:peakY,
    refineScore:Number(score.toFixed(2)), refineDelta:bandY-baseROI.y,
    nameAnchor:{x:baseROI.x,y:bandY,width:baseROI.w,height:bandH}
  };
  if(refined.y<0 || refined.y+refined.h>ih) return {...baseROI, refined:false, refineScore:Number(score.toFixed(2))};
  return refined;
}

function calculateEquipmentROIsRefined(img) {
  const iw = img.naturalWidth || img.width;
  const ih = img.naturalHeight || img.height;
  const base = calculateEquipmentROIs(iw, ih);
  const refined = {};
  for(const item of TARGET_EQUIPMENTS){
    refined[item.key]=refineEquipmentNameROI(img, base.rois[item.key], base.gameArea);
  }
  return {gameArea:base.gameArea, rois:refined, baselineROIs:base.rois};
}

function calculateEquipmentROI() {
  const img = $('img');
  if (!img || !img.src) {
    $('equipmentROIStatus').textContent = '先に画像を選択してください。';
    return;
  }

  try {
    const imgW = Number(img.naturalWidth || img.width);
    const imgH = Number(img.naturalHeight || img.height);
    const result = calculateEquipmentROIsRefined(img);

    drawEquipmentROIs(img, result);
    renderEquipmentROIResult(result);
    window.equipmentROIResult = result;

    const errors = equipmentROIValidation(imgW, imgH, result);
    $('equipmentROIStatus').textContent = errors.length
      ? `ROI算出完了：検証NG ${errors.length}件`
      : `ROI算出完了：7部位 / ${imgW}×${imgH} / 16:9補正済み`;
  } catch (e) {
    console.error(e);
    $('equipmentROIStatus').textContent = 'ROI算出エラー：' + e.message;
  }
}

function runEquipmentROISelfTest() {
  const sizes = [
    [1920,1080],
    [3840,2160],
    [2560,1440],
    [2560,1080],
    [3440,1440],
    [706,1536],
    [1080,1920],
    [1340,760]
  ];

  const rows = [];
  let totalErrors = 0;

  for (const [w,h] of sizes) {
    const result = calculateEquipmentROIs(w,h);
    const errors = equipmentROIValidation(w,h,result);
    totalErrors += errors.length;

    const g = result.gameArea;
    const r = result.rois.weaponMain;
    const c = result.rois.charm;

    rows.push(
      `${w}×${h}: ` +
      `game=${Math.round(g.x)},${Math.round(g.y)},${Math.round(g.w)}×${Math.round(g.h)} / ` +
      `武器=${r.x},${r.y},${r.w}×${r.h} / ` +
      `護石=${c.x},${c.y},${c.w}×${c.h} / ` +
      `${errors.length ? 'NG' : 'OK'}`
    );
  }

  const status = totalErrors === 0
    ? '自己検証完了：8サイズすべてROI範囲OK'
    : `自己検証完了：${totalErrors}件の範囲エラー`;

  $('equipmentROIStatus').textContent = status;

  const img = $('img');
  if (img && img.src) {
    const iw = Number(img.naturalWidth || img.width);
    const ih = Number(img.naturalHeight || img.height);
    const current = calculateEquipmentROIsRefined(img);
    drawEquipmentROIs(img, current);
    renderEquipmentROIResult(current, rows);
    window.equipmentROIResult = current;
  } else {
    $('equipmentROIOut').innerHTML =
      `<div class="result ${totalErrors === 0 ? 'ok' : 'warn'}">` +
      `<b>${status}</b><div class="mono">${rows.join('<br>')}</div></div>`;
  }

  return {totalErrors, rows};
}

function calculateEquipmentROIBase(){
  const img=$('img');
  if(!img || !img.src){$('equipmentROIStatus').textContent='先に画像を選択してください。';return;}
  try{
    const result=calculateEquipmentROIs(img.naturalWidth||img.width,img.naturalHeight||img.height);
    drawEquipmentROIs(img,result);renderEquipmentROIResult(result);window.equipmentROIResult=result;
    $('equipmentROIStatus').textContent='比率ROI（補正前）を表示しました。';
  }catch(e){console.error(e);$('equipmentROIStatus').textContent='基準ROI算出エラー：'+e.message;}
}

// ============================================================
// v4.5.1 装飾品グループ解析
//
// 方針:
// 1) 16:9ゲーム領域を確定
// 2) 左側装飾品パネルの横罫線を画像から検出
// 3) 25本の境界 = 最大24スロットを動的に確定
// 4) 各境界間を1スロットROIとして切り出す
// 5) 実際に珠が入っているかは、この段階では判定しない
// 6) 後段の珠DB照合で「一致 / 対照なし」を決める
//
// 「24行固定のY比率」ではなく、同一画像内の実測境界を使う。
// したがって小さな累積Yズレを24行分積み上げない。
// ============================================================

const DECORATION_SLOT_CONFIG = {
  maxSlots: 24,

  // 16:9ゲーム領域に対する装飾品パネル探索範囲。
  // 今回の1536x864基準画像では概ね x=30～300px に相当。
  panelX0Ratio: 0.020,
  panelX1Ratio: 0.200,
  panelY0Ratio: 0.060,
  panelY1Ratio: 0.880,

  // 行境界の期待ピッチ。基準画像では約26.3px / 864px = 3.04%。
  pitchRatio: 0.0304,
  minPitchRatio: 0.021,
  maxPitchRatio: 0.039,

  // 名前ROIは各境界の内側に少し余白を取る。
  roiInsetRatio: 0.0042,

  // 装飾品名はアイコンの右側から始まる。
  nameXRatio: 0.071,
  nameWidthRatio: 0.125
};

function smooth1D(arr, radius) {
  if (!arr.length) return [];
  const r = Math.max(1, Math.round(radius));
  const out = new Array(arr.length);
  let sum = 0;
  const win = r * 2 + 1;

  for (let i = 0; i < arr.length; i++) {
    sum += arr[Math.min(arr.length - 1, i + r)];
    if (i - r - 1 >= 0) sum -= arr[i - r - 1];

    // 上の簡易窓は端部の重複を含むため、実際の要素数で割る。
    let count = 0;
    const a = Math.max(0, i - r);
    const b = Math.min(arr.length - 1, i + r);
    count = b - a + 1;
    out[i] = sum / count;
  }
  return out;
}

function percentile1D(arr, q) {
  if (!arr.length) return 0;
  const a = Array.from(arr).sort((x, y) => x - y);
  const pos = (a.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return a[lo];
  return a[lo] + (a[hi] - a[lo]) * (pos - lo);
}

function localPeaks1D(values, minDistance, minProminence) {
  const raw = [];
  for (let i = 1; i < values.length - 1; i++) {
    if (values[i] < values[i - 1] || values[i] < values[i + 1]) continue;

    // 簡易prominence:
    // 近傍の低い側との差が小さいノイズピークを落とす。
    const left = Math.max(0, i - Math.max(3, minDistance));
    const right = Math.min(values.length - 1, i + Math.max(3, minDistance));
    let leftMin = values[i];
    let rightMin = values[i];

    for (let k = left; k < i; k++) leftMin = Math.min(leftMin, values[k]);
    for (let k = i + 1; k <= right; k++) rightMin = Math.min(rightMin, values[k]);

    const prominence = values[i] - Math.max(leftMin, rightMin);
    if (prominence >= minProminence) {
      raw.push({ index: i, value: values[i], prominence });
    }
  }

  raw.sort((a, b) => b.value - a.value);

  const selected = [];
  for (const p of raw) {
    if (selected.every(q => Math.abs(q.index - p.index) >= minDistance)) {
      selected.push(p);
    }
  }

  selected.sort((a, b) => a.index - b.index);
  return selected;
}

function detectDecorationBoundariesFromImage(sourceCanvas, gameArea) {
  const W = Math.round(gameArea.w);
  const H = Math.round(gameArea.h);

  const x0 = Math.max(0, Math.floor(gameArea.x + W * DECORATION_SLOT_CONFIG.panelX0Ratio));
  const x1 = Math.min(sourceCanvas.width, Math.ceil(gameArea.x + W * DECORATION_SLOT_CONFIG.panelX1Ratio));
  const y0 = Math.max(0, Math.floor(gameArea.y + H * DECORATION_SLOT_CONFIG.panelY0Ratio));
  const y1 = Math.min(sourceCanvas.height, Math.ceil(gameArea.y + H * DECORATION_SLOT_CONFIG.panelY1Ratio));

  const ctx = sourceCanvas.getContext('2d', { willReadFrequently: true });
  const data = ctx.getImageData(x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0));
  const pw = data.width;
  const ph = data.height;

  // 横罫線は「同一行の上下で画素が急変する」ため、
  // X方向に平均したY方向の輝度差を使う。
  const profile = new Array(Math.max(0, ph - 1)).fill(0);

  for (let y = 0; y < ph - 1; y++) {
    let sum = 0;
    const rowA = y * pw * 4;
    const rowB = (y + 1) * pw * 4;

    for (let x = 0; x < pw; x++) {
      const a = rowA + x * 4;
      const b = rowB + x * 4;

      const la = data.data[a] * 0.299 +
                 data.data[a + 1] * 0.587 +
                 data.data[a + 2] * 0.114;
      const lb = data.data[b] * 0.299 +
                 data.data[b + 1] * 0.587 +
                 data.data[b + 2] * 0.114;

      sum += Math.abs(lb - la);
    }

    profile[y] = sum / pw;
  }

  const smoothed = smooth1D(profile, Math.max(1, H / 900));
  const expectedPitch = H * DECORATION_SLOT_CONFIG.pitchRatio;
  const minPitch = H * DECORATION_SLOT_CONFIG.minPitchRatio;
  const maxPitch = H * DECORATION_SLOT_CONFIG.maxPitchRatio;

  const peakThreshold = Math.max(
    5,
    percentile1D(smoothed, 0.65) * 0.55
  );

  const peaks = localPeaks1D(
    smoothed,
    Math.max(4, Math.round(H * 0.012)),
    Math.max(2, percentile1D(smoothed, 0.55) * 0.20)
  ).filter(p => p.value >= peakThreshold);

  const candidates = peaks.map(p => ({
    y: y0 + p.index,
    strength: p.value,
    prominence: p.prominence
  }));

  // 25境界を選ぶ動的計画。
  // 「25本のピークが見つかったらそれを使う」という決め打ちではなく、
  // 候補が多い場合は24区間のピッチ整合性が最も高い系列を選択する。
  const N = DECORATION_SLOT_CONFIG.maxSlots + 1;
  const M = candidates.length;

  let best = null;

  if (M >= N) {
    const dp = Array.from({ length: N }, () => new Array(M).fill(Infinity));
    const prev = Array.from({ length: N }, () => new Array(M).fill(-1));

    for (let j = 0; j < M; j++) dp[0][j] = 0;

    for (let k = 1; k < N; k++) {
      for (let j = 0; j < M; j++) {
        for (let i = 0; i < j; i++) {
          const d = candidates[j].y - candidates[i].y;
          if (d < minPitch || d > maxPitch) continue;

          // ピッチ誤差を主スコアにする。
          // 強い境界を少し優先するが、強さだけで系列を決めない。
          const pitchCost = Math.pow((d - expectedPitch) / expectedPitch, 2);
          const strengthBonus = 0.02 / Math.max(1, candidates[j].strength);
          const cost = dp[k - 1][i] + pitchCost + strengthBonus;

          if (cost < dp[k][j]) {
            dp[k][j] = cost;
            prev[k][j] = i;
          }
        }
      }
    }

    let end = -1;
    let bestCost = Infinity;
    for (let j = 0; j < M; j++) {
      if (dp[N - 1][j] < bestCost) {
        bestCost = dp[N - 1][j];
        end = j;
      }
    }

    if (end >= 0 && Number.isFinite(bestCost)) {
      const ys = [];
      let j = end;
      for (let k = N - 1; k >= 0; k--) {
        ys.push(candidates[j].y);
        j = prev[k][j];
      }
      ys.reverse();

      const diffs = [];
      for (let i = 1; i < ys.length; i++) diffs.push(ys[i] - ys[i - 1]);

      const meanPitch = diffs.reduce((a, b) => a + b, 0) / diffs.length;
      const variance = diffs.reduce((a, b) => a + Math.pow(b - meanPitch, 2), 0) / diffs.length;
      const pitchSD = Math.sqrt(variance);

      best = {
        boundaries: ys,
        meanPitch,
        pitchSD,
        normalizedPitch: meanPitch / H,
        score: bestCost
      };
    }
  }

  return {
    panel: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 },
    expectedPitch,
    candidates,
    best
  };
}

function decorationRowTextureMetrics(img, roi) {
  const sw=Math.max(1,Math.round(roi.w)), sh=Math.max(1,Math.round(roi.h));
  const c=document.createElement('canvas'); c.width=sw; c.height=sh;
  const ctx=c.getContext('2d',{willReadFrequently:true});
  ctx.drawImage(img,roi.x,roi.y,sw,sh,0,0,sw,sh);
  const d=ctx.getImageData(0,0,sw,sh).data;
  let edgeSum=0, edgeN=0, sum=0, sum2=0;
  for(let y=0;y<sh;y++){
    for(let x=0;x<sw;x++){
      const i=(y*sw+x)*4; const g=.299*d[i]+.587*d[i+1]+.114*d[i+2];
      sum+=g; sum2+=g*g;
      if(x>0){ const j=i-4; const g0=.299*d[j]+.587*d[j+1]+.114*d[j+2]; edgeSum+=Math.abs(g-g0); edgeN++; }
    }
  }
  const mean=sum/(sw*sh); const sd=Math.sqrt(Math.max(0,sum2/(sw*sh)-mean*mean));
  return {edge:edgeSum/Math.max(1,edgeN),sd};
}

function classifyDecorationRows(img, rois) {
  const metrics=rois.map(r=>decorationRowTextureMetrics(img,r));
  const medEdge=percentile1D(metrics.map(m=>m.edge),0.5);
  const medSD=percentile1D(metrics.map(m=>m.sd),0.5);
  return rois.map((r,i)=>{
    const m=metrics[i];
    const separator = m.edge <= Math.max(2.5,medEdge*0.30) && m.sd <= Math.max(30,medSD*0.75);
    return {...r,isSeparator:separator,rowTexture:m};
  });
}

// 装飾品画面のビルド反映対象は8グループ。
// サブ武器は現在の装飾品ビルド反映モデルには含めず、9番目の固定枠として
// 扱わない。これにより、サブ武器の有無で以降の装備グループがずれることを防ぐ。
const DECORATION_GROUP_ORDER = [
  // 実際の装飾品画面の上からの並び順。
  // サブ武器は物理グループとして位置合わせに必要だが、ビルド反映対象外。
  // 装衣には装飾品スロットがないため、このグループ列には含めない。
  {key:'mainWeapon',label:'メイン武器',reflect:true},
  {key:'subWeapon',label:'サブ武器',reflect:false},
  {key:'head',label:'頭防具',reflect:true},
  {key:'chest',label:'胴防具',reflect:true},
  {key:'arms',label:'腕防具',reflect:true},
  {key:'waist',label:'腰防具',reflect:true},
  {key:'legs',label:'脚防具',reflect:true},
  {key:'charm',label:'護石',reflect:true}
];

function parseDecorationSlotLevel(raw) {
  const s=String(raw||'');
  const m=s.match(/[\[【]\s*([1-3])\s*[\]】]/);
  return m ? Number(m[1]) : null;
}

function buildDecorationGroupsFromRows(img, rois) {
  const classified=classifyDecorationRows(img,rois);
  const blocks=[]; let current=[];
  const flush=()=>{ if(current.length){blocks.push(current);current=[];} };
  for(const r of classified){
    if(r.isSeparator){ flush(); }
    else current.push(r);
  }
  flush();

  // Wildsの装飾品画面では、区切り線のない先頭ブロックに複数装備が連続して
  // 表示されることがあります。1装備最大3スロットという仕様を守り、
  // 3件ずつ分割します。以降の区切りブロックは1グループとして保持します。
  const logicalBlocks=[];
  for(const block of blocks){
    if(block.length<=3){ logicalBlocks.push(block); continue; }
    for(let i=0;i<block.length;i+=3) logicalBlocks.push(block.slice(i,i+3));
  }

  if(logicalBlocks.length>DECORATION_GROUP_ORDER.length){
    throw new Error(`装備グループが${logicalBlocks.length}件あります（表示上限${DECORATION_GROUP_ORDER.length}件）`);
  }

  const groups=logicalBlocks.map((block,groupIndex)=>{
    const def=DECORATION_GROUP_ORDER[groupIndex];
    if(!def) throw new Error(`装備グループ${groupIndex+1}を8グループ定義へ対応付けできません`);
    const expected=getEquipmentExpectedGroupSlots(def.key);
    const slots=block.map((r,j)=>{
      r.groupIndex=groupIndex;
      r.slotInGroup=j;
      r.logicalGroupLabel=def.label;
      r.isSeparator=false;
      r.slotLevel=null;
      return r;
    });
    return {groupIndex,key:def.key,label:def.label,equipmentKey:def.key,reflect:def.reflect!==false,expectedSlotLevels:expected,slots};
  });
  // OCRはgroups.slotsを唯一の正規データ源とし、同じROIオブジェクトを
  // result.roisにも戻す。別配列へのコピーでgroup/slot IDが消える事故を防止する。
  const slotRois=groups.flatMap(g=>g.slots);
  return {rois:slotRois,groups};
}

function renderDecorationGroups(result) {
  const groups=result.groups||[];
  if(!groups.length) return `<div class="result warn"><b>装飾品グループを確定できません</b></div>`;
  return `<div class="result ok"><b>装飾品グループ：${groups.length}グループ / ${groups.reduce((n,g)=>n+g.slots.length,0)}スロット</b>`+
    groups.map(g=>`<div style="border:1px solid #c8baa0;border-radius:8px;padding:8px;margin-top:6px"><b>${g.groupIndex+1}. ${g.label}</b>`+
      ` / 実スロット${g.slots.length}`+
      `${g.expectedSlotLevels.length?` / スロット上限[${g.expectedSlotLevels.join(',')}]`:' / スロット上限情報なし'}`+
      `<div class="mono">${g.slots.map((r,i)=>`${i+1}番：行${r.slotIndex+1} / OCR前 / Lv${r.slotLevel||'未確定'}`).join('<br>')}</div></div>`).join('')+
    `</div>`;
}

function buildDecorationSlotROIs(gameArea, boundaries) {
  const rois = [];
  const W = gameArea.w;
  const H = gameArea.h;

  for (let i = 0; i < DECORATION_SLOT_CONFIG.maxSlots; i++) {
    const top = boundaries[i];
    const bottom = boundaries[i + 1];
    const pitch = bottom - top;

    const inset = Math.max(2, H * DECORATION_SLOT_CONFIG.roiInsetRatio);

    rois.push({
      slotIndex: i,
      // 後段で装備DBのスロット情報と対応付けるための論理ID。
      groupIndex: null,
      slotInGroup: null,

      x: Math.round(gameArea.x + W * DECORATION_SLOT_CONFIG.nameXRatio),
      y: Math.round(top + inset),
      w: Math.round(W * DECORATION_SLOT_CONFIG.nameWidthRatio),
      h: Math.max(8, Math.round(pitch - inset * 2)),

      boundaryTop: top,
      boundaryBottom: bottom,
      pitch
    });
  }

  return rois;
}

function drawDecorationSlotROIs(img, result) {
  const canvas = $('decorationSlotView');
  $('decorationSlotStage').style.display = 'block';

  const W = img.naturalWidth || img.width;
  const H = img.naturalHeight || img.height;

  canvas.width = W;
  canvas.height = H;

  const c = canvas.getContext('2d');
  c.clearRect(0, 0, W, H);
  c.drawImage(img, 0, 0);

  // ゲーム領域
  c.strokeStyle = '#00ff80';
  c.lineWidth = Math.max(2, Math.round(Math.min(W, H) / 450));
  c.strokeRect(
    Math.round(result.gameArea.x),
    Math.round(result.gameArea.y),
    Math.round(result.gameArea.w),
    Math.round(result.gameArea.h)
  );

  // パネル
  c.strokeStyle = '#ffd000';
  c.lineWidth = Math.max(2, Math.round(Math.min(W, H) / 600));
  c.strokeRect(
    result.detect.panel.x,
    result.detect.panel.y,
    result.detect.panel.w,
    result.detect.panel.h
  );

  // 25本の境界
  c.strokeStyle = '#ff4dff';
  c.lineWidth = Math.max(1, Math.round(Math.min(W, H) / 800));
  for (const y of result.detect.best.boundaries) {
    c.beginPath();
    c.moveTo(result.detect.panel.x, y);
    c.lineTo(result.detect.panel.x + result.detect.panel.w, y);
    c.stroke();
  }

  const fs = Math.max(11, Math.round(Math.min(W, H) / 65));
  c.font = `bold ${fs}px sans-serif`;

  for (const r of result.rois) {
    c.strokeStyle = '#00d5ff';
    c.strokeRect(r.x, r.y, r.w, r.h);

    c.fillStyle = '#00d5ff';
    c.fillText(
      String(r.slotIndex + 1),
      r.x + 2,
      Math.max(fs + 2, r.y + fs)
    );
  }
}

function renderDecorationSlotResult(result) {
  const d = result.detect;
  const b = d.best;
  const emptyCount = result.rois.filter(r => r.slotIndex >= 0).length;

  let html =
    `<div class="result ${b ? 'ok' : 'warn'}">` +
    `<b>v4.5.5 装飾品グループ構造検証</b><br>` +
    `<span class="mono">` +
    `入力=${result.imageW}×${result.imageH} / ` +
    `16:9=${result.gameArea.x.toFixed(1)},${result.gameArea.y.toFixed(1)},` +
    `${result.gameArea.w.toFixed(1)}×${result.gameArea.h.toFixed(1)}` +
    `</span></div>`;

  html += `<div class="result"><b>検出条件</b><div class="mono">` +
    `候補境界=${d.candidates.length}本 / 必要境界=25本 / ` +
    `論理スロット=24 / OCR=未実行 / 珠DB=取得後に照合` +
    `</div></div>`;

  if (!b) {
    html += `<div class="result warn"><b>24スロットGrid未成立</b><div class="mono">25本の境界をピッチ整合性付きで確定できませんでした。安全のためスロットROIは生成していません。</div></div>`;
    $('decorationSlotOut').innerHTML = html;
    return;
  }

  html += `<div class="result ok"><b>24スロットGrid成立</b><div class="mono">` +
    `pitch=${b.meanPitch.toFixed(2)}px / pitchSD=${b.pitchSD.toFixed(2)}px / ` +
    `pitch/H=${b.normalizedPitch.toFixed(5)} / score=${b.score.toFixed(5)}` +
    `</div></div>`;

  html += `<div class="result"><b>スロットROI</b><div class="mono">`;
  for (const r of result.rois) {
    html += `${String(r.slotIndex + 1).padStart(2,'0')}: x=${r.x}, y=${r.y}, ${r.w}×${r.h} / pitch=${r.pitch.toFixed(1)}px<br>`;
  }
  html += `</div></div>`;

  html += renderDecorationGroups(result);
  html += `<div class="result"><b>グループ化ルール</b><div class="mono">区切り行を検出してグループを分離 / 1グループ最大3スロット / 画面上は最大8グループ（メイン武器→サブ武器→頭→胴→腕→腰→脚→護石）。サブ武器は位置合わせ用に保持するがビルド反映対象外。装衣には装飾品スロットがないためグループ化しない。区切り行はスロット数に含めません。装備DBのスロットLvは照合情報として保持します。</div></div>`;

  $('decorationSlotOut').innerHTML = html;
}

async function recognizeDecorationOCR(){
  const result=window.decorationSlotResult;
  if(!result || !Array.isArray(result.groups) || !result.groups.length){
    $('decorationSlotStatus').textContent='先に「24スロットを切り出す」を実行してください。';
    $('workflowDecorationStatus').textContent='先に装飾品スロットROIを確定してください。';
    return;
  }
  const img=$('decorationImg');
  const btn=$('workflowDecorationOCR');
  btn.disabled=true;
  const started=performance.now();
  try{
    $('workflowDecorationStatus').textContent=`装飾品${result.groups.length}グループ / ${result.groups.reduce((n,g)=>n+g.slots.length,0)}スロットをOCR中…（珠DBは並行取得）`;
    // Decoration OCR is independent from the remote DB. Start the DB load in
    // parallel so cached data can be used immediately and a fresh DB can join
    // candidate matching without making OCR itself a prerequisite.
    const decoDBPromise=loadDecorationDB(false).catch(e=>{
      console.warn('装飾品DB取得失敗：',e);
      return null;
    });
    const worker=await Tesseract.createWorker('jpn');
    await worker.setParameters({tessedit_pageseg_mode:'7',preserve_interword_spaces:'1'});
    const out=[];
    for(const roi of result.rois.filter(r=>!r.isSeparator)){
      const group=result.groups.find(g=>g.groupIndex===roi.groupIndex);
      if(!group) continue;
      const c=document.createElement('canvas');
      const sw=Math.max(1,Math.round(roi.w)), sh=Math.max(1,Math.round(roi.h));
      const scale=Math.max(3,Math.min(6,Math.round(900/Math.max(1,sw))));
      c.width=sw*scale; c.height=sh*scale;
      const ctx=c.getContext('2d',{willReadFrequently:true});
      ctx.imageSmoothingEnabled=true; ctx.imageSmoothingQuality='high';
      ctx.drawImage(img,roi.x,roi.y,sw,sh,0,0,c.width,c.height);
      const passes=[];
      for(const mode of ['gray','white']){
        const pc=document.createElement('canvas'); pc.width=c.width; pc.height=c.height;
        const pctx=pc.getContext('2d',{willReadFrequently:true}); pctx.drawImage(c,0,0);
        const d=pctx.getImageData(0,0,pc.width,pc.height);
        for(let i=0;i<d.data.length;i+=4){
          const g=.299*d.data[i]+.587*d.data[i+1]+.114*d.data[i+2];
          const z=mode==='gray' ? clampNumber(128+(g-128)*1.35,0,255) : (g>=145?255:0);
          d.data[i]=d.data[i+1]=d.data[i+2]=Math.round(z);
        }
        pctx.putImageData(d,0,0);
        const padded=addPaddingCustom(pc,Math.max(16,Math.round(pc.width*.05)),Math.max(16,Math.round(pc.height*.18)),'#000000');
        const r=await worker.recognize(padded);
        const raw=cleanOCR(r?.data?.text||'');
        const conf=Number(r?.data?.confidence||0);
        passes.push({mode,raw,confidence:conf});
      }
      const usable=passes.filter(x=>x.raw).sort((a,b)=>b.confidence-a.confidence);
      const best=usable[0]||{raw:'',confidence:0,mode:'none'};
      const slotLevel=parseDecorationSlotLevel(best.raw);
      const expectedLevels=group?.expectedSlotLevels||[];
      const maxSlot=expectedLevels[roi.slotInGroup]??null;
      const equipmentKey=group?.equipmentKey||null;
      const expectedKind=decorationKindForEquipmentKey(equipmentKey);
      const candidates=matchDecorationCandidates(best.raw,maxSlot,expectedKind);
      roi.slotLevel=slotLevel;
      roi.decorationCandidates=candidates;
      roi.decorationBest=candidates[0]||null;
      if(group){ const gs=group.slots.find(x=>x.slotIndex===roi.slotIndex); if(gs){ gs.slotLevel=slotLevel; gs.ocr={slotIndex:roi.slotIndex,groupIndex:roi.groupIndex,slotInGroup:roi.slotInGroup,slotLevel,maxSlot,raw:best.raw,confidence:best.confidence,mode:best.mode,candidates,dbBest:candidates[0]||null}; gs.jewel=candidates[0]||null; } }
      out.push({slotIndex:roi.slotIndex,groupIndex:roi.groupIndex,slotInGroup:roi.slotInGroup,slotLevel,maxSlot,equipmentKey,expectedKind,roi,passes,raw:best.raw,confidence:best.confidence,mode:best.mode,candidates,dbBest:candidates[0]||null});
      if((out.length)%4===0) $('workflowDecorationStatus').textContent=`装飾品OCR中… ${out.length}/${result.groups.reduce((n,g)=>n+g.slots.length,0)}`;
    }
    await worker.terminate();
    // Fresh DB may have completed while OCR was running. Re-score every OCR row
    // once more so late-arriving DB data is reflected without rerunning OCR.
    await decoDBPromise;
    for(const r of out){
      const group=result.groups.find(g=>g.groupIndex===r.groupIndex);
      const expectedLevels=group?.expectedSlotLevels||[];
      const maxSlot=expectedLevels[r.slotInGroup]??null;
      r.maxSlot=maxSlot;
      r.expectedKind=decorationKindForEquipmentKey(group?.equipmentKey||null);
      r.candidates=matchDecorationCandidates(r.raw,maxSlot,r.expectedKind);
      r.dbBest=r.candidates[0]||null;
      r.roi.decorationCandidates=r.candidates;
      r.roi.decorationBest=r.dbBest;
      const gs=group?.slots?.find(x=>x.slotIndex===r.slotIndex);
      if(gs){ gs.ocr={...(gs.ocr||{}),maxSlot,candidates:r.candidates,dbBest:r.dbBest}; gs.jewel=r.dbBest||null; }
    }
    window.lastDecorationOCR=out;
    window.decorationSlotResult.ocr=out;
    updateDecorationContext();
    renderDecorationOCRResult(out);
    const recognized=out.filter(x=>x.raw && x.confidence>=25).length;
    const elapsed=(performance.now()-started)/1000;
    $('workflowDecorationStatus').textContent=`装飾品OCR完了：${result.groups.length}グループ / ${out.length}スロット / 文字候補${recognized}件 / ${elapsed.toFixed(1)}秒`;
  }catch(e){
    console.error(e);
    $('workflowDecorationStatus').textContent='装飾品OCRエラー：'+e.message;
  }finally{btn.disabled=false}
}
function renderDecorationOCRResult(rows){
  const byGroup=new Map();
  rows.forEach(r=>{if(!byGroup.has(r.groupIndex))byGroup.set(r.groupIndex,[]);byGroup.get(r.groupIndex).push(r);});
  const groups=Array.from(byGroup.entries()).sort((a,b)=>a[0]-b[0]).map(([gi,rs])=>{
    const g=window.decorationSlotResult?.groups?.find(x=>x.groupIndex===gi);
    const lines=rs.map(r=>{
      const raw=r.raw||'（空／認識なし）';
      const slotLabel=(Number.isFinite(Number(r.slotInGroup))?`${Number(r.slotInGroup)+1}番スロット`:'スロット未割当');
      const state=r.raw?(r.confidence>=25?'候補':'低信頼'):'空・未認識';
      const db=r.dbBest;
      const dbLine=db?`<br><span class="note">DB候補：${db.name} / slot${db.slot??'?'} / ${db.kind||'?'} / DB一致 ${Math.round(db.matchScore*100)}%</span>`:'<br><span class="note">DB候補：未照合（DB未取得または候補なし）</span>';
      const dbMismatch=(r.maxSlot!=null&&r.dbBest&&Number(r.dbBest.slot)>Number(r.maxSlot));
      const jewelLvMismatch=(r.slotLevel!=null&&r.dbBest&&Number(r.dbBest.slot)!==Number(r.slotLevel));
      const ocrMismatch=(r.maxSlot!=null&&r.slotLevel!=null&&Number(r.slotLevel)>Number(r.maxSlot));
      const matchMode=r.dbBest?.exactCore?'核一致':(r.dbBest?'類似核':'未照合');
      return `<div style="border:1px solid #c8baa0;border-radius:8px;padding:7px;margin-top:5px"><b>${slotLabel}</b>　${raw} <span class="note">${state} / ${Math.round(r.confidence)}%${r.slotLevel?` / OCR Lv${r.slotLevel}`:''}${r.maxSlot!=null?` / 上限Lv${r.maxSlot}`:''}${ocrMismatch?' / ⚠上限超過':''}</span>${dbLine}${r.dbBest?`<br><span class="note">DB照合方式：${matchMode}</span>`:''}${dbMismatch?' / ⚠装備スロット上限超過':''}${jewelLvMismatch?' / ⚠OCR LvとDB slot不一致':''}</div>`;
    }).join('');
    return `<div style="border:1px solid #88775c;border-radius:10px;padding:8px;margin-top:8px"><b>${g?.label||`装備グループ${gi+1}`}</b>${g?.expectedSlotLevels?.length?` / スロット上限[${g.expectedSlotLevels.join(',')}]`:''}${lines}</div>`;
  }).join('');
  const html=`<div class="result"><b>装飾品OCR：グループ単位</b><div class="note">区切り行を除外し、実際の装着スロットだけをOCRしています。各グループは最大3スロットです。</div>${groups}</div>`;
  $('decorationOCROut').innerHTML=html;
  $('workflowDecorationOut').innerHTML=html;
}

async function runDecorationGroupSelfTest(){
  const path='decoration_reference_IMG_9323_1.jpeg';
  const img=document.createElement('img');
  img.src=path;
  try{
    await new Promise((resolve,reject)=>{img.onload=resolve;img.onerror=()=>reject(new Error('同梱参照画像を読み込めませんでした'));});
    const W=img.naturalWidth||img.width,H=img.naturalHeight||img.height;
    const tmp=document.createElement('canvas'); tmp.width=W;tmp.height=H;tmp.getContext('2d').drawImage(img,0,0);
    const gameArea=calculate16by9Area(W,H); const detect=detectDecorationBoundariesFromImage(tmp,gameArea);
    if(!detect.best) throw new Error('25境界を確定できません');
    const rois=buildDecorationSlotROIs(gameArea,detect.best.boundaries); const grouped=buildDecorationGroupsFromRows(img,rois);
    const sizes=grouped.groups.map(g=>g.slots.length);
    const ok=grouped.groups.length===8 && sizes.join(',')==='3,3,2,2,2,2,2,3';
    $('decorationSlotStatus').textContent=ok?'実画像グループ自己検証OK':'実画像グループ自己検証NG';
    $('decorationSlotOut').innerHTML=`<div class="result ${ok?'ok':'warn'}"><b>実画像グループ自己検証</b><div class="mono">入力=${W}×${H} / 境界=${detect.best.boundaries.length} / グループ=${grouped.groups.length} / 構成=[${sizes.join(',')}] / 期待=[3,3,2,2,2,2,2,3]</div></div>`;
    return {ok,groupCount:grouped.groups.length,sizes};
  }catch(e){
    $('decorationSlotStatus').textContent='実画像グループ自己検証エラー：'+e.message;
    $('decorationSlotOut').innerHTML=`<div class="result warn"><b>実画像グループ自己検証失敗</b><div class="mono">${e.message}</div></div>`;
    return {ok:false,error:e.message};
  }
}

function calculateDecorationSlots() {
  const img = $('decorationImg');
  if (!img || !img.src) {
    $('decorationSlotStatus').textContent = '先に装飾品画像を選択してください。';
    return;
  }

  try {
    const W = img.naturalWidth || img.width;
    const H = img.naturalHeight || img.height;

    const tmp = document.createElement('canvas');
    tmp.width = W;
    tmp.height = H;
    const tctx = tmp.getContext('2d', { willReadFrequently: true });
    tctx.drawImage(img, 0, 0);

    const gameArea = calculate16by9Area(W, H);
    const detect = detectDecorationBoundariesFromImage(tmp, gameArea);

    if (!detect.best) {
      $('decorationSlotStage').style.display = 'none';
      $('decorationSlotOut').innerHTML =
        `<div class="result warn"><b>24スロットGrid未成立</b><div class="mono">` +
        `候補境界=${detect.candidates.length} / 必要25本。` +
        `安全のため24個のROIは生成しません。</div></div>`;
      $('decorationSlotStatus').textContent =
        `検証失敗：候補境界${detect.candidates.length}本 / 25本必要`;
      window.decorationSlotResult = null;
      return;
    }

    const rois = buildDecorationSlotROIs(gameArea, detect.best.boundaries);
    const grouped = buildDecorationGroupsFromRows(img, rois);

    const result = {
      imageW: W,
      imageH: H,
      gameArea,
      detect,
      rois: grouped.rois,
      groups: grouped.groups
    };

    window.decorationSlotResult = result;
    updateDecorationContext();

    drawDecorationSlotROIs(img, result);
    renderDecorationSlotResult(result);

    $('decorationSlotStatus').textContent =
      `24スロットGrid成立：pitch=${detect.best.meanPitch.toFixed(1)}px / SD=${detect.best.pitchSD.toFixed(1)}px`;
  } catch (e) {
    console.error(e);
    $('decorationSlotStatus').textContent = '装飾品スロット検出エラー：' + e.message;
  }
}

function runDecorationSlotSelfTest() {
  const sizes = [
    [1536,864],
    [1920,1080],
    [2560,1440],
    [3840,2160],
    [2560,1080],
    [3440,1440],
    [1080,1920],
    [706,1536]
  ];

  const lines = [];
  for (const [w,h] of sizes) {
    // 数式系の自己検証。画像内容を必要としない部分について、
    // 16:9領域が正しく求まることと24スロットROIが領域内に入ることを確認する。
    const g = calculate16by9Area(w,h);
    const x = g.x + g.w * DECORATION_SLOT_CONFIG.nameXRatio;
    const ww = g.w * DECORATION_SLOT_CONFIG.nameWidthRatio;
    const inside = x >= g.x && x + ww <= g.x + g.w;

    lines.push(
      `${w}×${h}: game=${Math.round(g.x)},${Math.round(g.y)},` +
      `${Math.round(g.w)}×${Math.round(g.h)} / ` +
      `名前X=${Math.round(x)} W=${Math.round(ww)} / ${inside ? 'OK' : 'NG'}`
    );
  }

  $('decorationSlotStatus').textContent = '自己検証完了：8サイズの座標範囲OK';
  $('decorationSlotOut').innerHTML =
    `<div class="result ok"><b>装飾品ROIサイズ自己検証</b><div class="mono">${lines.join('<br>')}</div></div>`;

  return lines;
}

$('detectDecorationSlots').onclick=calculateDecorationSlots;
$('runDecorationSlotSelfTest').onclick=runDecorationSlotSelfTest;
$('runDecorationGroupSelfTest').onclick=runDecorationGroupSelfTest;
$('reflectBuild').onclick=reflectAnalysisToBuild;
$('workflowEquipmentROI')?.addEventListener('click',()=>calculateEquipmentROI());
$('workflowEquipmentOCR').onclick=async()=>{await recognizeEquipmentAll(); $('workflowEquipmentStatus').textContent=$('equipmentOCRStatus').textContent; $('workflowEquipmentOut').innerHTML=$('equipmentResults').innerHTML || `<div class="note">装備OCR結果を確認してください。</div>`; const n=Array.isArray(window.lastEquipmentOCR)?window.lastEquipmentOCR.length:(window.equipmentContext?.results?.length||0); if($('workflowEquipmentResultMetric'))$('workflowEquipmentResultMetric').textContent=`${Math.min(n,7)} / 7`; const d=$('workflowEquipmentDot'); if(d)d.className='workflow-dot done';};
$('workflowDecorationROI')?.addEventListener('click',()=>{calculateDecorationSlots(); setTimeout(()=>{ $('workflowDecorationStatus').textContent=$('decorationSlotStatus').textContent; $('workflowDecorationOut').innerHTML=$('decorationSlotOut').innerHTML; },0);});
$('workflowDecorationOCR').onclick=async()=>{await recognizeDecorationOCR(); const n=window.decorationSlotResult?.groups?.reduce((a,g)=>a+g.slots.length,0)||0; if($('workflowDecorationResultMetric'))$('workflowDecorationResultMetric').textContent=`${n} / 19`; const d=$('workflowDecorationDot'); if(d)d.className='workflow-dot done';};
$('workflowReflectBuild').onclick=()=>{reflectAnalysisToBuild(); $('workflowReflectionStatus').textContent=$('buildReflectionStatus').textContent; $('workflowReflectionOut').innerHTML=$('buildReflectionOut').innerHTML;};

$('decorationFile').addEventListener('change',()=>{
  const f=$('decorationFile').files?.[0];
  window.decorationContext=null;
  window.decorationSlotResult=null;
  window.decorationContext=null;
  window.lastDecorationOCR=[];
  $('decorationSlotStage').style.display='none';
  $('decorationSlotOut').innerHTML='';
  $('decorationSlotStatus').textContent='未実行';
  if(!f){
    $('decorationFileStatus').textContent='装飾品画像：未選択';
    $('decorationImg').removeAttribute('src');
    $('workflowDecorationOCR').disabled=true;
    $('decorationPreviewButton').disabled=true;
    return;
  }
  const url=URL.createObjectURL(f);
  $('decorationImg').onload=async()=>{
    URL.revokeObjectURL(url);
    const w=$('decorationImg').naturalWidth,h=$('decorationImg').naturalHeight;
    $('decorationFileStatus').innerHTML='<span id="workflowDecorationDot" class="workflow-dot ready"></span><span>装飾品画像：'+f.name+'</span>';
    $('workflowDecorationImageMetric').textContent=`${w} × ${h}`;
    const preview=$('workflowDecorationPreview'); preview.classList.remove('empty'); preview.innerHTML=''; const pv=document.createElement('img'); pv.src=$('decorationImg').src; pv.alt='装飾品画像プレビュー'; preview.appendChild(pv);
    const synced=await window.__syncEmbeddedOCRDB?.();
    const decoReady=!!synced && !!decorationDBReady;
    $('workflowDecorationStatus').textContent=decoReady?`装飾品画像を読み込みました。DB照合を含む解析を開始できます。（装飾品${decorationDB.length}件）`:'装飾品画像を読み込みました。β版の装飾品DBが準備できていません。上の「① データ取得」を確認してください。'; $('workflowDecorationOut').innerHTML=''; $('workflowDecorationOCR').disabled=!decoReady; $('decorationPreviewButton').disabled=false;
  };
  $('decorationImg').src=url;
});

$('calcEquipmentROI').onclick=calculateEquipmentROI;
$('calcEquipmentROIBase').onclick=calculateEquipmentROIBase;
$('runEquipmentROISelfTest').onclick=runEquipmentROISelfTest;

$('detectTopDownGrid').onclick=tdRun;
$('detectIconAnchor').onclick=v432Detect;
(async()=>{try{await v400LoadBundledIcons();}catch(e){$('anchorDBStatus').textContent='DBアイコン読み込み失敗：'+e.message;console.error(e);}})();

$('file').addEventListener('change',async()=>{
  v400IconGrid=null;v400IconCandidates=[];
  window.lastEquipmentOCR=[];window.lastEquipmentRegions=[];window.equipmentContext=null;
  const f=$('file').files?.[0];
  $('fileStatus').innerHTML=f?'<span id="workflowEquipmentDot" class="workflow-dot ready"></span><span>装備画像：'+f.name+'</span>':'<span id="workflowEquipmentDot" class="workflow-dot"></span><span>装備画像：未選択</span>';
  $('workflowEquipmentImageMetric').textContent='—';if($('workflowEquipmentResultMetric'))$('workflowEquipmentResultMetric').textContent='0 / 7';
  const preview=$('workflowEquipmentPreview');preview.classList.toggle('empty',!f);preview.innerHTML='';
  if(f){const url2=URL.createObjectURL(f);const pv=document.createElement('img');pv.alt='装備画像プレビュー';pv.onload=()=>{URL.revokeObjectURL(url2);$('workflowEquipmentImageMetric').textContent=`${pv.naturalWidth} × ${pv.naturalHeight}`};pv.src=url2;preview.appendChild(pv);}
  const synced=await window.__syncEmbeddedOCRDB?.();
  const dbReadyForOCR=!!(synced&&weaponDBReady&&armorReady&&charmReady);
  $('workflowEquipmentStatus').textContent=f?(dbReadyForOCR?'装備画像を読み込みました。OCRを開始できます。':'装備画像を読み込みました。β版のDBが準備できていません。上の「① データ取得」を確認してください。'):'未実行';
  $('workflowEquipmentOCR').disabled=!(f&&dbReadyForOCR);$('workflowEquipmentOut').innerHTML='';
});

window.equipmentContext=null;
window.decorationContext=null;
window.buildReflectionState=null;

// v4.6.2 production UI: keep the public surface focused on the three-step workflow.
function updateProductionState(){
  const eq=window.equipmentContext?.results?.length||0;
  const deco=window.lastDecorationOCR?.length||0;
  const eqDot=$('workflowEquipmentDot'), deDot=$('workflowDecorationDot');
  if(eqDot && eq) eqDot.className='workflow-dot done';
  if(deDot && deco) deDot.className='workflow-dot done';
  if($('workflowEquipmentResultMetric'))$('workflowEquipmentResultMetric').textContent=`${Math.min(eq,7)} / 7`;
  if($('workflowDecorationResultMetric'))$('workflowDecorationResultMetric').textContent=`${deco} / ${window.decorationSlotResult?.groups?.reduce((n,g)=>n+g.slots.length,0)||0}`;
}
function escapeHtml(value){return String(value??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));}

// β版と同じDBオブジェクトを直接参照。別キャッシュ・別API取得は行わない。
// v1.1.8: beta simulator charm DB -> flat OCR rank rows.
// v1.1.7 called betaNormalizeCharmRows(), but that helper was missing.
function betaNormalizeCharmRows(rows){
  const out=[]; const seen=new Set();
  for(const c of (Array.isArray(rows)?rows:[])){
    for(const rank of (Array.isArray(c?.ranks)?c.ranks:[])){
      const name=String(rank?.name||'').trim(); if(!name)continue;
      const row={id:c?.id??null,gameId:c?.gameId??null,kind:'charm',name,rankLevel:rank?.level??null,slots:rank?.slots??c?.slots??null,decorationSlots:rank?.decorationSlots??c?.decorationSlots??null,slotLevels:normalizeDecorationSlotLevels(rank?.slotLevels??rank?.decorationSlots??rank?.slots??c?.slotLevels??c?.decorationSlots??c?.slots)};
      const key=`${row.id??''} ${row.rankLevel??''} ${row.name}`;
      if(seen.has(key))continue; seen.add(key); out.push(row);
    }
  }
  return out;
}

async function syncEmbeddedOCRDB(){
  const d=typeof window.__getBetaDB==='function' ? window.__getBetaDB() : null;
  const counts={weapons:Array.isArray(d?.weapons)?d.weapons.length:0,armor:Array.isArray(d?.armor)?d.armor.length:0,charms:Array.isArray(d?.charms)?d.charms.length:0,decorations:Array.isArray(d?.decorations)?d.decorations.length:0};
  const baseReady=counts.weapons>0&&counts.armor>0&&counts.charms>0;
  if(!baseReady){
    weaponDB=[];armorDB=[];charmDB=[];decorationDB=[];weaponDBReady=armorReady=charmReady=decorationDBReady=false;
    const st=$('workflowEquipmentStatus');if(st)st.textContent=`β版DBが未取得です（武器${counts.weapons} / 防具${counts.armor} / 護石${counts.charms}）。上の「① データ取得」を確認してください。`;
    const b=$('workflowEquipmentOCR');if(b)b.disabled=true;return false;
  }
  try{weaponDB=normalizeWeaponRows(d.weapons);rebuildWeaponGramIndex();weaponDBReady=weaponDB.length>0}catch(e){weaponDB=[];weaponDBReady=false;console.error('OCR weapon DB sync failed',e)}
  try{armorDB=normalizeArmorRows(d.armor);armorReady=armorDB.length>0}catch(e){armorDB=[];armorReady=false;console.error('OCR armor DB sync failed',e)}
  try{charmDB=betaNormalizeCharmRows(d.charms);charmReady=charmDB.length>0}catch(e){charmDB=[];charmReady=false;console.error('OCR charm DB sync failed',e)}
  try{decorationDB=normalizeDecorationRows(d.decorations||[]);rebuildDecorationGramIndex();decorationDBReady=decorationDB.length>0}catch(e){decorationDB=[];decorationDBReady=false;console.error('OCR decoration DB sync failed',e)}
  const ready=weaponDBReady&&armorReady&&charmReady;
  const b=$('workflowEquipmentOCR');if(b)b.disabled=!($('file')?.files?.[0]&&ready);
  const st=$('workflowEquipmentStatus');if(st&&!$('file')?.files?.[0])st.textContent=ready?`β版DBを使用できます（武器${weaponDB.length} / 防具${armorDB.length} / 護石${charmDB.length} / 装飾品${decorationDB.length}）。装備スクショを選択してください。`:`β版DBが未取得です（武器${counts.weapons} / 防具${counts.armor} / 護石${counts.charms}）。上の「① データ取得」を確認してください。`;
  return ready;
}
window.__syncEmbeddedOCRDB=syncEmbeddedOCRDB;
$('resetAnalysis')?.addEventListener('click',()=>{
  if(!confirm('解析結果と選択画像をすべてリセットします。よろしいですか？')) return;
  location.reload();
});
$('workflowReflectBuild')?.addEventListener('click',()=>{
  reflectAnalysisToBuild();
  $('workflowReflectionStatus').textContent=$('buildReflectionStatus').textContent;
  $('workflowReflectionOut').innerHTML=$('buildReflectionOut').innerHTML;
});
const _eqOCR=$('workflowEquipmentOCR');
if(_eqOCR){ const oldEq=_eqOCR.onclick; _eqOCR.onclick=async()=>{await oldEq?.(); updateProductionState();}; }
const _decoOCR=$('workflowDecorationOCR');
if(_decoOCR){ const oldDeco=_decoOCR.onclick; _decoOCR.onclick=async()=>{await oldDeco?.(); updateProductionState();}; }

// v4.6.2 UI layer: the public workflow is deliberately separate from the OCR engine.
function setAnalysisProgress(kind,pct,label,stage){
  const p=$(kind==='eq'?'equipmentProgress':'decorationProgress'); if(!p)return;
  const safe=Math.max(0,Math.min(100,Number(pct)||0));
  p.classList.add('show');
  const bar=$(kind==='eq'?'equipmentProgressBar':'decorationProgressBar');
  const labelEl=$(kind==='eq'?'equipmentProgressLabel':'decorationProgressLabel');
  const pctEl=$(kind==='eq'?'equipmentProgressPct':'decorationProgressPct');
  if(bar)bar.style.width=safe+'%';
  if(labelEl)labelEl.textContent=label||'';
  if(pctEl)pctEl.textContent=Math.round(safe)+'%';
  const ids=kind==='eq'?['eqStage1','eqStage2','eqStage3','eqStage4']:['decoStage1','decoStage2','decoStage3','decoStage4'];
  ids.forEach((id,i)=>{
    const e=$(id); if(!e)return;
    e.className='stage '+(safe>=100 || i<stage?'done':i===stage?'active':'');
  });
}
function showImageModal(src,title){if(!src)return;$('modalTitle').textContent=title||'スクショを確認';$('modalImage').src=src;$('imageModal').classList.add('show')}
$('modalClose').onclick=()=>{$('imageModal').classList.remove('show');$('modalImage').removeAttribute('src')};
$('imageModal').addEventListener('click',e=>{if(e.target.id==='imageModal')$('modalClose').click()});
function refreshFinalBuildPreview(){
  const eq=window.equipmentContext?.results||[]; const de=window.decorationContext?.buildGroups||[];
  if(!eq.length&&!de.length){$('finalBuildPreview').innerHTML='<div class="confirm-summary">Step 1・2で確定した内容がここに表示されます。</div>';return;}
  const jewels=new Map(de.map(g=>[g.equipmentKey,g]));
  const rows=eq.map(x=>{const g=jewels.get(x.key);const js=(g?.slots||[]).map(s=>s.jewel?.name||s.ocr?.raw||'未確定').join('<br>')||'—';return `<div class="build-row"><div class="build-equip">${equipmentSlotLabel(x.key)}<br><span class="subtle">${x.best?.name||'未確定'}</span></div><div class="build-jewels">${js}</div></div>`}).join('');
  $('finalBuildPreview').innerHTML=`<div class="build-col" style="grid-column:1/-1"><div class="build-row" style="border-top:0"><div class="build-equip" style="background:#eee8da"><b>装備</b></div><div class="build-jewels" style="background:#eee8da"><b>対応する装飾品</b></div></div>${rows||'<div class="confirm-summary">装備未解析</div>'}</div>`;
}
// Candidate selection: only non-auto results need a user decision.
function selectEquipmentCandidate(key,index){
  const row=(window.lastEquipmentOCR||[]).find(x=>x.key===key); if(!row||!row.ranked?.[index])return;
  row.best=row.ranked[index];
  row.best.decision={level:'user',label:'ユーザー確定',reason:'ユーザーが候補を選択'};
  updateEquipmentContext(); renderProductionEquipment(); refreshFinalBuildPreview();
}
function renderProductionEquipment(){
  const rows=window.lastEquipmentOCR||[]; if(!rows.length){$('workflowEquipmentOut').innerHTML='';return;}
  const needs=rows.filter(x=>x.best?.decision?.level!=='auto').length;
  let html=`<div class="confirm-summary"><b>③ 装備の確認</b><br>${rows.length-needs}部位を自動確定 / ${needs}部位を確認してください。</div>`;
  for(const x of rows){const b=x.best;const need=b?.decision?.level!=='auto';const cs=(x.ranked||[]).slice(0,3).map((c,i)=>`<label class="candidate-choice ${i===0?'selected':''}"><input type="radio" name="eq-${x.key}" ${i===0?'checked':''} onchange="selectEquipmentCandidate('${x.key}',${i})"><span><span class="candidate-name">${c.name}</span><span class="candidate-meta">総合 ${Math.round((c.totalScore??0)*100)}pt / OCR ${Math.round(c.confAvg||0)}%</span></span></label>`).join('');html+=`<div class="confirm-item ${need?'warning':''}"><div class="confirm-head"><b>${equipmentSlotLabel(x.key)}</b><span class="confirm-state ${need?'warn':''}">${need?'要確認':'自動確定'}</span></div><div style="margin-top:5px;font-weight:800">${b?.name||'候補なし'}</div>${need&&x.ranked?.length?`<div class="candidate-list">${cs}</div>`:''}</div>`;}
  $('workflowEquipmentOut').innerHTML=html;
}
window.selectEquipmentCandidate=selectEquipmentCandidate;
const _renderEquipmentResultOrig=renderEquipmentResult;
const _oldEqHandler=$('workflowEquipmentOCR')?.onclick;
if($('workflowEquipmentOCR'))$('workflowEquipmentOCR').onclick=async()=>{
  if(!$('file').files?.[0])return;
  $('workflowEquipmentOCR').disabled=true;setAnalysisProgress('eq',8,'画像を確認中…',0);
  await new Promise(r=>setTimeout(r,80));setAnalysisProgress('eq',25,'装備位置を検出中…',1);
  await calculateEquipmentROI();
  setAnalysisProgress('eq',45,'装備名をOCR中…',2);
  await recognizeEquipmentAll();
  setAnalysisProgress('eq',82,'DB候補を照合中…',3);
  renderProductionEquipment();
  setAnalysisProgress('eq',100,'解析完了',4);
  $('workflowEquipmentStatus').textContent='装備の解析が完了しました。下の候補を確認してください。';
  $('workflowEquipmentOCR').disabled=false;refreshFinalBuildPreview();
};
if($('workflowDecorationOCR'))$('workflowDecorationOCR').onclick=async()=>{
  if(!$('decorationFile').files?.[0])return;
  $('workflowDecorationOCR').disabled=true;setAnalysisProgress('deco',8,'画像を確認中…',0);
  await new Promise(r=>setTimeout(r,80));setAnalysisProgress('deco',25,'装飾品グループを検出中…',1);
  await calculateDecorationSlots();
  if(!window.decorationSlotResult?.groups?.length){$('workflowDecorationOCR').disabled=false;return;}
  setAnalysisProgress('deco',45,'装飾品をOCR中…',2);
  await recognizeDecorationOCR();
  setAnalysisProgress('deco',82,'装飾品DBを照合中…',3);
  updateDecorationContext();renderDecorationOCRResult(window.lastDecorationOCR||[]);
  setAnalysisProgress('deco',100,'解析完了',4);
  $('workflowDecorationStatus').textContent='装飾品の解析が完了しました。下の候補を確認してください。';
  $('workflowDecorationOCR').disabled=false;refreshFinalBuildPreview();
};
$('equipmentPreviewButton').onclick=()=>showImageModal($('img').src,'装備スクショ');
$('decorationPreviewButton').onclick=()=>showImageModal($('decorationImg').src,'装飾品スクショ');
$('skipDecoration').onclick=()=>{$('workflowDecorationStatus').textContent='装飾品の取り込みをスキップしました。';$('decorationProgress').classList.remove('show');refreshFinalBuildPreview()};

})();
window.__OCR_EMBED_READY=true;
window.__syncEmbeddedOCRDB().then(()=>{const f=$('file')?.files?.[0];if(f)$('file').dispatchEvent(new Event('change'));});