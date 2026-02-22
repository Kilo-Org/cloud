/**
 * Inline HTML dashboard for exercising the Gastown API.
 * Served at GET / — protected by Cloudflare Access in production.
 * In development, auth middleware is skipped so the dashboard works without JWTs.
 */
export function dashboardHtml(): string {
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Gastown Dashboard</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: ui-monospace, "Cascadia Code", "Fira Code", Menlo, monospace;
         font-size: 13px; background: #0d1117; color: #c9d1d9; padding: 16px; }
  h1 { font-size: 18px; margin-bottom: 12px; color: #58a6ff; }
  h2 { font-size: 14px; margin: 16px 0 6px; color: #79c0ff; border-bottom: 1px solid #21262d; padding-bottom: 4px; }
  .row { display: flex; gap: 8px; align-items: center; margin-bottom: 6px; flex-wrap: wrap; }
  label { color: #8b949e; min-width: 60px; }
  input, select { background: #161b22; border: 1px solid #30363d; color: #c9d1d9;
                  padding: 4px 8px; border-radius: 4px; font-family: inherit; font-size: 12px; }
  input:focus, select:focus { border-color: #58a6ff; outline: none; }
  input[type="text"] { min-width: 220px; }
  button { background: #21262d; border: 1px solid #30363d; color: #c9d1d9;
           padding: 4px 12px; border-radius: 4px; cursor: pointer; font-family: inherit; font-size: 12px; }
  button:hover { background: #30363d; border-color: #58a6ff; }
  button.primary { background: #1f6feb; border-color: #1f6feb; color: #fff; }
  button.primary:hover { background: #388bfd; }
  button.danger { background: #da3633; border-color: #da3633; color: #fff; }
  button.danger:hover { background: #f85149; }
  .panel { background: #161b22; border: 1px solid #30363d; border-radius: 6px;
           padding: 12px; margin-bottom: 12px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  @media (max-width: 900px) { .grid { grid-template-columns: 1fr; } }
  pre.log { background: #0d1117; border: 1px solid #21262d; border-radius: 4px;
            padding: 8px; max-height: 300px; overflow: auto; white-space: pre-wrap;
            word-break: break-all; font-size: 11px; color: #8b949e; margin-top: 6px; }
  pre.log .ok { color: #3fb950; }
  pre.log .err { color: #f85149; }
  pre.log .info { color: #58a6ff; }
  table { width: 100%; border-collapse: collapse; margin-top: 6px; font-size: 12px; }
  th { text-align: left; color: #8b949e; padding: 4px 6px; border-bottom: 1px solid #21262d; }
  td { padding: 4px 6px; border-bottom: 1px solid #21262d; }
  td.id { font-family: inherit; color: #58a6ff; cursor: pointer; }
  td.id:hover { text-decoration: underline; }
  .badge { display: inline-block; padding: 1px 6px; border-radius: 10px; font-size: 11px; }
  .badge.open { background: #1f6feb33; color: #58a6ff; }
  .badge.in_progress { background: #d29922aa; color: #e3b341; }
  .badge.closed { background: #3fb95033; color: #3fb950; }
  .badge.idle { background: #21262d; color: #8b949e; }
  .badge.working { background: #d29922aa; color: #e3b341; }
  .badge.blocked { background: #f8514933; color: #f85149; }
  .badge.dead { background: #f8514966; color: #f85149; }
  .empty { color: #484f58; font-style: italic; }
  #toast { position: fixed; bottom: 16px; right: 16px; background: #1f6feb;
           color: #fff; padding: 8px 16px; border-radius: 6px; font-size: 12px;
           display: none; z-index: 100; }
  #toast.err { background: #da3633; }
  .chip { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 11px;
          background: #21262d; border: 1px solid #30363d; color: #8b949e; cursor: pointer;
          margin: 2px; }
  .chip:hover { border-color: #58a6ff; color: #c9d1d9; }
  .chip.active { background: #1f6feb33; border-color: #58a6ff; color: #58a6ff; }
  .chip .remove { margin-left: 4px; color: #484f58; font-size: 10px; }
  .chip .remove:hover { color: #f85149; }
</style>
</head>
<body>

<h1>Gastown Dashboard</h1>

<!-- Rig ID selector -->
<div class="panel">
  <div class="row">
    <label>Rig ID</label>
    <input type="text" id="rigId" placeholder="my-rig" value="" />
    <button onclick="generateRigId()">Random</button>
    <button class="primary" onclick="refreshAll()">Load Rig</button>
  </div>
  <div id="rigHistory" class="row" style="margin-top:4px;flex-wrap:wrap"></div>
</div>

<div class="grid">

<!-- Left column: Agents -->
<div>
  <div class="panel">
    <h2>Agents</h2>
    <div class="row">
      <input type="text" id="agentName" placeholder="name" style="min-width:100px" />
      <select id="agentRole">
        <option value="polecat">polecat</option>
        <option value="refinery">refinery</option>
        <option value="mayor">mayor</option>
        <option value="witness">witness</option>
      </select>
      <input type="text" id="agentIdentity" placeholder="identity" style="min-width:120px" />
      <button class="primary" onclick="registerAgent()">Register</button>
    </div>
    <div id="agentsList"></div>
  </div>

  <div class="panel">
    <h2>Mail</h2>
    <div class="row">
      <select id="mailFrom"></select>
      <span style="color:#484f58">→</span>
      <select id="mailTo"></select>
    </div>
    <div class="row">
      <input type="text" id="mailSubject" placeholder="subject" style="min-width:120px" />
      <input type="text" id="mailBody" placeholder="body" style="flex:1;min-width:180px" />
      <button class="primary" onclick="sendMail()">Send</button>
    </div>
    <div class="row" style="margin-top:6px">
      <select id="mailCheckAgent"></select>
      <button onclick="checkMail()">Check Mail</button>
    </div>
    <div id="mailResult"></div>
  </div>

  <div class="panel">
    <h2>Agent Actions</h2>
    <div class="row">
      <label>Agent</label>
      <select id="actionAgent"></select>
    </div>
    <div class="row">
      <button onclick="primeAgent()">Prime</button>
      <button onclick="readCheckpoint()">Read Checkpoint</button>
    </div>
    <div class="row">
      <input type="text" id="hookBeadId" placeholder="bead ID to hook" style="min-width:160px" />
      <button onclick="hookBead()">Hook</button>
      <button onclick="unhookBead()">Unhook</button>
    </div>
    <div class="row">
      <input type="text" id="doneBranch" placeholder="branch" style="min-width:100px" />
      <input type="text" id="donePrUrl" placeholder="PR URL (optional)" style="min-width:140px" />
      <button onclick="agentDone()">Done</button>
    </div>
    <div class="row">
      <input type="text" id="checkpointData" placeholder='checkpoint JSON e.g. {"step":3}' style="flex:1;min-width:200px" />
      <button onclick="writeCheckpoint()">Write Checkpoint</button>
    </div>
    <div id="actionResult"></div>
  </div>
</div>

<!-- Right column: Beads + Review Queue -->
<div>
  <div class="panel">
    <h2>Beads</h2>
    <div class="row">
      <input type="text" id="beadTitle" placeholder="title" style="min-width:120px" />
      <select id="beadType">
        <option value="issue">issue</option>
        <option value="message">message</option>
        <option value="escalation">escalation</option>
        <option value="merge_request">merge_request</option>
      </select>
      <select id="beadPriority">
        <option value="medium">medium</option>
        <option value="low">low</option>
        <option value="high">high</option>
        <option value="critical">critical</option>
      </select>
      <button class="primary" onclick="createBead()">Create</button>
    </div>
    <div class="row">
      <input type="text" id="beadBody" placeholder="body (optional)" style="flex:1;min-width:200px" />
    </div>
    <div id="beadsList"></div>
  </div>

  <div class="panel">
    <h2>Review Queue</h2>
    <div class="row">
      <select id="rqAgent"></select>
      <input type="text" id="rqBeadId" placeholder="bead ID" style="min-width:140px" />
      <input type="text" id="rqBranch" placeholder="branch" style="min-width:100px" />
      <button class="primary" onclick="submitReview()">Submit</button>
    </div>
    <div id="reviewResult"></div>
  </div>

  <div class="panel">
    <h2>Escalations</h2>
    <div class="row">
      <input type="text" id="escTitle" placeholder="title" style="min-width:140px" />
      <input type="text" id="escBody" placeholder="body" style="flex:1;min-width:160px" />
      <button class="danger" onclick="createEscalation()">Escalate</button>
    </div>
    <div id="escalationResult"></div>
  </div>
</div>
</div>

<!-- Town Container -->
<div class="panel">
  <h2>Town Container</h2>
  <div class="row">
    <label>Mode</label>
    <select id="containerMode" onchange="updateContainerModeHint()">
      <option value="direct">Direct (localhost:8080)</option>
      <option value="proxy">Proxy (via Worker)</option>
    </select>
    <span id="containerModeHint" style="color:#484f58;font-size:11px">
      Run: <code style="color:#79c0ff">cd container && bun run src/main.ts</code>
    </span>
  </div>
  <div class="row">
    <label>Town ID</label>
    <input type="text" id="townId" placeholder="town-abc" style="min-width:160px" />
    <button onclick="generateTownId()">Random</button>
    <button class="primary" onclick="containerHealth()">Health</button>
  </div>
  <div id="containerHealthResult"></div>

  <h2 style="margin-top:12px">Start Agent in Container</h2>
  <div class="row">
    <input type="text" id="cAgentId" placeholder="agent ID" style="min-width:140px" />
    <input type="text" id="cAgentName" placeholder="name" style="min-width:100px" />
    <select id="cAgentRole">
      <option value="polecat">polecat</option>
      <option value="refinery">refinery</option>
      <option value="mayor">mayor</option>
    </select>
  </div>
  <div class="row">
    <input type="text" id="cModel" placeholder="model" value="anthropic/claude-sonnet-4.6" style="min-width:220px" />
    <input type="text" id="cBranch" placeholder="branch" style="min-width:120px" />
  </div>
  <div class="row">
    <input type="text" id="cGitUrl" placeholder="git URL" style="flex:1;min-width:240px" />
    <input type="text" id="cDefaultBranch" placeholder="default branch" value="main" style="min-width:100px" />
  </div>
  <div class="row">
    <input type="text" id="cPrompt" placeholder="prompt" style="flex:1;min-width:300px" />
  </div>
  <div class="row">
    <input type="text" id="cSystemPrompt" placeholder="system prompt (short)" value="You are a helpful coding agent." style="flex:1;min-width:300px" />
  </div>
  <div class="row">
    <button class="primary" onclick="containerStartAgent()">Start Agent</button>
  </div>

  <h2 style="margin-top:12px">Agent Control</h2>
  <div class="row">
    <input type="text" id="cControlAgentId" placeholder="agent ID" style="min-width:180px" />
    <button onclick="containerAgentStatus()">Status</button>
    <button onclick="containerStopAgent()">Stop</button>
    <button class="danger" onclick="containerKillAgent()">Kill</button>
  </div>
  <div class="row">
    <input type="text" id="cMessage" placeholder="follow-up message" style="flex:1;min-width:240px" />
    <button class="primary" onclick="containerSendMessage()">Send Message</button>
  </div>
  <div id="containerResult"></div>
</div>

<!-- Log -->
<div class="panel">
  <h2>API Log</h2>
  <button onclick="document.getElementById('apiLog').textContent=''">Clear</button>
  <pre class="log" id="apiLog"></pre>
</div>

<div id="toast"></div>

<script>
function el(id) { return document.getElementById(id); }
function rigId() { return el('rigId').value.trim(); }

function generateRigId() {
  el('rigId').value = 'rig-' + crypto.randomUUID().slice(0, 8);
}

// ── Rig history (localStorage) ──────────────────────────────────────

const RIG_HISTORY_KEY = 'gastown_rig_history';
const RIG_LAST_KEY = 'gastown_last_rig';
const MAX_HISTORY = 20;

function getRigHistory() {
  try { return JSON.parse(localStorage.getItem(RIG_HISTORY_KEY) || '[]'); }
  catch { return []; }
}

function saveRigToHistory(id) {
  if (!id) return;
  let history = getRigHistory().filter(h => h !== id);
  history.unshift(id);
  if (history.length > MAX_HISTORY) history = history.slice(0, MAX_HISTORY);
  localStorage.setItem(RIG_HISTORY_KEY, JSON.stringify(history));
  localStorage.setItem(RIG_LAST_KEY, id);
  renderRigHistory();
}

function removeRigFromHistory(id, event) {
  event.stopPropagation();
  let history = getRigHistory().filter(h => h !== id);
  localStorage.setItem(RIG_HISTORY_KEY, JSON.stringify(history));
  if (localStorage.getItem(RIG_LAST_KEY) === id) {
    localStorage.setItem(RIG_LAST_KEY, history[0] || '');
  }
  renderRigHistory();
}

function loadRigFromHistory(id) {
  el('rigId').value = id;
  refreshAll();
}

function renderRigHistory() {
  const history = getRigHistory();
  const current = rigId();
  const container = el('rigHistory');
  if (!history.length) {
    container.innerHTML = '<span class="empty">No recent rigs</span>';
    return;
  }
  container.innerHTML = '<label style="min-width:60px">Recent</label>' + history.map(id =>
    '<span class="chip' + (id === current ? ' active' : '') + '" onclick="loadRigFromHistory(\\'' + esc(id) + '\\')">'
    + esc(id)
    + '<span class="remove" onclick="removeRigFromHistory(\\'' + esc(id) + '\\', event)">&times;</span>'
    + '</span>'
  ).join('');
}

// ── API helper ──────────────────────────────────────────────────────

async function api(method, path, body) {
  const log = el('apiLog');
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);

  const tag = method + ' ' + path;
  log.innerHTML += '<span class="info">' + esc(tag) + '</span>\\n';

  try {
    const res = await fetch(path, opts);
    const data = await res.json();
    const cls = res.ok ? 'ok' : 'err';
    log.innerHTML += '<span class="' + cls + '">' + res.status + '</span> '
      + esc(JSON.stringify(data, null, 2)) + '\\n\\n';
    log.scrollTop = log.scrollHeight;
    if (!res.ok) toast(data.error || res.status, true);
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    log.innerHTML += '<span class="err">FETCH ERROR: ' + esc(e.message) + '</span>\\n\\n';
    toast(e.message, true);
    return { ok: false, status: 0, data: null };
  }
}

function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

function toast(msg, isErr) {
  const t = el('toast');
  t.textContent = msg;
  t.className = isErr ? 'err' : '';
  t.style.display = 'block';
  setTimeout(() => t.style.display = 'none', 3000);
}

function badge(status) {
  return '<span class="badge ' + status + '">' + status + '</span>';
}

function short(id) { return id ? id.slice(0, 8) : '—'; }

// ── Agents ──────────────────────────────────────────────────────────

let agents = [];

async function loadAgents() {
  if (!rigId()) return;
  const r = await api('GET', '/api/rigs/' + rigId() + '/agents');
  if (!r.ok) return;
  agents = r.data.data || [];
  renderAgents();
  populateAgentSelects();
}

function renderAgents() {
  if (!agents.length) { el('agentsList').innerHTML = '<p class="empty">No agents</p>'; return; }
  let h = '<table><tr><th>ID</th><th>Name</th><th>Role</th><th>Status</th><th>Hook</th></tr>';
  for (const a of agents) {
    h += '<tr>'
      + '<td class="id" onclick="copyId(\\'' + a.id + '\\')">' + short(a.id) + '</td>'
      + '<td>' + esc(a.name) + '</td>'
      + '<td>' + a.role + '</td>'
      + '<td>' + badge(a.status) + '</td>'
      + '<td>' + (a.current_hook_bead_id ? short(a.current_hook_bead_id) : '—') + '</td>'
      + '</tr>';
  }
  h += '</table>';
  el('agentsList').innerHTML = h;
}

function populateAgentSelects() {
  const ids = ['mailFrom','mailTo','mailCheckAgent','actionAgent','rqAgent'];
  for (const id of ids) {
    const sel = el(id);
    const prev = sel.value;
    sel.innerHTML = agents.map(a =>
      '<option value="' + a.id + '">' + esc(a.name) + ' (' + short(a.id) + ')</option>'
    ).join('');
    if (prev && [...sel.options].some(o => o.value === prev)) sel.value = prev;
  }
}

async function registerAgent() {
  if (!rigId()) { toast('Set a Rig ID first', true); return; }
  const name = el('agentName').value.trim();
  const role = el('agentRole').value;
  const identity = el('agentIdentity').value.trim() || name;
  if (!name) { toast('Agent name required', true); return; }
  const r = await api('POST', '/api/rigs/' + rigId() + '/agents', { role, name, identity });
  if (r.ok) { el('agentName').value = ''; el('agentIdentity').value = ''; await loadAgents(); toast('Agent registered'); }
}

// ── Beads ───────────────────────────────────────────────────────────

let beads = [];

async function loadBeads() {
  if (!rigId()) return;
  const r = await api('GET', '/api/rigs/' + rigId() + '/beads');
  if (!r.ok) return;
  beads = r.data.data || [];
  renderBeads();
}

function renderBeads() {
  if (!beads.length) { el('beadsList').innerHTML = '<p class="empty">No beads</p>'; return; }
  let h = '<table><tr><th>ID</th><th>Title</th><th>Type</th><th>Status</th><th>Assignee</th><th></th></tr>';
  for (const b of beads) {
    h += '<tr>'
      + '<td class="id" onclick="copyId(\\'' + b.id + '\\')">' + short(b.id) + '</td>'
      + '<td>' + esc(b.title) + '</td>'
      + '<td>' + b.type + '</td>'
      + '<td>' + badge(b.status) + '</td>'
      + '<td>' + (b.assignee_agent_id ? short(b.assignee_agent_id) : '—') + '</td>'
      + '<td>'
      + (b.status !== 'closed' ? '<button onclick="closeBead(\\'' + b.id + '\\')">Close</button>' : '')
      + '</td>'
      + '</tr>';
  }
  h += '</table>';
  el('beadsList').innerHTML = h;
}

async function createBead() {
  if (!rigId()) { toast('Set a Rig ID first', true); return; }
  const title = el('beadTitle').value.trim();
  if (!title) { toast('Bead title required', true); return; }
  const body = {
    title,
    type: el('beadType').value,
    priority: el('beadPriority').value,
    body: el('beadBody').value.trim() || undefined,
  };
  const r = await api('POST', '/api/rigs/' + rigId() + '/beads', body);
  if (r.ok) { el('beadTitle').value = ''; el('beadBody').value = ''; await loadBeads(); toast('Bead created'); }
}

async function closeBead(beadId) {
  if (!agents.length) { toast('Register an agent first (needed for close)', true); return; }
  await api('POST', '/api/rigs/' + rigId() + '/beads/' + beadId + '/close', { agent_id: agents[0].id });
  await loadBeads();
}

// ── Hooks ───────────────────────────────────────────────────────────

async function hookBead() {
  const agentId = el('actionAgent').value;
  const beadId = el('hookBeadId').value.trim();
  if (!agentId || !beadId) { toast('Select agent and enter bead ID', true); return; }
  const r = await api('POST', '/api/rigs/' + rigId() + '/agents/' + agentId + '/hook', { bead_id: beadId });
  if (r.ok) { el('hookBeadId').value = ''; await refreshAll(); toast('Hooked'); }
}

async function unhookBead() {
  const agentId = el('actionAgent').value;
  if (!agentId) { toast('Select an agent', true); return; }
  const r = await api('DELETE', '/api/rigs/' + rigId() + '/agents/' + agentId + '/hook');
  if (r.ok) { await refreshAll(); toast('Unhooked'); }
}

// ── Prime / Checkpoint / Done ───────────────────────────────────────

async function primeAgent() {
  const agentId = el('actionAgent').value;
  if (!agentId) return;
  const r = await api('GET', '/api/rigs/' + rigId() + '/agents/' + agentId + '/prime');
  if (r.ok) {
    el('actionResult').innerHTML = '<pre class="log">' + esc(JSON.stringify(r.data.data, null, 2)) + '</pre>';
  }
}

async function writeCheckpoint() {
  const agentId = el('actionAgent').value;
  const raw = el('checkpointData').value.trim();
  if (!agentId) { toast('Select an agent', true); return; }
  let data;
  try { data = JSON.parse(raw || '{}'); } catch { toast('Invalid JSON', true); return; }
  const r = await api('POST', '/api/rigs/' + rigId() + '/agents/' + agentId + '/checkpoint', { data });
  if (r.ok) toast('Checkpoint written');
}

async function readCheckpoint() {
  const agentId = el('actionAgent').value;
  if (!agentId) return;
  // Checkpoint is returned in the prime response
  const r = await api('GET', '/api/rigs/' + rigId() + '/agents/' + agentId + '/prime');
  if (r.ok) {
    const cp = r.data.data?.agent?.checkpoint;
    el('actionResult').innerHTML = '<pre class="log">'
      + (cp ? esc(JSON.stringify(cp, null, 2)) : '<span class="empty">No checkpoint data</span>') + '</pre>';
  }
}

async function agentDone() {
  const agentId = el('actionAgent').value;
  const branch = el('doneBranch').value.trim();
  if (!agentId || !branch) { toast('Select agent and enter branch', true); return; }
  const body = { branch, pr_url: el('donePrUrl').value.trim() || undefined };
  const r = await api('POST', '/api/rigs/' + rigId() + '/agents/' + agentId + '/done', body);
  if (r.ok) { el('doneBranch').value = ''; el('donePrUrl').value = ''; await refreshAll(); toast('Agent done'); }
}

// ── Mail ────────────────────────────────────────────────────────────

async function sendMail() {
  const from = el('mailFrom').value;
  const to = el('mailTo').value;
  const subject = el('mailSubject').value.trim();
  const body = el('mailBody').value.trim();
  if (!from || !to || !subject) { toast('Fill in from, to, subject', true); return; }
  const r = await api('POST', '/api/rigs/' + rigId() + '/mail', {
    from_agent_id: from, to_agent_id: to, subject, body: body || subject,
  });
  if (r.ok) { el('mailSubject').value = ''; el('mailBody').value = ''; toast('Mail sent'); }
}

async function checkMail() {
  const agentId = el('mailCheckAgent').value;
  if (!agentId) return;
  const r = await api('GET', '/api/rigs/' + rigId() + '/agents/' + agentId + '/mail');
  if (r.ok) {
    const msgs = r.data.data || [];
    if (!msgs.length) {
      el('mailResult').innerHTML = '<p class="empty">No undelivered mail</p>';
    } else {
      let h = '<table><tr><th>From</th><th>Subject</th><th>Body</th></tr>';
      for (const m of msgs) {
        h += '<tr><td>' + short(m.from_agent_id) + '</td><td>' + esc(m.subject) + '</td><td>' + esc(m.body) + '</td></tr>';
      }
      h += '</table>';
      el('mailResult').innerHTML = h;
    }
  }
}

// ── Review Queue ────────────────────────────────────────────────────

async function submitReview() {
  const agent_id = el('rqAgent').value;
  const bead_id = el('rqBeadId').value.trim();
  const branch = el('rqBranch').value.trim();
  if (!agent_id || !bead_id || !branch) { toast('Fill all fields', true); return; }
  const r = await api('POST', '/api/rigs/' + rigId() + '/review-queue', { agent_id, bead_id, branch });
  if (r.ok) {
    el('rqBeadId').value = ''; el('rqBranch').value = '';
    el('reviewResult').innerHTML = '<p class="ok" style="color:#3fb950">Submitted to review queue</p>';
    toast('Review submitted');
  }
}

// ── Escalations ─────────────────────────────────────────────────────

async function createEscalation() {
  if (!rigId()) { toast('Set a Rig ID first', true); return; }
  const title = el('escTitle').value.trim();
  const body = el('escBody').value.trim();
  if (!title) { toast('Escalation title required', true); return; }
  const r = await api('POST', '/api/rigs/' + rigId() + '/escalations', { title, body: body || title });
  if (r.ok) { el('escTitle').value = ''; el('escBody').value = ''; await loadBeads(); toast('Escalation created'); }
}

// ── Town Container ──────────────────────────────────────────────────

const CONTAINER_DIRECT_BASE = 'http://localhost:8080';

function containerMode() { return el('containerMode').value; }
function townId() { return el('townId').value.trim(); }

function generateTownId() {
  el('townId').value = 'town-' + crypto.randomUUID().slice(0, 8);
}

function updateContainerModeHint() {
  const hint = el('containerModeHint');
  if (containerMode() === 'direct') {
    hint.innerHTML = 'Run: <code style="color:#79c0ff">cd container && bun run src/main.ts</code>';
  } else {
    hint.innerHTML = 'Routes via Worker <code style="color:#79c0ff">/api/towns/:townId/container/*</code>';
  }
}

// Route container requests based on mode
async function containerApi(method, path, body) {
  if (containerMode() === 'direct') {
    // Direct to container on localhost:8080, no auth needed
    const log = el('apiLog');
    const url = CONTAINER_DIRECT_BASE + path;
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    if (body !== undefined) opts.body = JSON.stringify(body);

    const tag = method + ' ' + url;
    log.innerHTML += '<span class="info">' + esc(tag) + '</span>\\n';

    try {
      const res = await fetch(url, opts);
      const data = await res.json();
      const cls = res.ok ? 'ok' : 'err';
      log.innerHTML += '<span class="' + cls + '">' + res.status + '</span> '
        + esc(JSON.stringify(data, null, 2)) + '\\n\\n';
      log.scrollTop = log.scrollHeight;
      if (!res.ok) toast(data.error || res.status, true);
      return { ok: res.ok, status: res.status, data };
    } catch (e) {
      log.innerHTML += '<span class="err">FETCH ERROR: ' + esc(e.message)
        + '</span>\\n  Is the container running? <code>cd container && bun run src/main.ts</code>\\n\\n';
      toast(e.message, true);
      return { ok: false, status: 0, data: null };
    }
  } else {
    // Proxy via Worker routes (needs townId)
    if (!townId()) { toast('Set a Town ID', true); return { ok: false, status: 0, data: null }; }
    return api(method, '/api/towns/' + townId() + '/container' + path, body);
  }
}

async function containerHealth() {
  const r = await containerApi('GET', '/health');
  if (r.ok) {
    const d = r.data;
    el('containerHealthResult').innerHTML =
      '<p style="color:#3fb950">Status: ' + d.status
      + ' | Agents: ' + d.agents
      + ' | Uptime: ' + Math.round((d.uptime || 0) / 1000) + 's</p>';
  } else {
    el('containerHealthResult').innerHTML = '<p class="err" style="color:#f85149">Container unreachable</p>';
  }
}

async function containerStartAgent() {
  const agentId = el('cAgentId').value.trim();
  const name = el('cAgentName').value.trim();
  const role = el('cAgentRole').value;
  const model = el('cModel').value.trim();
  const branch = el('cBranch').value.trim();
  const gitUrl = el('cGitUrl').value.trim();
  const defaultBranch = el('cDefaultBranch').value.trim();
  const prompt = el('cPrompt').value.trim();
  const systemPrompt = el('cSystemPrompt').value.trim();

  if (!agentId || !name || !prompt || !gitUrl || !branch) {
    toast('Fill in agent ID, name, git URL, branch, and prompt', true);
    return;
  }

  const body = {
    agentId,
    rigId: rigId() || 'default-rig',
    townId: townId() || 'default-town',
    role,
    name,
    identity: name,
    prompt,
    model: model || 'anthropic/claude-sonnet-4.6',
    systemPrompt: systemPrompt || 'You are a helpful coding agent.',
    gitUrl,
    branch,
    defaultBranch: defaultBranch || 'main',
  };

  const r = await containerApi('POST', '/agents/start', body);
  if (r.ok) {
    el('cControlAgentId').value = agentId;
    el('containerResult').innerHTML = '<pre class="log">' + esc(JSON.stringify(r.data, null, 2)) + '</pre>';
    toast('Agent started');
  }
}

async function containerAgentStatus() {
  const agentId = el('cControlAgentId').value.trim();
  if (!agentId) { toast('Enter agent ID', true); return; }
  const r = await containerApi('GET', '/agents/' + agentId + '/status');
  if (r.ok) {
    el('containerResult').innerHTML = '<pre class="log">' + esc(JSON.stringify(r.data, null, 2)) + '</pre>';
  }
}

async function containerStopAgent() {
  const agentId = el('cControlAgentId').value.trim();
  if (!agentId) { toast('Enter agent ID', true); return; }
  const r = await containerApi('POST', '/agents/' + agentId + '/stop', {});
  if (r.ok) toast('Agent stopped');
}

async function containerKillAgent() {
  const agentId = el('cControlAgentId').value.trim();
  if (!agentId) { toast('Enter agent ID', true); return; }
  const r = await containerApi('POST', '/agents/' + agentId + '/stop', { signal: 'SIGKILL' });
  if (r.ok) toast('Agent killed');
}

async function containerSendMessage() {
  const agentId = el('cControlAgentId').value.trim();
  const prompt = el('cMessage').value.trim();
  if (!agentId || !prompt) { toast('Enter agent ID and message', true); return; }
  const r = await containerApi('POST', '/agents/' + agentId + '/message', { prompt });
  if (r.ok) { el('cMessage').value = ''; toast('Message sent'); }
}

// ── Helpers ─────────────────────────────────────────────────────────

function copyId(id) {
  navigator.clipboard.writeText(id).then(() => toast('Copied: ' + id));
}

async function refreshAll() {
  if (!rigId()) { toast('Enter a Rig ID', true); return; }
  saveRigToHistory(rigId());
  await Promise.all([loadAgents(), loadBeads()]);
}

// ── Init ────────────────────────────────────────────────────────────

// Restore last rig from localStorage, or generate a random one
const lastRig = localStorage.getItem(RIG_LAST_KEY);
if (lastRig) {
  el('rigId').value = lastRig;
} else {
  generateRigId();
}
generateTownId();
renderRigHistory();

// Auto-load the last rig's data on page load
if (lastRig) {
  refreshAll();
}
</script>
</body>
</html>`;
}
