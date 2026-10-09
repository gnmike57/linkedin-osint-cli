const $ = (id) => document.getElementById(id);

function fmtLast(last) {
  if (!last) return 'no capture yet';
  const when = new Date(last.at).toLocaleTimeString();
  return last.ok
    ? `last sent ${when} \u2713`
    : `last attempt ${when} failed \u2014 ${last.error || 'HTTP ' + last.status}`;
}

async function refresh() {
  try {
    const s = await chrome.runtime.sendMessage({ type: 'getStatus' });
    if (!s) return;
    if (s.seconds) $('every').value = s.seconds;
    const q = s.queryId ? 'queryId \u2713' : 'queryId pending (run a People search)';
    $('auto').textContent = `Auto-send: ${fmtLast(s.lastSend)} \u00b7 ${q}`;
  } catch (e) {
    $('auto').textContent = 'Auto-send: ' + e;
  }
}

$('cap').addEventListener('click', async () => {
  const st = $('st');
  st.textContent = 'Sending\u2026';
  try {
    const r = await chrome.runtime.sendMessage({ type: 'capture' });
    st.textContent = r && r.ok ? 'Sent \u2713' : 'Failed: ' + ((r && r.error) || ('HTTP ' + (r && r.status)));
  } catch (e) {
    st.textContent = 'Failed: ' + e;
  }
  refresh();
});

$('qid').addEventListener('click', async () => {
  const st = $('qst');
  st.textContent = 'Opening a background tab to learn the queryId\u2026';
  try {
    const r = await chrome.runtime.sendMessage({ type: 'captureQueryId' });
    if (r && r.ok) {
      st.textContent = 'queryId \u2713 ' + r.query_id;
      // Push it to the CLI immediately so the next scrape uses it.
      await chrome.runtime.sendMessage({ type: 'capture' });
    } else {
      st.textContent = 'Failed: ' + ((r && r.error) || 'unknown error');
    }
  } catch (e) {
    st.textContent = 'Failed: ' + e;
  }
  refresh();
});

$('save').addEventListener('click', async () => {
  const seconds = Math.max(30, Math.floor(Number($('every').value) || 60));
  const r = await chrome.runtime.sendMessage({ type: 'setAutoSend', seconds });
  const applied = (r && r.seconds) || seconds;
  $('every').value = applied;
  // chrome.alarms clamps periods below 30s, so be explicit about the floor.
  $('auto').textContent = `Auto-send: every ${applied}s (minimum 30s)`;
  refresh();
});

refresh();
