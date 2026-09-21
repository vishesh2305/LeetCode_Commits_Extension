/** Settings + progress persistence (chrome.storage.local — the token never syncs). */

export const DEFAULTS = {
  token: '',
  owner: '',
  repo: '',
  branch: '',                 // empty => repository default branch
  rootPath: '',               // optional sub-folder inside the repo
  mode: 'prompt',             // 'prompt' | 'auto' | 'off'
  padWidth: 4,                // 0001-two-sum
  groupByDifficulty: false,   // Easy/0001-two-sum
  includeHeader: true,        // comment banner at the top of each solution file
  writeProblemReadme: true,   // README.md inside each problem folder
  writeIndexReadme: true,     // root README.md progress table
  keepLatestSolution: true,   // also maintain solution.<ext> = newest accepted
  onlyAccepted: true,         // ignore Wrong Answer / TLE ...
  notify: true,               // desktop notification after a push
  debug: true,                // verbose logging in the page console
  commitTemplate: 'Add solution for {id}. {title} ({difficulty}) [{lang}]',
  repoIsPrivate: null,        // filled in by "Test connection"
  githubLogin: '',
  bulkDelayMs: 1000,          // pause between problems during a bulk push
  bulkSkipPushed: true        // leave already-synced problems out of a bulk run
};

/** A bulk push that has never been started. */
export const EMPTY_JOB = {
  status: 'idle',       // idle | running | paused | done | cancelled | interrupted
  queue: [],            // slugs still to process, head first
  total: 0,
  done: 0,
  pushed: 0,
  failed: 0,
  attempts: 0,          // retries spent on the head of the queue
  current: null,        // { slug, title } being worked on right now
  errors: [],           // { slug, title, error }
  startedAt: null,
  finishedAt: null,
  heartbeat: 0,         // last sign of life from the runner
  openedTabId: null,    // a LeetCode tab we opened ourselves, closed when done
  message: ''
};

export async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULTS, ...(settings || {}) };
}

export async function setSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}

export async function getProgress() {
  const { progress } = await chrome.storage.local.get('progress');
  return { solved: {}, activity: [], ...(progress || {}) };
}

export async function setProgress(progress) {
  await chrome.storage.local.set({ progress });
  return progress;
}

/** Record one successful push. */
export async function recordPush({ problem, submission, dir, commitUrl }) {
  const progress = await getProgress();
  const key = String(problem.frontendId || problem.slug);
  const prev = progress.solved[key];
  const now = Date.now();

  progress.solved[key] = {
    frontendId: problem.frontendId,
    title: problem.title,
    slug: problem.slug,
    difficulty: problem.difficulty || 'Unknown',
    dir,
    langs: Array.from(new Set([...(prev?.langs || []), submission.lang].filter(Boolean))),
    submissions: (prev?.submissions || 0) + 1,
    firstSolvedAt: prev?.firstSolvedAt || now,
    lastSolvedAt: now
  };

  progress.activity.unshift({
    ts: now,
    frontendId: problem.frontendId,
    title: problem.title,
    difficulty: problem.difficulty || 'Unknown',
    lang: submission.lang,
    runtime: submission.runtime || null,
    commitUrl: commitUrl || null,
    isNew: !prev
  });
  progress.activity = progress.activity.slice(0, 300);

  await setProgress(progress);
  return progress;
}

/** Derived numbers for the popup dashboard. */
export function summarize(progress) {
  const solved = Object.values(progress.solved || {});
  const counts = { Easy: 0, Medium: 0, Hard: 0, Unknown: 0 };
  solved.forEach((s) => { counts[s.difficulty] = (counts[s.difficulty] || 0) + 1; });

  const days = new Set(
    (progress.activity || []).map((a) => new Date(a.ts).toDateString())
  );

  let streak = 0;
  const cursor = new Date();
  if (!days.has(cursor.toDateString())) cursor.setDate(cursor.getDate() - 1);
  while (days.has(cursor.toDateString())) {
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }

  const weekAgo = Date.now() - 7 * 864e5;
  const thisWeek = (progress.activity || []).filter((a) => a.ts >= weekAgo).length;

  return {
    total: solved.length,
    counts,
    streak,
    thisWeek,
    pushes: (progress.activity || []).length
  };
}


/* ------------------------------ bulk backfill ------------------------------ */

export async function getJob() {
  const { job } = await chrome.storage.local.get('job');
  return { ...EMPTY_JOB, ...(job || {}) };
}

export async function setJob(patch) {
  const next = { ...(await getJob()), ...patch };
  await chrome.storage.local.set({ job: next });
  return next;
}

/**
 * A job is only truly running while the service worker keeps touching it.
 * Chrome can evict the worker mid-run, so a stale heartbeat means "interrupted",
 * which the popup offers to resume. The window is generous on purpose: a single
 * problem can legitimately take a while (retry backoff is up to 30s), and calling
 * a live run dead would stop it.
 */
export function isStale(job, maxAgeMs = 180000) {
  return job.status === 'running' && Date.now() - (job.heartbeat || 0) > maxAgeMs;
}

/** Cached list of every solved problem, fetched from LeetCode on demand. */
export async function getLibrary() {
  const { library } = await chrome.storage.local.get('library');
  return { fetchedAt: null, items: [], selection: [], ...(library || {}) };
}

export async function setLibrary(patch) {
  const next = { ...(await getLibrary()), ...patch };
  await chrome.storage.local.set({ library: next });
  return next;
}
