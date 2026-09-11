// Flight-log rail: pick a local log folder (File System Access API, Chrome/Edge), list the logs, then drag one
// onto a completed flying slot (or drop a file from the desktop) to upload and attach it.
(function () {
  const btn = document.getElementById('pickFolder'), list = document.getElementById('railList');
  let files = [];
  if (btn && !window.showDirectoryPicker) { btn.disabled = true; btn.title = 'Needs Chrome or Edge'; }
  if (btn) btn.onclick = async () => {
    let dir;
    try { dir = await window.showDirectoryPicker(); } catch { return; } // cancelled
    files = [];
    for await (const [name, h] of dir.entries()) if (h.kind === 'file' && /\.(bin|log|ulg|csv|txt)$/i.test(name)) files.push(await h.getFile());
    files.sort((a, b) => b.lastModified - a.lastModified);
    list.innerHTML = '';
    if (!files.length) { list.textContent = 'No log files (.bin .log .ulg .csv .txt) in that folder.'; return; }
    files.slice(0, 200).forEach((f, i) => {
      const el = document.createElement('div');
      el.className = 'rail-item'; el.draggable = true;
      el.textContent = `${f.name} · ${(f.size / 1048576).toFixed(1)} MB · ${new Date(f.lastModified).toLocaleString()}`;
      el.ondragstart = e => e.dataTransfer.setData('text/rail', String(i));
      list.append(el);
    });
  };
  document.querySelectorAll('tr[data-session]').forEach(row => {
    if (!row.dataset.session) return;
    row.ondragover = e => { e.preventDefault(); row.classList.add('drop'); };
    row.ondragleave = () => row.classList.remove('drop');
    row.ondrop = async e => {
      e.preventDefault(); row.classList.remove('drop');
      const i = e.dataTransfer.getData('text/rail'), file = i !== '' ? files[+i] : e.dataTransfer.files[0];
      if (!file) return;
      const fd = new FormData(); fd.append('file', file, file.name);
      row.style.opacity = 0.5;
      const r = await fetch(`/rpto/sessions/${row.dataset.session}/track?json=1`, { method: 'POST', body: fd }).catch(() => null);
      const j = r ? await r.json().catch(() => ({})) : { error: 'Network error' };
      if (!r || !r.ok) { row.style.opacity = 1; alert(j.error || 'Upload failed'); return; }
      location.reload();
    };
  });
})();
