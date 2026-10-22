// Shared helpers
const STATUS_LABEL = { not_started: "Not started", in_progress: "In progress", annotated: "Annotated", approved: "Approved" };

async function api(path, body) {
  const opts = body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
  const r = await fetch(path, opts);
  let j = null;
  try { j = await r.json(); } catch (e) { /* ignore */ }
  if (!r.ok) {
    const err = new Error((j && j.error) || ("HTTP " + r.status));
    err.status = r.status; err.data = j || {};
    throw err;
  }
  return j;
}

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function badge(status) {
  return `<span class="badge ${status}">${STATUS_LABEL[status] || status}</span>`;
}

function fmtTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  return d.toLocaleDateString() + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// ---- initials (remembered per browser) ----
function getUser() {
  try { return (localStorage.getItem("fa_user") || "").toUpperCase(); } catch (e) { return ""; }
}
function setUser(u) {
  try { localStorage.setItem("fa_user", (u || "").toUpperCase().trim()); } catch (e) { /* ignore */ }
}
function bindUserInput(input, onChange) {
  input.value = getUser();
  input.addEventListener("change", () => {
    const v = input.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
    input.value = v; setUser(v);
    if (onChange) onChange(v);
  });
}
function askUser(message) {
  return new Promise(resolve => {
    const bg = document.createElement("div");
    bg.className = "modal-bg";
    bg.innerHTML = `<div class="modal"><h2>Your initials</h2><div class="muted">${esc(message || "Initials are recorded with every save and approval.")}</div>
      <input maxlength="6" value="${esc(getUser())}" autofocus><div class="row-flex" style="justify-content:flex-end"><button class="cancel">Cancel</button><button class="primary ok">OK</button></div></div>`;
    document.body.appendChild(bg);
    const inp = bg.querySelector("input");
    inp.focus();
    const done = v => { bg.remove(); resolve(v); };
    const ok = () => {
      const v = inp.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
      if (!v) { inp.focus(); return; }
      setUser(v); done(v);
    };
    bg.querySelector(".ok").onclick = ok;
    bg.querySelector(".cancel").onclick = () => done(null);
    inp.addEventListener("keydown", e => { if (e.key === "Enter") ok(); if (e.key === "Escape") done(null); });
  });
}
async function requireUser(message) {
  const u = getUser();
  if (u) return u;
  return askUser(message);
}

let _toastTimer = null;
function toast(msg, isErr) {
  let t = document.querySelector(".toast");
  if (!t) { t = document.createElement("div"); t.className = "toast"; document.body.appendChild(t); }
  t.textContent = msg;
  t.classList.toggle("err", !!isErr);
  t.classList.add("show");
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => t.classList.remove("show"), isErr ? 5000 : 2200);
}
