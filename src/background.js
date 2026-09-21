import { GitHub, GitHubError } from './lib/github.js';
import {
  getSettings, setSettings, getProgress, setProgress, recordPush, summarize,
  getJob, setJob, isStale, getLibrary, setLibrary, EMPTY_JOB
} from './lib/storage.js';
import {
  problemDir, submissionFileName, solutionHeader, problemReadme, indexReadme,
  commitMessage
} from './lib/format.js';
import { extFor, labelFor } from './lib/mappings.js';

/* ------------------------------- messaging ------------------------------- */

const handlers = {
  GET_SETTINGS: async () => getSettings(),
  SAVE_SETTINGS: async ({ patch }) => setSettings(patch),

  GET_STATE: async () => {
    const [settings, progress] = await Promise.all([getSettings(), getProgress()]);
    return { settings, progress, summary: summarize(progress) };
  },

  RESET_PROGRESS: async () => setProgress({ solved: {}, activity: [] }),

  TEST_CONNECTION: async ({ token, owner, repo, branch }) => {
    const gh = new GitHub(token);
    const user = await gh.me();
    const info = await gh.repo(owner, repo);
    await setSettings({ githubLogin: user.login, repoIsPrivate: !!info.private });

    // Reading the repo only proves read access. Probe an actual write, because a
    // fine-grained token without Contents:write reads fine and then 403s on push.
    const probe = await gh.probeWrite(owner, repo, branch || undefined);

    return {
      login: user.login,
      repo: info.full_name,
      private: info.private,
      defaultBranch: info.default_branch,
      tokenKind: gh.kind,
      scopes: gh.scopes,
      canWrite: probe.canWrite,
      reason: probe.reason || null
    };
  },

  LIST_REPOS: async ({ token }) => {
    const gh = new GitHub(token);
    const repos = await gh.listRepos();
    return repos
      .filter((r) => r.permissions?.push || r.permissions?.admin)
      .map((r) => ({
        fullName: r.full_name,
        owner: r.owner.login,
        name: r.name,
        private: r.private,
        defaultBranch: r.default_branch
      }));
  },

  CREATE_REPO: async ({ token, name, isPrivate }) => {
    const gh = new GitHub(token);
    const r = await gh.createRepo({ name, isPrivate });
    return { owner: r.owner.login, name: r.name, private: r.private, defaultBranch: r.default_branch };
  },

  PUSH_SUBMISSION: async (payload) => pushSubmission(payload),

  /* ----------------------------- bulk backfill ----------------------------- */

  GET_LIBRARY: async () => {
    const [library, progress, job] = await Promise.all([getLibrary(), getProgress(), getJob()]);
    return { library, pushed: Object.keys(progress.solved || {}), job: publicJob(job) };
  },

  REFRESH_LIBRARY: async () => {
    const { items, total } = await askLeetCode('LGS_LIST_SOLVED');
    const library = await setLibrary({ items, fetchedAt: Date.now() });
    const progress = await getProgress();
    return { library, total, pushed: Object.keys(progress.solved || {}) };
  },

  SAVE_SELECTION: async ({ selection }) => setLibrary({ selection: selection || [] }),

  GET_JOB: async () => {
    const job = await getJob();
    if (isStale(job)) return publicJob(await setJob({ status: 'interrupted', current: null }));
    return publicJob(job);
  },

  START_BULK: async ({ slugs }) => startBulk(slugs),
  RESUME_BULK: async () => resumeBulk(),
  PAUSE_BULK: async () => publicJob(await setJob({ status: 'paused', current: null })),
  CANCEL_BULK: async () => {
    const job = await setJob({ status: 'cancelled', current: null, finishedAt: Date.now() });
    await closeOpenedTab(job);
    return publicJob(await setJob({ openedTabId: null }));
  },
  CLEAR_JOB: async () => publicJob(await setJob({ ...EMPTY_JOB }))
};

/** The queue can hold thousands of slugs; the popup never needs to see them. */
function publicJob(job) {
  const { queue, ...rest } = job;
  return { ...rest, remaining: queue.length, stale: isStale(job) };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handler = handlers[msg?.type];
  if (!handler) return false;
  Promise.resolve(handler(msg.payload || {}))
    .then((data) => sendResponse({ ok: true, data }))
    .catch((err) => sendResponse({
      ok: false,
      error: err?.message || String(err),
      status: err instanceof GitHubError ? err.status : undefined
    }));
  return true; // keep the channel open for the async reply
});

/* -------------------------------- pushing -------------------------------- */

async function pushSubmission({ problem, submission }, opts = {}) {
  const settings = await getSettings();
  if (!settings.token) throw new Error('Add a GitHub token in the extension popup first.');
  if (!settings.owner || !settings.repo) throw new Error('Choose a target repository in the extension popup first.');
  if (!submission.code) throw new Error('Could not capture the submitted source code. Re-submit once with the extension enabled.');

  const gh = new GitHub(settings.token);
  const { owner, repo } = settings;
  const branch = settings.branch || undefined;

  const dir = problemDir(problem, settings);
  const date = new Date(submission.finishedAt || Date.now());
  const fileName = submissionFileName(problem, submission, date);
  const header = settings.includeHeader ? solutionHeader(problem, submission, date) : '';
  const body = submission.code.endsWith('\n') ? submission.code : submission.code + '\n';
  const content = header + body;
  const message = commitMessage(settings.commitTemplate, problem, submission);

  const written = [];
  const failedExtras = [];

  // 1. the submission itself — this one is allowed to throw
  const main = await gh.putFile(owner, repo, `${dir}/${fileName}`, { content, message, branch });
  written.push(`${dir}/${fileName}`);

  // 2. optional extras — a failure here must not lose the solution we just wrote
  const extras = [];

  if (settings.keepLatestSolution) {
    extras.push([
      `${dir}/solution.${extFor(submission.lang)}`,
      { content, message: `${message} (latest)`, branch }
    ]);
  }

  if (settings.writeProblemReadme && problem.content) {
    extras.push([
      `${dir}/README.md`,
      { content: problemReadme(problem), message: `Add notes for ${problem.frontendId}. ${problem.title}`, branch, mode: 'overwrite' }
    ]);
  }

  for (const [path, fileOpts] of extras) {
    try {
      await gh.putFile(owner, repo, path, fileOpts);
      written.push(path);
    } catch (err) {
      failedExtras.push(`${path}: ${err.message}`);
    }
  }

  // 3. progress bookkeeping, then the root index (needs the updated numbers)
  const progress = await recordPush({
    problem,
    submission,
    dir,
    commitUrl: main.commit?.html_url || null
  });

  if (settings.writeIndexReadme && !opts.skipIndex) {
    try {
      await writeIndex(gh, settings, progress);
    } catch (err) {
      failedExtras.push(`README.md: ${err.message}`);
    }
  }

  const result = {
    dir,
    fileName,
    written,
    failedExtras,
    commitUrl: main.commit?.html_url || null,
    fileUrl: main.htmlUrl || null,
    repoUrl: `https://github.com/${owner}/${repo}/tree/${branch || 'HEAD'}/${dir}`,
    summary: summarize(progress),
    isPrivate: settings.repoIsPrivate
  };

  if (settings.notify && !opts.quiet) notify(problem, submission, result);
  await bumpBadge(progress);
  return result;
}

/** Root README progress table — one write, shared by single and bulk pushes. */
function writeIndex(gh, settings, progress) {
  const root = String(settings.rootPath || '').replace(/^\/+|\/+$/g, '');
  return gh.putFile(settings.owner, settings.repo, root ? `${root}/README.md` : 'README.md', {
    content: indexReadme(progress.solved, settings),
    message: `Update solutions index (${Object.keys(progress.solved).length} solved)`,
    branch: settings.branch || undefined
  });
}

/* ------------------------------ bulk backfill ------------------------------ */

/**
 * A backfill can touch hundreds of problems, far longer than a popup stays open
 * and longer than Chrome guarantees this service worker stays alive. So the
 * queue lives in storage, every step writes its progress back, and an alarm
 * restarts the runner if the worker was evicted mid-run. Nothing is ever pushed
 * twice: a problem leaves the queue only after its result is recorded.
 */

const KEEPALIVE = 'lgs-bulk-keepalive';
const MAX_ATTEMPTS = 3;
let runner = null;            // in-memory guard: at most one loop per worker

async function startBulk(slugs) {
  const queue = [...new Set((slugs || []).filter(Boolean))];
  if (!queue.length) throw new Error('Select at least one problem to push.');

  const settings = await getSettings();
  if (!settings.token) throw new Error('Add a GitHub token in the Repository tab first.');
  if (!settings.owner || !settings.repo) throw new Error('Choose a target repository in the Repository tab first.');

  // Resolve a LeetCode tab up front so setup problems surface immediately,
  // rather than after the first item fails.
  await resolveLeetCodeTab();

  await setJob({
    ...EMPTY_JOB,
    status: 'running',
    queue,
    total: queue.length,
    startedAt: Date.now(),
    heartbeat: Date.now(),
    openedTabId,
    message: ''
  });
  kick();
  return publicJob(await getJob());
}

async function resumeBulk() {
  const job = await getJob();
  if (!job.queue.length) throw new Error('Nothing left to push.');
  await setJob({ status: 'running', heartbeat: Date.now(), attempts: 0, message: '' });
  kick();
  return publicJob(await getJob());
}

function kick() {
  chrome.alarms.create(KEEPALIVE, { periodInMinutes: 0.5 });
  if (!runner) runner = runJob().finally(() => { runner = null; });
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== KEEPALIVE) return;
  const job = await getJob();
  if (job.status === 'running') kick();          // revives a run the worker lost
  else chrome.alarms.clear(KEEPALIVE);
});

async function runJob() {
  for (;;) {
    let job = await getJob();
    if (job.status !== 'running') break;

    if (!job.queue.length) {
      await finishJob(job, 'done');
      break;
    }

    const slug = job.queue[0];
    await setJob({ current: { slug }, heartbeat: Date.now() });

    const settings = await getSettings();
    const outcome = await pushOne(slug, settings);

    // The item is finished either way; a pause or cancel that landed while it was
    // in flight must not undo it, or resuming would push the same problem twice.
    job = await getJob();
    const interrupted = job.status !== 'running';

    if (outcome.retry) {
      // Nothing was written, so the slug can safely stay at the head of the queue.
      if (interrupted) break;
      if (job.attempts + 1 < MAX_ATTEMPTS) {
        await setJob({
          attempts: job.attempts + 1,
          heartbeat: Date.now(),
          message: `${slug}: ${outcome.error} — retrying`
        });
        await sleep(Math.min(30000, 4000 * (job.attempts + 1)));
        continue;
      }
    }

    const rest = job.queue.slice(1);
    const patch = {
      queue: rest,
      attempts: 0,
      done: job.done + 1,
      heartbeat: Date.now(),
      current: null,
      message: ''
    };

    if (outcome.ok) {
      patch.pushed = job.pushed + 1;
    } else {
      patch.failed = job.failed + 1;
      patch.errors = [...job.errors, { slug, error: outcome.error }].slice(-60);
    }

    // setJob merges onto whatever is stored, so a pause/cancel status survives this.
    const next = await setJob(patch);
    if (interrupted) break;
    if (!rest.length) {
      await finishJob(next, 'done');
      break;
    }
    await sleep(Number(settings.bulkDelayMs) || 1000);
  }
}

/** One problem: fetch its newest accepted submission from LeetCode, push it. */
async function pushOne(slug, settings) {
  let prepared;
  try {
    prepared = await askLeetCode('LGS_PREPARE', { slug });
  } catch (err) {
    return { error: `LeetCode: ${err.message}`, retry: isTransient(err) };
  }

  try {
    await pushSubmission(prepared, { skipIndex: true, quiet: true });
    return { ok: true };
  } catch (err) {
    return { error: err.message, retry: isTransient(err) };
  }
}

/** Throttling and flaky networks are worth retrying; a bad token is not. */
function isTransient(err) {
  const status = err?.status;
  if (status === 401 || status === 403) return /rate limit/i.test(err.message || '');
  if (status === 404) return false;
  if (status >= 500) return true;
  return /429|rate limit|timeout|network|fetch|Receiving end does not exist|message port/i
    .test(err?.message || '');
}

async function finishJob(job, status) {
  const settings = await getSettings();

  // The index README is skipped per problem during a bulk run, so write it once here.
  if (settings.writeIndexReadme && job.pushed > 0 && settings.token && settings.owner && settings.repo) {
    try {
      await writeIndex(new GitHub(settings.token), settings, await getProgress());
    } catch (err) {
      await setJob({ errors: [...job.errors, { slug: 'README.md', error: err.message }].slice(-60) });
    }
  }

  const final = await setJob({
    status,
    current: null,
    finishedAt: Date.now(),
    heartbeat: Date.now()
  });

  chrome.alarms.clear(KEEPALIVE);
  await closeOpenedTab(final);
  await setJob({ openedTabId: null });
  await bumpBadge(await getProgress());

  if (settings.notify) {
    try {
      chrome.notifications.create({
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/icon128.png'),
        title: 'Bulk push finished',
        message: `${final.pushed} pushed · ${final.failed} failed`,
        priority: 0
      });
    } catch (_) { /* best effort */ }
  }
}

/* --------------------------- talking to LeetCode --------------------------- */

/**
 * LeetCode's GraphQL only answers with the user's session cookies, so every
 * query is relayed through the content script on a real leetcode.com tab.
 * If none is open we open one in the background and close it again afterwards.
 */
let cachedTabId = null;
let openedTabId = null;

async function askLeetCode(type, payload, { retry = true } = {}) {
  const tabId = await resolveLeetCodeTab();
  try {
    return await sendToTab(tabId, type, payload);
  } catch (err) {
    if (!retry) throw err;
    cachedTabId = null;                       // tab closed or navigated — try once more
    const fresh = await resolveLeetCodeTab();
    return sendToTab(fresh, type, payload);
  }
}

function sendToTab(tabId, type, payload) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, { type, payload }, (res) => {
      const err = chrome.runtime.lastError;
      if (err) return reject(new Error(err.message));
      if (!res) return reject(new Error('No response from the LeetCode tab.'));
      if (!res.ok) return reject(new Error(res.error || 'LeetCode request failed.'));
      resolve(res.data);
    });
  });
}

/**
 * A tab opened before the last extension reload still runs the previous content
 * script. It answers LGS_PING, so it looks healthy, but ignores message types it
 * has never heard of — and an ignored message closes the port with "The message
 * port closed before a response was received". So a tab only counts as usable if
 * its content script reports at least the version we need.
 */
const REQUIRED_CS_VERSION = 2;

async function resolveLeetCodeTab() {
  if (cachedTabId != null && (await isUsable(cachedTabId))) return cachedTabId;
  cachedTabId = null;

  const tabs = await chrome.tabs.query({
    url: ['https://leetcode.com/*', 'https://leetcode.cn/*']
  });
  for (const tab of tabs) {
    if (await isUsable(tab.id)) {
      cachedTabId = tab.id;
      return tab.id;
    }
  }

  // Any tab we found is stale or scriptless. Opening our own is safer than
  // reloading theirs, which would throw away whatever is in the LeetCode editor.
  const created = await chrome.tabs.create({ url: 'https://leetcode.com/problemset/', active: false });
  if (!(await waitForPing(created.id))) {
    try { await chrome.tabs.remove(created.id); } catch (_) {}
    throw new Error(
      'Could not reach LeetCode in a background tab. Open leetcode.com, make sure you are ' +
      'signed in, and try again.'
    );
  }
  cachedTabId = created.id;
  openedTabId = created.id;
  return created.id;
}

/** Content script version on that tab, or 0 if it cannot be reached at all. */
function ping(tabId) {
  return new Promise((resolve) => {
    try {
      chrome.tabs.sendMessage(tabId, { type: 'LGS_PING' }, (res) => {
        void chrome.runtime.lastError;
        resolve(res?.ok ? Number(res.data?.version) || 1 : 0);
      });
    } catch (_) {
      resolve(0);
    }
  });
}

const isUsable = async (tabId) => (await ping(tabId)) >= REQUIRED_CS_VERSION;

async function waitForPing(tabId, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(700);
    if (await isUsable(tabId)) return true;
  }
  return false;
}

async function closeOpenedTab(job) {
  const id = job?.openedTabId ?? openedTabId;
  if (id == null) return;
  openedTabId = null;
  if (cachedTabId === id) cachedTabId = null;
  try { await chrome.tabs.remove(id); } catch (_) { /* already gone */ }
}

chrome.tabs.onRemoved.addListener((tabId) => {
  if (cachedTabId === tabId) cachedTabId = null;
  if (openedTabId === tabId) openedTabId = null;
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------ side effects ------------------------------ */

function notify(problem, submission, result) {
  try {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: 'Pushed to GitHub',
      message: `${problem.frontendId}. ${problem.title} · ${labelFor(submission.lang)}\n${result.dir}/${result.fileName}`,
      priority: 0
    });
  } catch (_) { /* notifications are best-effort */ }
}

async function bumpBadge(progress) {
  const { total } = summarize(progress);
  try {
    await chrome.action.setBadgeBackgroundColor({ color: '#2cbb5d' });
    await chrome.action.setBadgeText({ text: total === 0 ? '' : total > 999 ? '999+' : String(total) });
  } catch (_) {}
}

chrome.runtime.onInstalled.addListener(async () => {
  // Materialise defaults so later releases inherit any newly added keys.
  await setSettings(await getSettings());
  await bumpBadge(await getProgress());
});

chrome.runtime.onStartup?.addListener(async () => bumpBadge(await getProgress()));

// The worker also wakes for alarms, messages and browser restarts. If a bulk run
// was in flight when it was last evicted, pick it up where it left off.
(async () => {
  const job = await getJob();
  if (job.status === 'running' && job.queue.length) kick();
})();
