// Day timeline: one lane for shared classes + one lane per trainee. Drag tiles to move, drag edges to resize.
// The server validates every move (overlaps, RPAS / simulator capacity, 06:00–19:00) and cascades later slots.
(function () {
  const cfg = JSON.parse(document.getElementById('tlData').textContent);
  const box = document.getElementById('tl'), msg = document.getElementById('tlMsg'), undoBtn = document.getElementById('undoBtn');
  const START = 6 * 60, END = 19 * 60, SPAN = END - START;
  const toMin = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
  const hhmm = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const pct = m => ((m - START) / SPAN * 100) + '%';
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const sessions = cfg.sessions.map(s => ({ ...s, start: toMin(s.start_time), end: toMin(s.end_time) }));
  const lanes = [{ id: null, name: 'All trainees (shared)' }, ...cfg.trainees];
  const undo = [];
  const say = (t, bad) => { msg.textContent = t; msg.style.color = bad ? 'var(--bad)' : 'var(--ok)'; };

  function render() {
    box.innerHTML = '';
    const ruler = el('div', 'tl-row tl-ruler'), rt = el('div', 'tl-track');
    ruler.append(el('div', 'tl-name', cfg.date));
    for (let m = START; m <= END; m += 60) { const t = el('span', 'tl-tick', hhmm(m)); t.style.left = pct(m); rt.append(t); }
    ruler.append(rt); box.append(ruler);
    for (const lane of lanes) {
      const row = el('div', 'tl-row'), track = el('div', 'tl-track');
      row.append(el('div', 'tl-name', lane.name));
      for (let m = START; m < END; m += 60) { const g = el('span', 'tl-grid'); g.style.left = pct(m); track.append(g); }
      sessions.filter(s => (s.trainee_id ?? null) === lane.id).forEach(s => track.append(tile(s, track)));
      row.append(track); box.append(row);
    }
    if (!sessions.length) box.append(el('div', 'empty', 'No sessions on this day.'));
  }

  function tile(s, track) {
    const t = el('div', `tl-tile ${s.type} ${s.status}`), lh = el('i', 'tl-h l'), rh = el('i', 'tl-h r');
    t.style.left = pct(s.start); t.style.width = ((s.end - s.start) / SPAN * 100) + '%';
    t.title = `${s.code || ''} ${s.title}\n${hhmm(s.start)}–${hhmm(s.end)}${s.asset ? ' · ' + s.asset : ''}${s.instructor ? ' · ' + s.instructor : ''}`;
    t.append(el('b', null, s.code || s.title.slice(0, 14)), el('span', null, ' ' + hhmm(s.start)), lh, rh);
    let mode = null, x0 = 0, ns = s.start, ne = s.end;
    t.onpointerdown = e => { mode = e.target === lh ? 'l' : e.target === rh ? 'r' : 'm'; x0 = e.clientX; ns = s.start; ne = s.end; t.setPointerCapture(e.pointerId); t.classList.add('drag'); };
    t.onpointermove = e => {
      if (!mode) return;
      const d = Math.round((e.clientX - x0) * SPAN / track.clientWidth); // 1-minute steps
      if (mode === 'm') { ns = s.start + d; ne = s.end + d; } else if (mode === 'l') ns = Math.min(s.start + d, s.end - 5); else ne = Math.max(s.end + d, s.start + 5);
      t.style.left = pct(ns); t.style.width = ((ne - ns) / SPAN * 100) + '%';
    };
    t.onpointerup = () => {
      if (!mode) return;
      mode = null; t.classList.remove('drag');
      if (ns === s.start && ne === s.end) { location.href = `/rpto/sessions/${s.id}`; return; } // a click, not a drag
      move(s, ns, ne);
    };
    return t;
  }

  async function post(url, data) {
    const r = await fetch(url, { method: 'POST', body: new URLSearchParams(data) }).catch(() => null);
    return r ? r.json().catch(() => ({ error: 'Server error' })) : { error: 'Network error' };
  }
  function apply(changes, useOld) {
    for (const c of changes) { const s = sessions.find(x => x.id === c.id); if (s) { s.start = useOld ? c.old.start : c.start; s.end = useOld ? c.old.end : c.end; } }
    render();
  }
  async function move(s, start, end) {
    const j = await post(`/rpto/sessions/${s.id}/move`, { date: cfg.date, start, end });
    if (j.error) { say(j.error, true); render(); return; }
    undo.push(j.changes); undoBtn.disabled = false;
    apply(j.changes);
    say(j.changes.length > 1 ? `Moved — ${j.changes.length - 1} later session(s) shifted.` : 'Moved.');
  }
  undoBtn.onclick = async () => {
    const last = undo.pop();
    if (!last) return;
    const j = await post(`/rpto/batches/${cfg.batch}/timeline/restore`, { changes: JSON.stringify(last) });
    if (j.error) { say(j.error, true); return; }
    apply(last, true); undoBtn.disabled = !undo.length; say('Undone.');
  };
  const gapVal = document.getElementById('gapVal');
  const setGap = async d => { const j = await post(`/rpto/batches/${cfg.batch}/gap`, { gap: Math.max(0, +gapVal.textContent + d) }); if (j.gap != null) gapVal.textContent = j.gap; };
  document.getElementById('gapMinus').onclick = () => setGap(-5);
  document.getElementById('gapPlus').onclick = () => setGap(5);
  render();
})();
