import { labelFor } from '../src/lib/mappings.js';

const $ = (id) => document.getElementById(id);

const TEXT_FIELDS = ['token', 'owner', 'repo', 'branch', 'rootPath', 'commitTemplate'];
const CHECK_FIELDS = [
  'groupByDifficulty', 'includeHeader', 'writeProblemReadme',
  'writeIndexReadme', 'keepLatestSolution', 'onlyAccepted', 'notify', 'debug',
  'bulkSkipPushed'
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
  $('bulkDelayMs').value = String(settings.bulkDelayMs ?? 1000);
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
$('bulkDelayMs').addEventListener('change', (e) => save({ bulkDelayMs: Number(e.target.value) }, true));

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

  // A tab opened before the last extension reload runs the old content script.
  // It answers a ping but cannot do anything new, so say so rather than look fine.
  if ((Number(res.data?.version) || 1) < REQUIRED_CS_VERSION) {
    diag.className = 'diag bad';
    diag.innerHTML =
      'This tab is running an <b>older version</b> of the extension — ' +
      '<b>reload the LeetCode tab</b> to pick up the current one.';
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


/* -------------------------------- library -------------------------------- */

/**
 * The Library tab lists every problem the LeetCode account has ever solved and
 * lets you push any subset of them. The list is cached in extension storage, so
 * reopening the popup is instant; the bulk run itself lives in the background
 * worker and keeps going once this popup closes.
 */

const MAX_ROWS = 300;             // the popup stays responsive; filters reach the rest

// Keep in step with CS_VERSION in src/content.js.
const REQUIRED_CS_VERSION = 2;

let library = { items: [], fetchedAt: null };
let pushed = new Set();           // slugs already synced to GitHub
let selection = new Set();
let filters = { text: '', difficulty: 'all', state: 'all' };
let jobTimer = null;

function libBanner(kind, text) {
  const b = $('libBanner');
  if (!text) { b.hidden = true; return; }
  b.className = `banner ${kind}`;
  b.textContent = text;
  b.hidden = false;
}

async function loadLibrary() {
  const data = await send('GET_LIBRARY');
  library = data.library;
  pushed = new Set(data.pushed.map(String));
  selection = new Set((data.library.selection || []).filter((s) => !!s));
  paintLibrary();
  paintJob(data.job);
}

/** progress.solved is keyed by frontend id, the library by slug — match on both. */
const isPushed = (item) => pushed.has(String(item.frontendId)) || pushed.has(item.slug);

function visibleItems() {
  const q = filters.text.trim().toLowerCase();
  return library.items.filter((it) => {
    if (filters.difficulty !== 'all' && it.difficulty !== filters.difficulty) return false;
    if (filters.state === 'new' && isPushed(it)) return false;
    if (filters.state === 'done' && !isPushed(it)) return false;
    if (!q) return true;
    return it.title.toLowerCase().includes(q) || String(it.frontendId).startsWith(q);
  });
}

function paintLibrary() {
  const list = $('libList');
  const shown = visibleItems();
  list.innerHTML = '';

  if (!library.items.length) {
    list.appendChild(emptyRow('Nothing loaded yet — hit “Load solved problems”.'));
  } else if (!shown.length) {
    list.appendChild(emptyRow('No problem matches these filters.'));
  } else {
    const frag = document.createDocumentFragment();
    shown.slice(0, MAX_ROWS).forEach((it) => frag.appendChild(libraryRow(it)));
    list.appendChild(frag);
  }

  const trunc = $('libTrunc');
  if (shown.length > MAX_ROWS) {
    trunc.hidden = false;
    trunc.textContent =
      `Showing the first ${MAX_ROWS} of ${shown.length} — narrow the filters to see the rest. ` +
      `“Select all shown” still covers all ${shown.length}.`;
  } else {
    trunc.hidden = true;
  }

  const notPushed = library.items.filter((it) => !isPushed(it)).length;
  $('libMeta').textContent = library.fetchedAt
    ? `${library.items.length} solved on LeetCode · ${notPushed} not yet on GitHub · loaded ${ago(library.fetchedAt)} ago`
    : 'Pulls every problem your LeetCode account has ever solved. Needs a signed-in LeetCode tab — one is opened in the background if you have none.';

  const allShownSelected = shown.length > 0 && shown.every((it) => selection.has(it.slug));
  $('libAll').checked = allShownSelected;
  $('libAll').indeterminate = !allShownSelected && shown.some((it) => selection.has(it.slug));

  $('libCount').textContent = `${selection.size} selected`;
  $('pushSelected').disabled = selection.size === 0;
  $('pushSelected').textContent = selection.size
    ? `Push selected (${selection.size})`
    : 'Push selected';
  $('pushAll').disabled = library.items.length === 0;
  $('pushAll').textContent = settings.bulkSkipPushed && notPushed !== library.items.length
    ? `Push all (${notPushed})`
    : `Push all (${library.items.length})`;
}

function emptyRow(text) {
  const li = document.createElement('li');
  li.className = 'empty';
  li.textContent = text;
  return li;
}

function libraryRow(item) {
  const li = document.createElement('li');
  li.className = 'row-item' + (isPushed(item) ? ' is-pushed' : '');

  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = selection.has(item.slug);

  const id = document.createElement('span');
  id.className = 'l-id';
  id.textContent = item.frontendId;

  const title = document.createElement('span');
  title.className = 'l-title';
  title.textContent = item.title;
  title.title = item.title;

  const tag = document.createElement('span');
  tag.className = 'l-tag';
  tag.dataset.d = item.difficulty;
  tag.textContent = (item.difficulty || '?').slice(0, 1).toUpperCase();
  tag.title = item.difficulty || 'Unknown';

  li.append(box, id, title, tag);

  if (isPushed(item)) {
    const done = document.createElement('span');
    done.className = 'l-done';
    done.textContent = '✓';
    done.title = 'Already pushed to GitHub';
    li.appendChild(done);
  }
  if (item.paidOnly) {
    const lock = document.createElement('span');
    lock.className = 'l-lock';
    lock.textContent = '🔒';
    lock.title = 'Premium problem — the statement may not be fetchable';
    li.appendChild(lock);
  }

  li.addEventListener('click', (e) => {
    const on = e.target === box ? box.checked : !selection.has(item.slug);
    if (e.target !== box) box.checked = on;
    toggle(item.slug, on);
  });
  return li;
}

function toggle(slug, on) {
  if (on) selection.add(slug);
  else selection.delete(slug);
  persistSelection();
  paintLibrary();
}

let selectionTimer = null;
function persistSelection() {
  clearTimeout(selectionTimer);
  selectionTimer = setTimeout(
    () => send('SAVE_SELECTION', { selection: [...selection] }).catch(() => {}),
    250
  );
}

/* ------------------------------ library wiring ------------------------------ */

$('loadSolved').addEventListener('click', async (e) => {
  const btn = e.target;
  btn.disabled = true;
  btn.textContent = 'Asking LeetCode…';
  libBanner(null, '');
  try {
    const data = await send('REFRESH_LIBRARY');
    library = data.library;
    pushed = new Set(data.pushed.map(String));
    paintLibrary();
    libBanner('ok', `Found ${data.library.items.length} solved problems on LeetCode.`);
  } catch (err) {
    libBanner('err', err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Reload solved problems';
  }
});

$('libSearch').addEventListener('input', (e) => {
  filters.text = e.target.value;
  paintLibrary();
});

document.querySelectorAll('#libDiff button').forEach((b) => {
  b.addEventListener('click', () => {
    filters.difficulty = b.dataset.d;
    document.querySelectorAll('#libDiff button').forEach((x) => x.classList.toggle('is-on', x === b));
    paintLibrary();
  });
});

document.querySelectorAll('#libState button').forEach((b) => {
  b.addEventListener('click', () => {
    filters.state = b.dataset.s;
    document.querySelectorAll('#libState button').forEach((x) => x.classList.toggle('is-on', x === b));
    paintLibrary();
  });
});

$('libAll').addEventListener('change', (e) => {
  const shown = visibleItems();
  shown.forEach((it) => (e.target.checked ? selection.add(it.slug) : selection.delete(it.slug)));
  persistSelection();
  paintLibrary();
});

$('bulkSkipPushed').addEventListener('change', () => paintLibrary());

$('pushSelected').addEventListener('click', () =>
  startBulk(library.items.filter((it) => selection.has(it.slug))));

$('pushAll').addEventListener('click', () => startBulk(library.items));

async function startBulk(items) {
  if (!settings.token || !settings.owner || !settings.repo) {
    return libBanner('err', 'Finish the Repository tab first — a token and a target repo are required.');
  }

  let queue = items;
  if (settings.bulkSkipPushed) queue = queue.filter((it) => !isPushed(it));
  if (!queue.length) {
    return libBanner('ok', 'Everything selected is already on GitHub. Untick “Skip problems already pushed” to push them again.');
  }
  const minutes = Math.ceil((queue.length * ((settings.bulkDelayMs || 1000) + 1800)) / 60000);
  if (!confirm(
    `Push ${queue.length} problem${queue.length === 1 ? '' : 's'} to ` +
    `${settings.owner}/${settings.repo}?\n\n` +
    `This takes roughly ${minutes} minute${minutes === 1 ? '' : 's'} and keeps running in the ` +
    `background after you close this popup.`
  )) return;

  libBanner(null, '');
  try {
    const job = await send('START_BULK', { slugs: queue.map((it) => it.slug) });
    selection.clear();                 // the run owns these now; start the list clean
    persistSelection();
    paintLibrary();
    paintJob(job);
  } catch (err) {
    libBanner('err', err.message);
  }
}

$('jobPause').addEventListener('click', async () => {
  const job = $('jobPause').dataset.action === 'resume'
    ? await send('RESUME_BULK')
    : await send('PAUSE_BULK');
  paintJob(job);
});

$('jobCancel').addEventListener('click', async () => {
  const done = ['done', 'cancelled'].includes($('jobBox').dataset.status);
  if (!done && !confirm('Stop the bulk push? Problems already pushed stay on GitHub.')) return;
  paintJob(await send(done ? 'CLEAR_JOB' : 'CANCEL_BULK'));
  await loadLibrary();
});

/* -------------------------------- job view -------------------------------- */

function paintJob(job) {
  const box = $('jobBox');
  if (!job || job.status === 'idle') {
    box.hidden = true;
    stopJobPolling();
    return;
  }

  box.hidden = false;
  box.dataset.status = job.status;
  box.classList.toggle('is-done', job.status === 'done');
  box.classList.toggle('is-bad', ['cancelled', 'interrupted'].includes(job.status));

  const pct = job.total ? Math.round((job.done / job.total) * 100) : 0;
  $('jobBar').style.width = `${pct}%`;
  $('jobCount').textContent = `${job.done} / ${job.total}`;

  $('jobTitle').textContent = {
    running: 'Pushing your solved problems…',
    paused: 'Paused',
    done: 'Bulk push finished',
    cancelled: 'Bulk push cancelled',
    interrupted: 'Bulk push was interrupted'
  }[job.status] || 'Bulk push';

  const parts = [];
  if (job.pushed) parts.push(`${job.pushed} pushed`);
  if (job.failed) parts.push(`${job.failed} failed`);
  if (job.status === 'running' && job.current?.slug) parts.push(job.current.slug);
  if (job.status === 'interrupted') parts.push('Chrome suspended the extension — resume to finish');
  if (job.message) parts.push(job.message);
  $('jobSub').textContent = parts.join(' · ') || 'Starting…';

  const finished = ['done', 'cancelled'].includes(job.status);
  const pause = $('jobPause');
  pause.hidden = finished;
  pause.dataset.action = job.status === 'running' ? 'pause' : 'resume';
  pause.textContent = job.status === 'running' ? 'Pause' : 'Resume';
  pause.disabled = job.status !== 'running' && job.remaining === 0;
  $('jobCancel').textContent = finished ? 'Dismiss' : 'Cancel';

  const errs = job.errors || [];
  $('errBox').hidden = errs.length === 0;
  $('errCount').textContent = String(errs.length);
  const list = $('errList');
  list.innerHTML = '';
  errs.slice(-25).reverse().forEach((e) => {
    const li = document.createElement('li');
    const name = document.createElement('b');
    name.textContent = `${e.slug}: `;
    li.append(name, document.createTextNode(e.error));
    list.appendChild(li);
  });

  if (job.status === 'running') startJobPolling();
  else stopJobPolling();

  // A finished run changes the pushed set and the Progress tab numbers.
  if (finished && !paintJob.settled) {
    paintJob.settled = true;
    refresh().catch(() => {});
  }
  if (job.status === 'running') paintJob.settled = false;
}

function startJobPolling() {
  if (jobTimer) return;
  jobTimer = setInterval(async () => {
    try { paintJob(await send('GET_JOB')); } catch (_) { stopJobPolling(); }
  }, 1200);
}

function stopJobPolling() {
  clearInterval(jobTimer);
  jobTimer = null;
}

async function refresh() {
  const state = await send('GET_STATE');
  settings = state.settings;
  paintForm();
  paintHeader();
  paintProgress(state);
  checkTab().catch(() => {});
  loadLibrary().catch(() => {});
}

refresh().catch((err) => banner('err', escapeHtml(err.message)));
