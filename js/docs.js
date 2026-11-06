// File parsing (text extraction for the interviewer) and rendering (viewer).
// Supported: PDF (pdf.js), PPTX (JSZip, approximate layout), DOCX (text),
// images, plain text / Markdown.

const pdfjsLib = window.pdfjsLib;
if (pdfjsLib) pdfjsLib.GlobalWorkerOptions.workerSrc = "vendor/pdf-3.11.174.worker.min.js";

const EMU_PER_PT = 12700;
const TEXT_PAGE_CHARS = 2800;

export function detectKind(file) {
  const name = (file.name || "").toLowerCase();
  const type = file.type || "";
  if (type === "application/pdf" || name.endsWith(".pdf")) return "pdf";
  if (name.endsWith(".pptx")) return "pptx";
  if (name.endsWith(".docx")) return "docx";
  if (type.startsWith("image/") || /\.(png|jpe?g|gif|webp)$/.test(name)) return "image";
  if (type.startsWith("text/") || /\.(txt|md|markdown|csv)$/.test(name)) return "text";
  return "unsupported";
}

export const ACCEPT = ".pdf,.pptx,.docx,.png,.jpg,.jpeg,.gif,.webp,.txt,.md";

// ---------- XML helpers ----------

const parseXml = (s) => new DOMParser().parseFromString(s, "application/xml");
const all = (node, local) => (node ? Array.from(node.getElementsByTagNameNS("*", local)) : []);
const first = (node, local) => (node ? node.getElementsByTagNameNS("*", local)[0] || null : null);
const children = (node, local) =>
  node ? Array.from(node.children).filter((c) => !local || c.localName === local) : [];
const attrR = (el, name) =>
  el?.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", name) ||
  el?.getAttribute(`r:${name}`) ||
  null;

function resolvePath(base, target) {
  if (target.startsWith("/")) return target.slice(1);
  const parts = base.split("/");
  parts.pop();
  for (const seg of target.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg !== ".") parts.push(seg);
  }
  return parts.join("/");
}

async function readRels(zip, partPath) {
  const dir = partPath.split("/");
  const file = dir.pop();
  const relPath = [...dir, "_rels", `${file}.rels`].join("/");
  const xml = await zip.file(relPath)?.async("string");
  const map = {};
  if (!xml) return map;
  for (const r of all(parseXml(xml), "Relationship")) {
    map[r.getAttribute("Id")] = {
      type: r.getAttribute("Type") || "",
      target: r.getAttribute("TargetMode") === "External" ? null : resolvePath(partPath, r.getAttribute("Target")),
    };
  }
  return map;
}

function paginateText(text) {
  const pages = [];
  const paras = text.split(/\n{2,}/);
  let cur = "";
  for (const p of paras) {
    if (cur && cur.length + p.length > TEXT_PAGE_CHARS) {
      pages.push(cur.trim());
      cur = "";
    }
    cur += p + "\n\n";
    while (cur.length > TEXT_PAGE_CHARS * 1.5) {
      pages.push(cur.slice(0, TEXT_PAGE_CHARS).trim());
      cur = cur.slice(TEXT_PAGE_CHARS);
    }
  }
  if (cur.trim() || !pages.length) pages.push(cur.trim());
  return pages.map((t) => ({ title: t.split("\n")[0].slice(0, 80), text: t }));
}

// ---------- PPTX model ----------

function xfrmOf(spPr) {
  const x = first(spPr, "xfrm");
  if (!x) return null;
  const off = first(x, "off");
  const ext = first(x, "ext");
  if (!off || !ext) return null;
  return {
    x: +off.getAttribute("x"),
    y: +off.getAttribute("y"),
    w: +ext.getAttribute("cx"),
    h: +ext.getAttribute("cy"),
  };
}

function phKey(sp) {
  const ph = first(first(sp, "nvPr"), "ph");
  if (!ph) return null;
  return { type: ph.getAttribute("type") || "body", idx: ph.getAttribute("idx") };
}

function placeholderMap(doc) {
  const map = { byIdx: {}, byType: {} };
  if (!doc) return map;
  for (const sp of all(doc, "sp")) {
    const key = phKey(sp);
    const xf = xfrmOf(first(sp, "spPr"));
    if (!key || !xf) continue;
    if (key.idx != null && !map.byIdx[key.idx]) map.byIdx[key.idx] = xf;
    if (!map.byType[key.type]) map.byType[key.type] = xf;
  }
  return map;
}

function colorOf(node) {
  const fill = node && children(node, "solidFill")[0];
  const c = fill && (first(fill, "srgbClr") || null);
  return c ? `#${c.getAttribute("val")}` : null;
}

function paragraphsOf(txBody, isTitle) {
  const out = [];
  for (const p of children(txBody, "p")) {
    let text = "";
    let size = null;
    let bold = false;
    let color = null;
    for (const node of Array.from(p.children)) {
      if (node.localName === "r" || node.localName === "fld") {
        const rPr = first(node, "rPr");
        if (rPr) {
          if (rPr.getAttribute("sz") && !size) size = +rPr.getAttribute("sz") / 100;
          if (rPr.getAttribute("b") === "1") bold = true;
          color = color || colorOf(rPr);
        }
        text += first(node, "t")?.textContent || "";
      } else if (node.localName === "br") {
        text += "\n";
      }
    }
    const pPr = first(p, "pPr");
    const algn = pPr?.getAttribute("algn");
    const lvl = +(pPr?.getAttribute("lvl") || 0);
    const bullet = !isTitle && !first(pPr, "buNone");
    out.push({
      text,
      size,
      bold,
      color,
      align: algn === "ctr" ? "center" : algn === "r" ? "right" : algn === "just" ? "justify" : "left",
      lvl,
      bullet,
    });
  }
  return out;
}

async function parsePptx(buf) {
  const zip = await window.JSZip.loadAsync(buf);
  const presPath = "ppt/presentation.xml";
  const pres = parseXml(await zip.file(presPath).async("string"));
  const sz = first(pres, "sldSz");
  const slideW = +(sz?.getAttribute("cx") || 12192000);
  const slideH = +(sz?.getAttribute("cy") || 6858000);
  const presRels = await readRels(zip, presPath);
  const slidePaths = all(pres, "sldId")
    .map((s) => presRels[attrR(s, "id")]?.target)
    .filter(Boolean);

  const mediaCache = {};
  const media = async (path) => {
    if (!mediaCache[path]) {
      const f = zip.file(path);
      if (!f) return null;
      const ext = path.split(".").pop().toLowerCase();
      const mime =
        { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", svg: "image/svg+xml", webp: "image/webp", bmp: "image/bmp" }[ext];
      if (!mime) return null; // emf/wmf etc. can't be shown in browsers
      mediaCache[path] = URL.createObjectURL(new Blob([await f.async("arraybuffer")], { type: mime }));
    }
    return mediaCache[path];
  };

  const layoutCache = {};
  const loadPart = async (path) => {
    if (!(path in layoutCache)) {
      const xml = await zip.file(path)?.async("string");
      layoutCache[path] = xml ? parseXml(xml) : null;
    }
    return layoutCache[path];
  };

  const slides = [];
  for (const path of slidePaths) {
    const doc = parseXml(await zip.file(path).async("string"));
    const rels = await readRels(zip, path);
    const layoutRel = Object.values(rels).find((r) => r.type.endsWith("/slideLayout"));
    const layoutDoc = layoutRel ? await loadPart(layoutRel.target) : null;
    let masterDoc = null;
    if (layoutRel) {
      const lrels = await readRels(zip, layoutRel.target);
      const mrel = Object.values(lrels).find((r) => r.type.endsWith("/slideMaster"));
      if (mrel) masterDoc = await loadPart(mrel.target);
    }
    const layoutPh = placeholderMap(layoutDoc);
    const masterPh = placeholderMap(masterDoc);
    const lookupPh = (key) =>
      (key.idx != null && (layoutPh.byIdx[key.idx] || masterPh.byIdx[key.idx])) ||
      layoutPh.byType[key.type] ||
      masterPh.byType[key.type] ||
      (key.type === "ctrTitle" && (layoutPh.byType.title || masterPh.byType.title)) ||
      (key.type === "subTitle" && (layoutPh.byType.body || masterPh.byType.body)) ||
      null;

    const elements = [];
    let title = "";
    const texts = [];

    const walk = async (container, tf) => {
      for (const node of Array.from(container.children)) {
        const ln = node.localName;
        if (ln === "grpSp") {
          const gx = first(first(node, "grpSpPr"), "xfrm");
          let inner = tf;
          if (gx) {
            const off = first(gx, "off"), ext = first(gx, "ext"), choff = first(gx, "chOff"), chext = first(gx, "chExt");
            if (off && ext && choff && chext) {
              const sx = +chext.getAttribute("cx") ? +ext.getAttribute("cx") / +chext.getAttribute("cx") : 1;
              const sy = +chext.getAttribute("cy") ? +ext.getAttribute("cy") / +chext.getAttribute("cy") : 1;
              const ox = +off.getAttribute("x") - +choff.getAttribute("x") * sx;
              const oy = +off.getAttribute("y") - +choff.getAttribute("y") * sy;
              inner = (b) => tf({ x: ox + b.x * sx, y: oy + b.y * sy, w: b.w * sx, h: b.h * sy });
            }
          }
          await walk(node, inner);
        } else if (ln === "sp") {
          const key = phKey(node);
          let box = xfrmOf(first(node, "spPr"));
          if (!box && key) box = lookupPh(key);
          const txBody = children(node, "txBody")[0];
          const isTitle = key && (key.type === "title" || key.type === "ctrTitle");
          const paras = txBody ? paragraphsOf(txBody, isTitle) : [];
          const plain = paras.map((p) => p.text).join("\n").trim();
          if (plain) {
            texts.push(plain);
            if (isTitle && !title) title = plain.replace(/\s+/g, " ");
          }
          if (!box) {
            if (!plain) continue;
            box = isTitle
              ? { x: slideW * 0.06, y: slideH * 0.05, w: slideW * 0.88, h: slideH * 0.16 }
              : { x: slideW * 0.06, y: slideH * 0.25, w: slideW * 0.88, h: slideH * 0.68 };
          }
          const fill = colorOf(first(node, "spPr"));
          if (!plain && !fill) continue;
          elements.push({
            type: "text",
            ...tf(box),
            paras,
            fill,
            isTitle: !!isTitle,
            anchor: first(txBody, "bodyPr")?.getAttribute("anchor") || (isTitle ? "ctr" : "t"),
          });
        } else if (ln === "pic") {
          const box = xfrmOf(first(node, "spPr"));
          const embed = attrR(first(node, "blip"), "embed");
          const target = embed && rels[embed]?.target;
          const src = target ? await media(target) : null;
          if (box && src) elements.push({ type: "image", ...tf(box), src });
        } else if (ln === "graphicFrame") {
          // tables: pull text so the interviewer can read it
          const t = all(node, "t").map((n) => n.textContent).join(" ").trim();
          const xf = first(node, "xfrm");
          if (t) texts.push(t);
          if (t && xf) {
            const off = first(xf, "off"), ext = first(xf, "ext");
            elements.push({
              type: "text",
              ...tf({ x: +off.getAttribute("x"), y: +off.getAttribute("y"), w: +ext.getAttribute("cx"), h: +ext.getAttribute("cy") }),
              paras: [{ text: t, size: 12, align: "left", lvl: 0, bullet: false }],
              anchor: "t",
            });
          }
        }
      }
    };
    const spTree = first(first(doc, "cSld"), "spTree");
    if (spTree) await walk(spTree, (b) => b);

    const bg = colorOf(first(first(doc, "bg"), "bgPr")) || colorOf(first(first(masterDoc, "bg"), "bgPr")) || "#ffffff";
    const notesRel = Object.values(rels).find((r) => r.type.endsWith("/notesSlide"));
    let notes = "";
    if (notesRel) {
      const nd = await loadPart(notesRel.target);
      notes = all(nd, "t").map((n) => n.textContent).join(" ").replace(/\s+/g, " ").trim();
    }
    slides.push({ elements, title, text: texts.join("\n\n"), notes, bg });
  }
  return { slideW, slideH, slides };
}

async function parseDocx(buf) {
  const zip = await window.JSZip.loadAsync(buf);
  const xml = await zip.file("word/document.xml")?.async("string");
  if (!xml) return "";
  const doc = parseXml(xml);
  return all(doc, "p")
    .map((p) => all(p, "t").map((t) => t.textContent).join(""))
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n");
}

// ---------- public: extract + open ----------

// Extract text per page/slide for the interviewer (stored in IndexedDB).
export async function extractPages(kind, blob) {
  const buf = await blob.arrayBuffer();
  if (kind === "pdf") {
    const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise;
    const pages = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const tc = await page.getTextContent();
      let text = "";
      for (const item of tc.items) {
        text += item.str + (item.hasEOL ? "\n" : " ");
      }
      text = text.replace(/[ \t]+/g, " ").replace(/\n\s+/g, "\n").trim();
      pages.push({ title: text.split("\n")[0].slice(0, 80), text });
    }
    pdf.destroy();
    return pages;
  }
  if (kind === "pptx") {
    const model = await parsePptx(buf);
    model.slides.forEach((s) => s.elements.forEach((e) => e.src && URL.revokeObjectURL(e.src)));
    return model.slides.map((s) => ({
      title: s.title,
      text: s.text + (s.notes ? `\n\n[Speaker notes] ${s.notes}` : ""),
    }));
  }
  if (kind === "docx") return paginateText(await parseDocx(buf));
  if (kind === "text") return paginateText(new TextDecoder().decode(buf));
  if (kind === "image") return [{ title: "", text: "(image — no extractable text)" }];
  return [{ title: "", text: "" }];
}

// Open a stored file record for viewing. Returns a doc with render(container, index).
export async function openDoc(rec) {
  const pageCount = rec.pages?.length || 1;
  const base = {
    kind: rec.kind,
    pageCount,
    unit: rec.kind === "pptx" ? "slide" : "page",
    destroy() {},
  };

  if (rec.kind === "pdf") {
    const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(await rec.blob.arrayBuffer()) }).promise;
    let task = null;
    return {
      ...base,
      pageCount: pdf.numPages,
      async render(container, index) {
        const page = await pdf.getPage(index + 1);
        const vp1 = page.getViewport({ scale: 1 });
        const box = container.getBoundingClientRect();
        const scale = Math.max(0.1, Math.min((box.width - 8) / vp1.width, (box.height - 8) / vp1.height));
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const vp = page.getViewport({ scale: scale * dpr });
        const canvas = document.createElement("canvas");
        canvas.width = Math.floor(vp.width);
        canvas.height = Math.floor(vp.height);
        canvas.style.width = `${Math.floor(vp.width / dpr)}px`;
        canvas.style.height = `${Math.floor(vp.height / dpr)}px`;
        canvas.className = "page-canvas";
        if (task) task.cancel();
        task = page.render({ canvasContext: canvas.getContext("2d"), viewport: vp });
        try {
          await task.promise;
        } catch (e) {
          if (e?.name === "RenderingCancelledException") return;
          throw e;
        }
        container.replaceChildren(canvas);
      },
      destroy() {
        pdf.destroy();
      },
    };
  }

  if (rec.kind === "pptx") {
    const model = await parsePptx(await rec.blob.arrayBuffer());
    const wPt = model.slideW / EMU_PER_PT;
    return {
      ...base,
      pageCount: model.slides.length,
      render(container, index) {
        const s = model.slides[index];
        const box = container.getBoundingClientRect();
        const ratio = model.slideH / model.slideW;
        const width = Math.max(100, Math.min(box.width - 8, (box.height - 8) / ratio));
        const slide = document.createElement("div");
        slide.className = "pptx-slide";
        slide.style.width = `${width}px`;
        slide.style.height = `${width * ratio}px`;
        slide.style.background = s.bg;
        const pct = (v, total) => `${(v / total) * 100}%`;
        const ptToPx = width / wPt;
        for (const el of s.elements) {
          const d = document.createElement(el.type === "image" ? "img" : "div");
          d.className = el.type === "image" ? "pptx-img" : "pptx-text";
          d.style.left = pct(el.x, model.slideW);
          d.style.top = pct(el.y, model.slideH);
          d.style.width = pct(el.w, model.slideW);
          d.style.height = pct(el.h, model.slideH);
          if (el.type === "image") {
            d.src = el.src;
            d.alt = "";
          } else {
            if (el.fill) d.style.background = el.fill;
            d.style.justifyContent = el.anchor === "ctr" ? "center" : el.anchor === "b" ? "flex-end" : "flex-start";
            for (const p of el.paras) {
              const pe = document.createElement("p");
              const size = p.size || (el.isTitle ? 36 : 20);
              pe.style.fontSize = `${size * ptToPx}px`;
              pe.style.textAlign = p.align;
              if (p.bold || el.isTitle) pe.style.fontWeight = "700";
              if (p.color) pe.style.color = p.color;
              if (p.lvl) pe.style.marginLeft = `${p.lvl * 1.2}em`;
              pe.textContent = (p.bullet && p.text.trim() && !el.isTitle && el.paras.length > 1 ? "• " : "") + (p.text || " ");
              d.appendChild(pe);
            }
          }
          slide.appendChild(d);
        }
        if (!s.elements.length) {
          const e = document.createElement("div");
          e.className = "pptx-empty";
          e.textContent = s.text || "(empty slide)";
          slide.appendChild(e);
        }
        container.replaceChildren(slide);
      },
      destroy() {
        model.slides.forEach((s) => s.elements.forEach((e) => e.src && URL.revokeObjectURL(e.src)));
      },
    };
  }

  if (rec.kind === "image") {
    const url = URL.createObjectURL(rec.blob);
    return {
      ...base,
      pageCount: 1,
      render(container) {
        const img = document.createElement("img");
        img.src = url;
        img.className = "page-image";
        img.alt = rec.name;
        container.replaceChildren(img);
      },
      destroy() {
        URL.revokeObjectURL(url);
      },
    };
  }

  // docx / text / unsupported: render extracted text pages
  return {
    ...base,
    render(container, index) {
      const div = document.createElement("div");
      div.className = "text-page";
      div.textContent = rec.pages?.[index]?.text || "(No preview available for this file type.)";
      container.replaceChildren(div);
    },
  };
}

// Base64 of a blob (for direct PDF / image attachment).
export async function blobToBase64(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  const CH = 0x8000;
  for (let i = 0; i < buf.length; i += CH) bin += String.fromCharCode.apply(null, buf.subarray(i, i + CH));
  return btoa(bin);
}
