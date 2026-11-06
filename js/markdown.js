// Minimal, safe Markdown → HTML for interviewer replies.
// Escapes everything first, then applies a small set of block/inline rules.

function esc(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function inline(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>")
    .replace(/(^|[^_\w])_([^_\s][^_]*)_(?!\w)/g, "$1<em>$2</em>");
}

export function renderMarkdown(src) {
  const lines = String(src || "").replace(/\r\n?/g, "\n").split("\n");
  let html = "";
  let list = null; // "ul" | "ol"
  let para = [];

  const flushPara = () => {
    if (para.length) html += `<p>${para.map(inline).join("<br>")}</p>`;
    para = [];
  };
  const closeList = () => {
    if (list) html += `</${list}>`;
    list = null;
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    let m;
    if (!line.trim()) {
      flushPara();
      closeList();
    } else if ((m = line.match(/^(#{1,4})\s+(.*)$/))) {
      flushPara();
      closeList();
      const level = Math.min(4, m[1].length + 2);
      html += `<h${level}>${inline(m[2])}</h${level}>`;
    } else if ((m = line.match(/^\s*(\d+)[.)]\s+(.*)$/))) {
      flushPara();
      if (list !== "ol") {
        closeList();
        html += `<ol start="${Number(m[1])}">`;
        list = "ol";
      }
      html += `<li>${inline(m[2])}</li>`;
    } else if ((m = line.match(/^\s*[-*•]\s+(.*)$/))) {
      flushPara();
      if (list !== "ul") {
        closeList();
        html += "<ul>";
        list = "ul";
      }
      html += `<li>${inline(m[1])}</li>`;
    } else if (/^\s*(---|\*\*\*)\s*$/.test(line)) {
      flushPara();
      closeList();
      html += "<hr>";
    } else if (list && /^\s{2,}\S/.test(raw)) {
      // continuation of a list item
      html = html.replace(/<\/li>$/, ` ${inline(line.trim())}</li>`);
    } else {
      closeList();
      para.push(line);
    }
  }
  flushPara();
  closeList();
  return html;
}

export function escapeHtml(s) {
  return esc(String(s ?? ""));
}
