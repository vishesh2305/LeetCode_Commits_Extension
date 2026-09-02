import { labelFor } from '../src/lib/mappings.js';

const $ = (id) => document.getElementById(id);

const TEXT_FIELDS = ['token', 'owner', 'repo', 'branch', 'rootPath', 'commitTemplate'];
const CHECK_FIELDS = [
  'groupByDifficulty', 'includeHeader', 'writeProblemReadme',
  'writeIndexReadme', 'keepLatestSolution', 'onlyAccepted', 'notify', 'debug'
];

let settings = {};

/* ------------------------------- plumbing ------------------------------- */

const send = (type, payload) =>
  new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, payload }, (res) => {
      const err = chrome.runtime.lastError;
      if (err) return reject(new Error(err.message));
      if (!res) return reject(new Error('Background worker did not respond.'));
      if (!res.ok) return reject(new Error(res.error));
      resolve(res.data);
    });
  });

let saveTimer = null;
function save(patch, immediate = false) {
  settings = { ...settings, ...patch };
  clearTimeout(saveTimer);
  const run = async () => {
    await send('SAVE_SETTINGS', { patch });
    flash('Saved');
    paintHeader();
  };
  if (immediate) run();
  else saveTimer = setTimeout(run, 350);
}

function flash(msg) {
  const node = $('saveState');
  node.textContent = msg;
  clearTimeout(flash.t);
  flash.t = setTimeout(() => { node.textContent = 'Changes save automatically'; }, 1600);
}

function banner(kind, html) {
  const b = $('banner');
  b.className = `banner ${kind}`;
  b.innerHTML = html;
  b.hidden = false;
}

/* --------------------------------- tabs --------------------------------- */

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('is-active', t === tab));
    document.querySelectorAll('.panel').forEach((p) =>
      p.classList.toggle('is-active', p.dataset.panel === tab.dataset.tab));
  });
});

/* ------------------------------- rendering ------------------------------- */

function paintHeader() {
  const pill = $('repoPill');
  if (settings.owner && settings.repo) {
    const vis = settings.repoIsPrivate === true ? ' · private'
      : settings.repoIsPrivate === false ? ' · public' : '';
    pill.textContent = `${settings.owner}/${settings.repo}${vis}`;
  } else {
    pill.textContent = settings.token ? 'Choose a repository' : 'Not connected';
  }

  const mode = $('modePill');
  const label = { prompt: 'Prompt', auto: 'Auto', off: 'Paused' }[settings.mode] || 'Prompt';
  mode.textContent = label;
  mode.className = 'mode-pill' + (settings.mode === 'auto' ? ' on' : settings.mode === 'off' ? ' off' : '');

  const link = $('openRepo');
  if (settings.owner && settings.repo) {
    link.href = `https://github.com/${settings.owner}/${settings.repo}`;
    link.hidden = false;
  } else {
    link.hidden = true;
  }
}

function paintForm() {
  TEXT_FIELDS.forEach((k) => { if ($(k)) $(k).value = settings[k] ?? ''; });
  CHECK_FIELDS.forEach((k) => { if ($(k)) $(k).checked = !!settings[k]; });
  $('padWidth').value = String(settings.padWidth ?? 4);
  document.querySelectorAll('#mode button').forEach((b) =>
    b.classList.toggle('is-on', b.dataset.mode === (settings.mode || 'prompt')));
}

function paintProgress({ summary, progress }) {
  $('sTotal').textContent = summary.total;
  $('sStreak').textContent = summary.streak;
  $('sWeek').textContent = summary.thisWeek;
  $('sPush').textContent = summary.pushes;

  const max = Math.max(1, ...['Easy', 'Medium', 'Hard'].map((d) => summary.counts[d] || 0));
  document.querySelectorAll('.diff').forEach((row) => {
    const n = summary.counts[row.dataset.d] || 0;
    row.querySelector('.d-num').textContent = n;
    row.querySelector('.d-track i').style.width = `${Math.round((n / max) * 100)}%`;
  });

  const list = $('activity');
  const items = (progress.activity || []).slice(0, 8);
  list.innerHTML = '';
  if (!items.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'Nothing pushed yet. Solve a problem on LeetCode to get started.';
    list.appendChild(li);
    return;
  }

  const color = { Easy: 'var(--teal)', Medium: 'var(--orange)', Hard: 'var(--red)' };
  items.forEach((a) => {
    const li = document.createElement('li');
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = color[a.difficulty] || 'var(--muted)';

    const title = document.createElement('span');
    title.className = 'a-title';
    title.textContent = `${a.frontendId}. ${a.title}`;
    title.title = `${labelFor(a.lang)}${a.runtime ? ' · ' + a.runtime : ''}`;

    const when = document.createElement('span');
    when.className = 'a-when';
    when.textContent = ago(a.ts);

    if (a.commitUrl) {
      const link = document.createElement('a');
      link.href = a.commitUrl;
      link.target = '_blank';
      link.rel = 'noopener';
      link.style.cssText = 'display:flex;align-items:center;gap:8px;flex:1 1 auto;min-width:0';
      link.append(dot, title);
      li.append(link, when);
    } else {
      li.append(dot, title, when);
    }
    list.appendChild(li);
  });
}

function ago(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 604800) return `${Math.floor(s / 86400)}d`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/* -------------------------------- wiring -------------------------------- */

TEXT_FIELDS.forEach((k) => {
  const node = $(k);
  if (node) node.addEventListener('input', () => save({ [k]: node.value.trim() }));
});

CHECK_FIELDS.forEach((k) => {
  const node = $(k);
  if (node) node.addEventListener('change', () => save({ [k]: node.checked }, true));
});

$('debug').addEventListener('change', async () => {
  if (activeTab) await askTab(activeTab.id, 'LGS_SET_DEBUG', { debug: $('debug').checked });
});

$('padWidth').addEventListener('change', (e) => save({ padWidth: Number(e.target.value) }, true));

document.querySelectorAll('#mode button').forEach((b) => {
  b.addEventListener('click', () => {
    save({ mode: b.dataset.mode }, true);
    document.querySelectorAll('#mode button').forEach((x) => x.classList.toggle('is-on', x === b));
  });
});

$('reveal').addEventListener('click', () => {
  const input = $('token');
  input.type = input.type === 'password' ? 'text' : 'password';
});

$('loadRepos').addEventListener('click', async (e) => {
  const token = $('token').value.trim();
  if (!token) return banner('err', 'Enter a GitHub token first.');
  e.target.disabled = true;
  e.target.textContent = 'Loading…';
  try {
    const repos = await send('LIST_REPOS', { token });
    const select = $('repoSelect');
    select.innerHTML = '<option value="">— select —</option>';
    repos.forEach((r) => {
      const opt = document.createElement('option');
      opt.value = `${r.owner}/${r.name}`;
      opt.textContent = `${r.fullName}${r.private ? '  (private)' : ''}`;
      opt.dataset.private = String(r.private);
      select.appendChild(opt);
    });
    if (settings.owner && settings.repo) select.value = `${settings.owner}/${settings.repo}`;
    $('repoSelectField').hidden = false;
    banner('ok', `Found ${repos.length} writable repositor${repos.length === 1 ? 'y' : 'ies'}.`);
  } catch (err) {
    banner('err', escapeHtml(err.message));
  } finally {
    e.target.disabled = false;
    e.target.textContent = 'Load my repos';
  }
});

$('repoSelect').addEventListener('change', (e) => {
  const [owner, repo] = e.target.value.split('/');
  if (!owner || !repo) return;
  const isPrivate = e.target.selectedOptions[0]?.dataset.private === 'true';
  $('owner').value = owner;
  $('repo').value = repo;
  save({ owner, repo, repoIsPrivate: isPrivate }, true);
});

$('newRepoToggle').addEventListener('click', () => {
  const box = $('newRepoBox');
  box.hidden = !box.hidden;
});

$('createRepo').addEventListener('click', async (e) => {
  const token = $('token').value.trim();
  const name = $('newRepoName').value.trim();
  if (!token) return banner('err', 'Enter a GitHub token first.');
  if (!name) return banner('err', 'Give the new repository a name.');
  e.target.disabled = true;
  e.target.textContent = 'Creating…';
  try {
    const r = await send('CREATE_REPO', { token, name, isPrivate: $('newRepoPrivate').checked });
    $('owner').value = r.owner;
    $('repo').value = r.name;
    save({ owner: r.owner, repo: r.name, repoIsPrivate: r.private }, true);
    $('newRepoBox').hidden = true;
    banner('ok', `Created <code>${escapeHtml(r.owner)}/${escapeHtml(r.name)}</code> (${r.private ? 'private' : 'public'}).`);
  } catch (err) {
    banner('err', escapeHtml(err.message));
  } finally {
    e.target.disabled = false;
    e.target.textContent = 'Create repository';
  }
});

$('test').addEventListener('click', async (e) => {
  const token = $('token').value.trim();
  const owner = $('owner').value.trim();
  const repo = $('repo').value.trim();
  const branch = $('branch').value.trim();
  if (!token || !owner || !repo) return banner('err', 'Token, owner and repository are all required.');
  e.target.disabled = true;
  e.target.textContent = 'Checking…';
  try {
    const info = await send('TEST_CONNECTION', { token, owner, repo, branch });
    settings = { ...settings, repoIsPrivate: info.private, githubLogin: info.login };
    paintHeader();

    const kind = info.tokenKind === 'fine-grained' ? 'fine-grained token'
      : info.tokenKind === 'classic' ? 'classic token' : 'token';
    const scopes = info.scopes ? ` · scopes: <code>${escapeHtml(info.scopes || 'none')}</code>` : '';

    if (info.canWrite) {
      banner('ok',
        `Connected as <b>${escapeHtml(info.login)}</b> → <code>${escapeHtml(info.repo)}</code> ` +
        `(${info.private ? 'private' : 'public'}), branch <code>${escapeHtml(branch || info.defaultBranch)}</code>.<br>` +
        `Write access confirmed with the ${kind}${scopes}. Ready to push.`);
    } else {
      banner('err',
        `Signed in as <b>${escapeHtml(info.login)}</b> and <code>${escapeHtml(info.repo)}</code> is readable, ` +
        `but <b>writes are refused</b>.<br><br>${escapeHtml(info.reason || '')}${scopes}`);
    }
  } catch (err) {
    banner('err', escapeHtml(err.message));
  } finally {
    e.target.disabled = false;
    e.target.textContent = 'Test connection';
  }
});

$('reset').addEventListener('click', async () => {
  if (!confirm('Clear locally tracked progress? Files already on GitHub are untouched.')) return;
  await send('RESET_PROGRESS');
  await refresh();
  flash('Progress cleared');
});

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* --------------------------------- boot --------------------------------- */

/* --------------------------- tab diagnostics --------------------------- */

const askTab = (tabId, type, payload) =>
  new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type, payload }, (res) => {
      if (chrome.runtime.lastError) return resolve({ ok: false, error: chrome.runtime.lastError.message });
      resolve(res || { ok: false, error: 'no response' });
    });
  });

let activeTab = null;

async function checkTab() {
  const diag = $('diag');
  const btn = $('pushLast');
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTab = tab;

  if (!tab?.url || !/^https:\/\/leetcode\.(com|cn)\//.test(tab.url)) {
    diag.className = 'diag';
    diag.textContent = 'Open a LeetCode problem tab to see its status here.';
    btn.disabled = true;
    return;
  }

  const res = await askTab(tab.id, 'LGS_PING');
  if (!res.ok) {
    diag.className = 'diag bad';
    diag.innerHTML =
      'Not attached to this tab. Chrome only injects into tabs opened <b>after</b> the extension loaded — ' +
      '<b>reload the LeetCode tab</b>, then reopen this popup.';
    btn.disabled = true;
    return;
  }

  const slug = res.data?.slug;
  diag.className = 'diag good';
  diag.innerHTML = slug
    ? `Attached · watching <b>${escapeHtml(slug)}</b>`
    : 'Attached · open a problem page to start watching';
  btn.disabled = !slug;
}

$('pushLast').addEventListener('click', async (e) => {
  if (!activeTab) return;
  e.target.disabled = true;
  const label = e.target.textContent;
  e.target.textContent = 'Fetching…';
  const res = await askTab(activeTab.id, 'LGS_PUSH_LAST');
  e.target.textContent = label;
  e.target.disabled = false;
  const diag = $('diag');
  if (res.ok) {
    diag.className = 'diag good';
    diag.innerHTML = `Submission <b>${escapeHtml(String(res.data.submissionId))}</b> (${escapeHtml(res.data.status)}) surfaced on the page — check the card there.`;
    window.close();
  } else {
    diag.className = 'diag bad';
    diag.textContent = res.error;
  }
});

async function refresh() {
  const state = await send('GET_STATE');
  settings = state.settings;
  paintForm();
  paintHeader();
  paintProgress(state);
  checkTab().catch(() => {});
}

refresh().catch((err) => banner('err', escapeHtml(err.message)));
