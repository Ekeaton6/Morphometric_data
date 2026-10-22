(function () {
  let IMAGES = [], ORDER = [], COLS = [];
  const openState = (() => { try { return JSON.parse(localStorage.getItem("fa_open") || "{}"); } catch (e) { return {}; } })();
  const saveOpen = () => { try { localStorage.setItem("fa_open", JSON.stringify(openState)); } catch (e) { /* ignore */ } };

  bindUserInput(document.getElementById("user"));
  const search = document.getElementById("search");
  const statusFilter = document.getElementById("statusFilter");
  try {
    search.value = sessionStorage.getItem("fa_search") || "";
    statusFilter.value = sessionStorage.getItem("fa_status") || "";
  } catch (e) { /* ignore */ }

  async function load() {
    const [cfg, list, tpl] = await Promise.all([api("/api/config"), api("/api/images"), api("/api/template")]);
    COLS = cfg.list_columns; IMAGES = list.images; ORDER = list.group_order;
    document.getElementById("tplInfo").textContent = tpl.source === "learned"
      ? `learned from ${tpl.n} annotated images (${fmtTime(tpl.created)})` : "from the reference image (no learned template yet)";
    render();
    updatePresence();
  }

  // "open by EK" tags: who currently has an image open
  let PRES = {};
  async function updatePresence() {
    try { PRES = await api("/api/presence_all"); } catch (e) { return; }
    paintPresence();
  }
  function paintPresence() {
    document.querySelectorAll("[data-pres]").forEach(el => {
      const users = PRES[el.dataset.pres];
      if (users && users.length) {
        el.textContent = "open by " + users.map(u => u || "someone").join(", ");
        el.style.display = "";
      } else el.style.display = "none";
    });
  }
  setInterval(updatePresence, 20000);

  function counts(rows) {
    const c = { not_started: 0, in_progress: 0, annotated: 0, approved: 0 };
    rows.forEach(r => c[r.status]++);
    return c;
  }

  function progressBar(c, n) {
    const pct = k => (100 * c[k] / Math.max(n, 1)).toFixed(2) + "%";
    return `<div class="progress" title="${c.approved} approved, ${c.annotated} annotated, ${c.in_progress} in progress, ${c.not_started} not started">
      <span style="width:${pct("approved")};background:var(--s-app)"></span>
      <span style="width:${pct("annotated")};background:var(--s-ann)"></span>
      <span style="width:${pct("in_progress")};background:var(--s-prog)"></span></div>`;
  }

  function render() {
    const q = search.value.trim().toLowerCase();
    const sf = statusFilter.value;
    try { sessionStorage.setItem("fa_search", search.value); sessionStorage.setItem("fa_status", sf); } catch (e) { /* ignore */ }

    const all = counts(IMAGES);
    document.getElementById("summary").innerHTML =
      `<div class="card"><b>${IMAGES.length}</b> images</div>` +
      ["not_started", "in_progress", "annotated", "approved"].map(k => `<div class="card">${badge(k)} <b>${all[k]}</b></div>`).join("") +
      `<div class="card" style="flex:1;display:flex;align-items:center">${progressBar(all, IMAGES.length)}</div>`;

    const html = [];
    for (const g of ORDER) {
      const rows = IMAGES.filter(r => r.group === g);
      const c = counts(rows);
      const shown = rows.filter(r => (!sf || r.status === sf) &&
        (!q || r.id.toLowerCase().includes(q) || String(r.fish_id).toLowerCase().includes(q)));
      const filtering = q || sf;
      if (filtering && !shown.length) continue;
      const open = filtering ? true : !!openState[g];
      html.push(`<details class="group" data-g="${esc(g)}" ${open ? "open" : ""}>
        <summary><span class="caret">▶</span><span class="gname">${esc(g)}</span>
          ${progressBar(c, rows.length)}
          <span class="counts">${rows.length} images · ${c.approved} approved · ${c.annotated} annotated · ${c.in_progress} in progress${filtering ? ` · <b>${shown.length} shown</b>` : ""}</span>
        </summary>
        ${open ? tableHtml(shown) : ""}
      </details>`);
    }
    const gEl = document.getElementById("groups");
    gEl.innerHTML = html.join("") || `<div class="card muted">No images match.</div>`;
    gEl.querySelectorAll("details.group").forEach(d => {
      d.addEventListener("toggle", () => {
        const g = d.dataset.g;
        if (!(search.value.trim() || statusFilter.value)) { openState[g] = d.open; saveOpen(); }
        if (d.open && !d.querySelector("table")) {
          const rows = IMAGES.filter(r => r.group === g);
          d.insertAdjacentHTML("beforeend", tableHtml(rows));
          bindRows(d);
          paintPresence();
        }
      });
      bindRows(d);
    });
    paintPresence();
  }

  function tableHtml(rows) {
    const body = rows.map(r => `<tr class="row" data-id="${esc(r.id)}">
      <td><img class="thumb" loading="lazy" src="/img/thumb?id=${encodeURIComponent(r.id)}" alt=""></td>
      <td>${esc(r.id)}<span class="pres" data-pres="${esc(r.id)}" style="display:none"></span>${r.file_found ? "" : ' <span class="warn">(file missing)</span>'}${r.stale_landmark_set ? ' <span class="warn" title="Saved with an older landmark set">(old landmark set)</span>' : ""}</td>
      ${COLS.map(c => `<td>${esc(r.meta[c])}</td>`).join("")}
      <td>${badge(r.status)}</td>
      <td>${esc(r.annotator || "")}</td>
      <td>${esc(r.approver || "")}</td>
      <td class="muted">${r.updated_at ? esc(fmtTime(r.updated_at)) + (r.updated_by ? " · " + esc(r.updated_by) : "") : ""}</td>
    </tr>`).join("");
    return `<table class="list"><thead><tr><th></th><th>Image</th>${COLS.map(c => `<th>${esc(c)}</th>`).join("")}
      <th>Status</th><th>Annotator</th><th>Approver</th><th>Last edited</th></tr></thead><tbody>${body}</tbody></table>`;
  }

  function bindRows(root) {
    root.querySelectorAll("tr.row").forEach(tr => {
      if (tr._bound) return;
      tr._bound = true;
      tr.addEventListener("click", e => {
        const url = "/annotate?id=" + encodeURIComponent(tr.dataset.id);
        if (e.metaKey || e.ctrlKey) window.open(url, "_blank"); else location.href = url;
      });
    });
  }

  let t = null;
  search.addEventListener("input", () => { clearTimeout(t); t = setTimeout(render, 150); });
  statusFilter.addEventListener("change", render);
  document.getElementById("expandAll").onclick = () => { ORDER.forEach(g => openState[g] = true); saveOpen(); render(); };
  document.getElementById("collapseAll").onclick = () => { ORDER.forEach(g => openState[g] = false); saveOpen(); render(); };
  document.querySelectorAll("[data-exp]").forEach(b => b.onclick = () => {
    const scope = document.getElementById("exportScope").value;
    let url = "/api/export/" + b.dataset.exp + "?status=" + scope;
    if (b.dataset.exp === "landmarks.tps") url += "&include=all";
    location.href = url;
  });
  document.getElementById("recompute").onclick = async () => {
    try {
      const tpl = await api("/api/template/recompute", {});
      document.getElementById("tplInfo").textContent = `learned from ${tpl.n} annotated images (${fmtTime(tpl.created)})`;
      toast("Template updated");
    } catch (e) { toast(e.message, true); }
  };
  window.addEventListener("pageshow", e => { if (e.persisted) load(); });
  load().catch(e => toast(e.message, true));
})();
