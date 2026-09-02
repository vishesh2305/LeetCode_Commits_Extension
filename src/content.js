/**
 * Isolated-world content script.
 *
 * Two independent ways to notice a finished submission:
 *   1. the MAIN-world interceptor (fast, carries the source code directly)
 *   2. a GraphQL watcher started when you press Submit, which polls your own
 *      submission list — this works even if LeetCode changes its endpoints
 *
 * Whichever fires first wins; `handled` keeps the other from double-firing.
 */
(() => {
  'use strict';
  if (window.__LGS_CONTENT__) return;
  window.__LGS_CONTENT__ = true;

  const ORIGIN = location.origin;
  const GRAPHQL = `${ORIGIN}/graphql/`;
  const PENDING_STATUSES = new Set(['Pending', 'Judging', 'Started', 'Running', '']);

  const metaCache = new Map();
  const handled = new Set();          // submission ids already surfaced
  let settingsCache = null;
  let card = null;
  let escHandler = null;
  let debug = false;

  const log = (...a) => { if (debug) console.log('%c[LeetHub Sync]', 'color:#2cbb5d', ...a); };

  /* ------------------------------ bootstrap ------------------------------ */

  (async function boot() {
    try {
      settingsCache = await send('GET_SETTINGS');
      setDebug(!!settingsCache.debug);
    } catch (err) {
      console.warn('[LeetHub Sync] could not read settings:', err.message);
    }
    log('content script active on', location.href);
  })();

  function setDebug(on) {
    debug = !!on;
    try { localStorage.setItem('lgs-debug', on ? '1' : '0'); } catch (_) {}
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'LGS_SET_DEBUG') {
      setDebug(msg.payload?.debug);
      sendResponse({ ok: true });
      return false;
    }
    if (msg?.type === 'LGS_PUSH_LAST') {
      pushLatest()
        .then((data) => sendResponse({ ok: true, data }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    }
    if (msg?.type === 'LGS_PING') {
      sendResponse({ ok: true, data: { url: location.href, slug: slugFromLocation() } });
      return false;
    }
    return false;
  });

  /* ----------------------------- page bridge ----------------------------- */

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== ORIGIN) return;
    const data = event.data;
    if (!data || data.__lgs !== true || data.dir !== 'page->cs') return;

    if (data.type === 'SUBMIT_STARTED') {
      log('submit started', data.detail);
      beginWatch(data.detail.slug || slugFromLocation());
    }
    if (data.type === 'SUBMISSION_RESULT') {
      stopWatch();
      onResult(data.detail, 'interceptor').catch((e) => console.warn('[LeetHub Sync]', e));
    }
  });

  /* --------------------- fallback: watch my own submissions --------------------- */

  const watch = { timer: null, slug: null, baseline: null, until: 0 };

  document.addEventListener('click', (e) => {
    const btn = e.target?.closest?.('button, a');
    if (!btn) return;
    const label = (btn.textContent || '').trim();
    const isSubmit =
      btn.dataset?.e2eLocator === 'console-submit-button' ||
      btn.getAttribute?.('data-e2e-locator') === 'console-submit-button' ||
      (label.length <= 12 && /^submit$/i.test(label));
    if (isSubmit) {
      log('submit button clicked');
      beginWatch(slugFromLocation());
    }
  }, true);

  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && slugFromLocation()) {
      log('submit shortcut pressed');
      beginWatch(slugFromLocation());
    }
  }, true);

  /* Third net: LeetCode renders a verdict panel. If we see one and nothing is
     watching yet, start the poller — covers UI or endpoint changes entirely. */
  let observerDebounce = null;
  const resultObserver = new MutationObserver(() => {
    if (watch.timer || !slugFromLocation()) return;
    clearTimeout(observerDebounce);
    observerDebounce = setTimeout(() => {
      const panel =
        document.querySelector('[data-e2e-locator="submission-result"]') ||
        document.querySelector('[data-e2e-locator="console-result"]');
      if (!panel) return;
      const text = (panel.textContent || '').trim();
      if (!text || PENDING_STATUSES.has(text)) return;
      log('verdict panel detected:', text);
      beginWatch(slugFromLocation());
    }, 400);
  });

  const startObserver = () => {
    if (document.body) resultObserver.observe(document.body, { childList: true, subtree: true });
    else document.addEventListener('DOMContentLoaded', startObserver, { once: true });
  };
  startObserver();

  async function beginWatch(slug) {
    if (!slug) return;
    watch.until = Date.now() + 120000;
    if (watch.timer && watch.slug === slug) return;   // already watching this problem
    stopWatch();
    watch.slug = slug;

    // snapshot the submissions that already exist, so we only react to a new one
    try {
      const existing = await listSubmissions(slug, 20);
      watch.baseline = new Set(existing.map((s) => String(s.id)));
      log('watching', slug, '— baseline of', watch.baseline.size, 'submissions');
    } catch (err) {
      watch.baseline = new Set();
      log('baseline fetch failed:', err.message);
    }

    watch.timer = setInterval(tick, 2500);
    tick();
  }

  function stopWatch() {
    if (watch.timer) clearInterval(watch.timer);
    watch.timer = null;
  }

  async function tick() {
    if (Date.now() > watch.until) { log('watch expired'); return stopWatch(); }
    let list;
    try {
      list = await listSubmissions(watch.slug, 5);
    } catch (err) {
      return log('poll failed:', err.message);
    }
    const fresh = list.find(
      (s) => !watch.baseline.has(String(s.id)) &&
             !PENDING_STATUSES.has(s.statusDisplay || '') &&
             !handled.has(String(s.id))
    );
    if (!fresh) return;

    log('watcher found submission', fresh.id, fresh.statusDisplay);
    stopWatch();
    watch.baseline.add(String(fresh.id));

    const detail = await buildFromSubmission(fresh, watch.slug);
    onResult(detail, 'watcher').catch((e) => console.warn('[LeetHub Sync]', e));
  }

  /* ------------------------------ shared path ------------------------------ */

  async function onResult(result, source) {
    const id = String(result.submissionId || '');
    if (id && handled.has(id)) return log('already handled', id);
    if (id) handled.add(id);

    const settings = await send('GET_SETTINGS');
    settingsCache = settings;
    setDebug(!!settings.debug);
    log('verdict via', source, '—', result.statusMsg, '| mode:', settings.mode);

    if (settings.mode === 'off') return log('extension is paused (mode: off)');
    if (!result.accepted && settings.onlyAccepted !== false) {
      return log('not accepted, and "only accepted" is on — ignoring');
    }

    const problem = await fetchProblem(result.slug, result.questionId);
    if (!result.code) {
      log('no code from', source, '— fetching submission details');
      const d = await fetchDetails(result.submissionId);
      result.code = d?.code || null;
      result.lang = result.lang || d?.lang?.name || null;
    }

    if (settings.mode === 'auto') {
      renderCard({ problem, submission: result, settings, state: 'pushing' });
      doPush(problem, result, settings);
    } else {
      renderCard({ problem, submission: result, settings, state: 'ask' });
    }
  }

  /** Popup escape hatch: surface the most recent submission for this problem. */
  async function pushLatest() {
    const slug = slugFromLocation();
    if (!slug) throw new Error('Open a LeetCode problem page first.');
    const list = await listSubmissions(slug, 20);
    const settings = await send('GET_SETTINGS');
    const wanted = settings.onlyAccepted === false
      ? list.find((s) => !PENDING_STATUSES.has(s.statusDisplay || ''))
      : list.find((s) => s.statusDisplay === 'Accepted');
    if (!wanted) throw new Error(`No ${settings.onlyAccepted === false ? '' : 'accepted '}submission found for ${slug}.`);
    handled.delete(String(wanted.id));
    const detail = await buildFromSubmission(wanted, slug);
    await onResult(detail, 'manual');
    return { submissionId: wanted.id, status: wanted.statusDisplay };
  }

  /* ------------------------------- graphql ------------------------------- */

  async function graphql(query, variables) {
    const res = await fetch(GRAPHQL, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        ...(csrf() ? { 'x-csrftoken': csrf() } : {})
      },
      body: JSON.stringify({ query, variables })
    });
    if (!res.ok) throw new Error(`LeetCode GraphQL ${res.status}`);
    const json = await res.json();
    if (json.errors?.length) throw new Error(json.errors[0].message || 'GraphQL error');
    return json.data;
  }

  const csrf = () => {
    const m = /(?:^|;\s*)csrftoken=([^;]+)/.exec(document.cookie);
    return m ? m[1] : null;
  };

  /** LeetCode renamed this query; try the current name, then the legacy one. */
  async function listSubmissions(slug, limit) {
    const modern = `
      query lgsList($offset: Int!, $limit: Int!, $questionSlug: String!) {
        questionSubmissionList(offset: $offset, limit: $limit, questionSlug: $questionSlug) {
          submissions { id statusDisplay lang timestamp runtime memory }
        }
      }`;
    const legacy = `
      query lgsListLegacy($offset: Int!, $limit: Int!, $questionSlug: String!) {
        submissionList(offset: $offset, limit: $limit, questionSlug: $questionSlug) {
          submissions { id statusDisplay lang timestamp runtime memory }
        }
      }`;
    try {
      const d = await graphql(modern, { offset: 0, limit, questionSlug: slug });
      return d?.questionSubmissionList?.submissions || [];
    } catch (err) {
      const d = await graphql(legacy, { offset: 0, limit, questionSlug: slug });
      return d?.submissionList?.submissions || [];
    }
  }

  async function fetchDetails(submissionId) {
    const q = `
      query lgsDetails($submissionId: Int!) {
        submissionDetails(submissionId: $submissionId) {
          code
          statusCode
          runtimeDisplay
          memoryDisplay
          runtimePercentile
          memoryPercentile
          lang { name verboseName }
          question { questionId titleSlug title }
        }
      }`;
    try {
      const d = await graphql(q, { submissionId: Number(submissionId) });
      return d?.submissionDetails || null;
    } catch (err) {
      log('submissionDetails failed:', err.message);
      return null;
    }
  }

  async function buildFromSubmission(s, slug) {
    const d = await fetchDetails(s.id);
    return {
      accepted: s.statusDisplay === 'Accepted',
      submissionId: String(s.id),
      statusMsg: s.statusDisplay || 'Unknown',
      slug,
      lang: d?.lang?.name || s.lang || null,
      prettyLang: d?.lang?.verboseName || null,
      questionId: d?.question?.questionId || null,
      code: d?.code || null,
      runtime: d?.runtimeDisplay || s.runtime || null,
      memory: d?.memoryDisplay || s.memory || null,
      runtimePercentile: d?.runtimePercentile ?? null,
      memoryPercentile: d?.memoryPercentile ?? null,
      finishedAt: s.timestamp ? Number(s.timestamp) * 1000 : Date.now()
    };
  }

  const QUESTION_QUERY = `
    query lgsQuestion($titleSlug: String!) {
      question(titleSlug: $titleSlug) {
        questionId
        questionFrontendId
        title
        titleSlug
        difficulty
        content
        stats
        topicTags { name }
      }
    }`;

  async function fetchProblem(slug, fallbackQuestionId) {
    const key = slug || `id:${fallbackQuestionId}`;
    if (metaCache.has(key)) return metaCache.get(key);

    let q = null;
    try {
      if (slug) q = (await graphql(QUESTION_QUERY, { titleSlug: slug }))?.question;
    } catch (err) {
      log('question metadata failed:', err.message);
    }

    let acRate = null;
    try { acRate = q?.stats ? JSON.parse(q.stats).acRate : null; } catch (_) {}

    const problem = {
      questionId: q?.questionId || fallbackQuestionId || null,
      frontendId: q?.questionFrontendId || fallbackQuestionId || '0',
      title: q?.title || titleize(slug),
      slug: q?.titleSlug || slug,
      difficulty: q?.difficulty || null,
      content: q?.content || null,
      tags: (q?.topicTags || []).map((t) => t.name),
      acRate,
      url: `${ORIGIN}/problems/${q?.titleSlug || slug}/`
    };
    metaCache.set(key, problem);
    return problem;
  }

  const slugFromLocation = () => {
    const m = /\/problems\/([^/?#]+)/.exec(location.pathname);
    return m ? decodeURIComponent(m[1]) : null;
  };

  const titleize = (slug) =>
    String(slug || 'Unknown')
      .split('-')
      .filter(Boolean)
      .map((w) => w[0].toUpperCase() + w.slice(1))
      .join(' ');

  /* ------------------------------ messaging ------------------------------ */

  function send(type, payload) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type, payload }, (res) => {
        const err = chrome.runtime.lastError;
        if (err) return reject(new Error(err.message));
        if (!res) return reject(new Error('No response from the extension background.'));
        if (!res.ok) return reject(new Error(res.error));
        resolve(res.data);
      });
    });
  }

  /* ---------------------------------- UI ---------------------------------- */

  const isDark = () =>
    document.documentElement.classList.contains('dark') ||
    document.body?.classList.contains('dark') ||
    document.documentElement.dataset.theme === 'dark';

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  function closeCard() {
    if (escHandler) document.removeEventListener('keydown', escHandler);
    escHandler = null;
    if (!card) return;
    card.classList.add('lgs-out');
    const node = card;
    card = null;
    setTimeout(() => node.remove(), 180);
  }

  function shell() {
    closeCard();
    const host = el('div', `lgs-card ${isDark() ? 'lgs-dark' : 'lgs-light'}`);
    host.setAttribute('role', 'dialog');
    host.setAttribute('aria-live', 'polite');
    document.body.appendChild(host);
    card = host;

    escHandler = (e) => { if (e.key === 'Escape') closeCard(); };
    document.addEventListener('keydown', escHandler);

    const observer = new MutationObserver(() => {
      if (!card) return observer.disconnect();
      card.classList.toggle('lgs-dark', isDark());
      card.classList.toggle('lgs-light', !isDark());
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme'] });

    return host;
  }

  function header(host, { icon, tone, title, subtitle }) {
    const head = el('div', 'lgs-head');
    const badge = el('div', `lgs-badge lgs-${tone}`);
    badge.innerHTML = icon;
    head.appendChild(badge);

    const txt = el('div', 'lgs-headtext');
    txt.appendChild(el('div', 'lgs-title', title));
    if (subtitle) txt.appendChild(el('div', 'lgs-sub', subtitle));
    head.appendChild(txt);

    const close = el('button', 'lgs-close', '×');
    close.title = 'Dismiss (Esc)';
    close.addEventListener('click', closeCard);
    head.appendChild(close);

    host.appendChild(head);
    return head;
  }

  const ICON = {
    check: '<svg viewBox="0 0 20 20" width="15" height="15" fill="currentColor"><path d="M8.1 13.9 4.6 10.4a1 1 0 1 1 1.4-1.4l2.1 2.1 5.9-5.9a1 1 0 0 1 1.4 1.4l-6.6 6.6a1 1 0 0 1-1.4 0Z"/></svg>',
    github: '<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor"><path d="M8 0a8 8 0 0 0-2.5 15.6c.4.07.55-.17.55-.38v-1.35C3.84 14.3 3.4 13 3.4 13c-.36-.9-.87-1.15-.87-1.15-.7-.48.06-.47.06-.47.78.05 1.2.8 1.2.8.7 1.2 1.83.85 2.27.65.07-.5.27-.85.5-1.05-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 4 0c1.53-1.03 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.28.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48v2.2c0 .21.14.46.55.38A8 8 0 0 0 8 0Z"/></svg>',
    warn: '<svg viewBox="0 0 20 20" width="15" height="15" fill="currentColor"><path d="M10 2.5 18.5 17h-17L10 2.5Zm-1 5v4.5h2V7.5H9Zm0 6V15h2v-1.5H9Z"/></svg>',
    spin: '<svg viewBox="0 0 20 20" width="15" height="15" class="lgs-spin" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="10" cy="10" r="7" opacity=".25"/><path d="M17 10a7 7 0 0 0-7-7" stroke-linecap="round"/></svg>'
  };

  function metaRow(problem, submission) {
    const row = el('div', 'lgs-meta');
    row.appendChild(el('span', `lgs-chip lgs-diff-${(problem.difficulty || 'unknown').toLowerCase()}`,
      problem.difficulty || 'Unknown'));
    if (submission.prettyLang || submission.lang) {
      row.appendChild(el('span', 'lgs-chip', submission.prettyLang || submission.lang));
    }
    if (submission.runtime) row.appendChild(el('span', 'lgs-chip', submission.runtime));
    if (submission.memory) row.appendChild(el('span', 'lgs-chip', submission.memory));
    return row;
  }

  function renderCard({ problem, submission, settings, state }) {
    const host = shell();

    if (state === 'pushing') {
      header(host, {
        icon: ICON.spin, tone: 'busy',
        title: 'Pushing to GitHub…',
        subtitle: `${problem.frontendId}. ${problem.title}`
      });
      host.appendChild(el('div', 'lgs-bar')).appendChild(el('div', 'lgs-bar-fill'));
      return;
    }

    const accepted = submission.accepted;
    header(host, {
      icon: accepted ? ICON.check : ICON.warn,
      tone: accepted ? 'ok' : 'warn',
      title: accepted ? 'Accepted — push to GitHub?' : `${submission.statusMsg} — push anyway?`,
      subtitle: `${problem.frontendId}. ${problem.title}`
    });

    host.appendChild(metaRow(problem, submission));

    const target = el('div', 'lgs-path');
    target.appendChild(el('div', 'lgs-path-repo',
      settings.owner && settings.repo
        ? `${settings.owner}/${settings.repo}${settings.repoIsPrivate ? ' · private' : settings.repoIsPrivate === false ? ' · public' : ''}`
        : 'No repository configured'));
    target.appendChild(el('code', 'lgs-path-file', previewPath(problem, submission, settings)));
    host.appendChild(target);

    if (!settings.token || !settings.owner || !settings.repo) {
      host.appendChild(el('div', 'lgs-note', 'Finish setup in the extension popup before pushing.'));
    }
    if (!submission.code) {
      host.appendChild(el('div', 'lgs-note', 'Source code could not be retrieved for this submission.'));
    }

    const actions = el('div', 'lgs-actions');
    const skip = el('button', 'lgs-btn lgs-ghost', 'Skip');
    skip.addEventListener('click', closeCard);

    const push = el('button', 'lgs-btn lgs-primary');
    push.innerHTML = `${ICON.github}<span>Push to GitHub</span>`;
    push.disabled = !settings.token || !settings.owner || !settings.repo || !submission.code;
    push.addEventListener('click', () => {
      renderCard({ problem, submission, settings, state: 'pushing' });
      doPush(problem, submission, settings);
    });

    actions.append(skip, push);
    host.appendChild(actions);

    const always = el('label', 'lgs-always');
    const box = el('input');
    box.type = 'checkbox';
    box.addEventListener('change', () =>
      send('SAVE_SETTINGS', { patch: { mode: box.checked ? 'auto' : 'prompt' } }));
    always.append(box, el('span', null, 'Push automatically from now on'));
    host.appendChild(always);
  }

  const EXT = {
    python: 'py', python3: 'py', pythondata: 'py', java: 'java', c: 'c', cpp: 'cpp',
    csharp: 'cs', javascript: 'js', typescript: 'ts', react: 'jsx', php: 'php',
    swift: 'swift', kotlin: 'kt', dart: 'dart', golang: 'go', ruby: 'rb',
    scala: 'scala', rust: 'rs', racket: 'rkt', erlang: 'erl', elixir: 'ex',
    mysql: 'sql', mssql: 'sql', oraclesql: 'sql', postgresql: 'sql', bash: 'sh'
  };

  function previewPath(problem, submission, settings) {
    const width = Number(settings.padWidth ?? 4);
    const id = String(problem.frontendId || '0');
    const num = /^\d+$/.test(id) ? id.padStart(width, '0') : id;
    const root = String(settings.rootPath || '').replace(/^\/+|\/+$/g, '');
    const group = settings.groupByDifficulty && problem.difficulty ? `${problem.difficulty}/` : '';
    const ext = EXT[String(submission.lang || '').toLowerCase()] || 'txt';
    return `${root ? root + '/' : ''}${group}${num}-${problem.slug}/${problem.slug}-<timestamp>.${ext}`;
  }

  async function doPush(problem, submission, settings) {
    try {
      const result = await send('PUSH_SUBMISSION', { problem, submission });
      log('pushed', result.written);
      renderSuccess(problem, submission, settings, result);
    } catch (err) {
      log('push failed:', err.message);
      renderError(problem, submission, settings, err);
    }
  }

  function renderSuccess(problem, submission, settings, result) {
    const host = shell();
    header(host, {
      icon: ICON.check, tone: 'ok',
      title: 'Pushed to GitHub',
      subtitle: `${problem.frontendId}. ${problem.title}`
    });

    const path = el('div', 'lgs-path');
    path.appendChild(el('div', 'lgs-path-repo', `${settings.owner}/${settings.repo}`));
    path.appendChild(el('code', 'lgs-path-file', `${result.dir}/${result.fileName}`));
    host.appendChild(path);

    const stats = el('div', 'lgs-stats');
    stats.appendChild(stat(result.summary.total, 'solved'));
    stats.appendChild(stat(result.summary.streak, 'day streak'));
    stats.appendChild(stat(result.summary.thisWeek, 'this week'));
    host.appendChild(stats);

    if (result.failedExtras?.length) {
      host.appendChild(el('div', 'lgs-note', `Solution saved. Some extras failed: ${result.failedExtras[0]}`));
    }

    const actions = el('div', 'lgs-actions');
    const dismiss = el('button', 'lgs-btn lgs-ghost', 'Close');
    dismiss.addEventListener('click', closeCard);
    const open = el('a', 'lgs-btn lgs-primary');
    open.href = result.commitUrl || result.fileUrl || result.repoUrl;
    open.target = '_blank';
    open.rel = 'noopener';
    open.innerHTML = `${ICON.github}<span>View commit</span>`;
    actions.append(dismiss, open);
    host.appendChild(actions);

    setTimeout(() => { if (card === host) closeCard(); }, 9000);
  }

  function stat(value, label) {
    const box = el('div', 'lgs-stat');
    box.appendChild(el('div', 'lgs-stat-num', String(value)));
    box.appendChild(el('div', 'lgs-stat-label', label));
    return box;
  }

  function renderError(problem, submission, settings, err) {
    const host = shell();
    header(host, {
      icon: ICON.warn, tone: 'err',
      title: 'Push failed',
      subtitle: `${problem.frontendId}. ${problem.title}`
    });
    host.appendChild(el('div', 'lgs-error', err.message || String(err)));

    const actions = el('div', 'lgs-actions');
    const dismiss = el('button', 'lgs-btn lgs-ghost', 'Dismiss');
    dismiss.addEventListener('click', closeCard);
    const retry = el('button', 'lgs-btn lgs-primary', 'Retry');
    retry.addEventListener('click', () => {
      renderCard({ problem, submission, settings, state: 'pushing' });
      doPush(problem, submission, settings);
    });
    actions.append(dismiss, retry);
    host.appendChild(actions);
  }
})();
