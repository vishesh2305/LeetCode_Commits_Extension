import { GitHub, GitHubError } from './lib/github.js';
import {
  getSettings, setSettings, getProgress, setProgress, recordPush, summarize
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

  PUSH_SUBMISSION: async (payload) => pushSubmission(payload)
};

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

async function pushSubmission({ problem, submission }) {
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

  for (const [path, opts] of extras) {
    try {
      await gh.putFile(owner, repo, path, opts);
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

  if (settings.writeIndexReadme) {
    try {
      const root = String(settings.rootPath || '').replace(/^\/+|\/+$/g, '');
      await gh.putFile(owner, repo, root ? `${root}/README.md` : 'README.md', {
        content: indexReadme(progress.solved, settings),
        message: `Update solutions index (${Object.keys(progress.solved).length} solved)`,
        branch
      });
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

  if (settings.notify) notify(problem, submission, result);
  await bumpBadge(progress);
  return result;
}

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
