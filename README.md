# LeetHub Sync

A Chrome/Edge extension that watches your LeetCode submissions, prompts you when one is
accepted, and pushes the code to a GitHub repository — public or private — organised as
one folder per problem with one file per submission.

It also backfills history: the **Library** tab lists every problem your account has ever
solved, so you can tick the ones you want or push all of them in a single run.

```
0001-two-sum/
├── README.md                       problem statement, difficulty, topics
├── solution.py                     newest accepted solution
├── two-sum-20260903-141530.py      every submission, kept forever
└── two-sum-20260904-093011.cpp
```

## Install

1. `chrome://extensions` → enable **Developer mode** (top right).
2. **Load unpacked** → select this folder.
3. Pin the extension and open its popup.

Chrome 111+ (also Edge, Brave, Arc, Opera). It uses a `world: "MAIN"` content script,
which Firefox does not support in the same form.

## Set up

Open the popup → **Repository** tab.

1. **Token.** Create a GitHub personal access token.

   *Fine-grained* (recommended) — [create one](https://github.com/settings/personal-access-tokens/new):
   - **Repository access** → *Only select repositories* → pick your solutions repo.
   - **Repository permissions** → **Contents: Read and write**.
     Read-only is the single most common mistake — the repo will connect fine and then
     fail on the first push with *403 Resource not accessible by personal access token*.
   - Metadata gets granted automatically; nothing else is needed.
   - If the repo belongs to an **organisation**, an org owner may also have to approve
     the token (Settings → Third-party Access → Personal access tokens).

   *Classic* — tick the **`repo`** scope. `public_repo` alone cannot write to a private
   repository.

   The token lives in `chrome.storage.local` on this machine only. It is never synced and
   never sent anywhere but `api.github.com`.

2. **Repository.** Either **Load my repos** and pick one, **New repo** to create one
   (private by default), or type the owner and repository by hand. Leave *Branch* blank
   to use the repository's default branch.

3. **Test connection.** Confirms the token and repository, and — importantly — probes an
   actual write, because a token with read-only Contents connects happily and only fails
   when you push. The probe exploits the fact that a write carrying a deliberately wrong
   SHA is rejected *after* the permission check: `403` means no write access, `422` means
   write access is fine. Nothing is ever committed by the probe.

## Using it

Solve a problem and hit Submit. When the verdict lands, a card slides in at the
bottom-right of the LeetCode page — themed to match LeetCode's light and dark modes —
showing the verdict, the language, runtime/memory, and the exact path the file will take.

- **Push to GitHub** commits it and swaps to a confirmation with your solved count, day
  streak, and a link to the commit.
- **Skip** dismisses it (so does `Esc`).
- **Push automatically from now on** switches to silent auto-push; reverse it any time
  from the popup's **Options** tab.

The popup's **Progress** tab tracks totals, an easy/medium/hard breakdown, a day streak,
and your recent pushes, each linking to its commit.


## Backfilling everything you've already solved

Open the popup → **Library** tab → **Load solved problems**. That asks LeetCode for every
problem the account has solved since it was created and caches the list locally.

From there:

- **Filter** by text, difficulty, or whether a problem is already on GitHub.
- **Tick individual problems** (click anywhere on a row), or **Select all shown** to take
  everything the current filters match — not just the rows on screen.
- **Push selected** sends your ticks; **Push all** takes the whole list.
- **Skip problems already pushed** (on by default) drops anything already synced, so you
  can re-run it later to pick up only what's new.

Each problem is pushed with its **newest accepted submission**, in exactly the same layout
as a live push.

The run lives in the background service worker, not the popup — **close the popup and it
keeps going**. Reopen it to see a live count, the problem currently being pushed, and any
failures. You can **Pause**, **Resume**, or **Cancel** at any point; the problem already in
flight finishes and is recorded, so resuming never pushes the same thing twice.

A few details worth knowing:

- **A signed-in LeetCode tab is required**, because LeetCode's API only answers with your
  session cookies. If you have none open, the extension opens one in the background and
  closes it again when the run finishes.
- **Pace** (Fast / Balanced / Safe) sets the gap between problems. Slower is gentler on
  both LeetCode's and GitHub's rate limits; a few hundred problems takes a while either
  way. Throttling and server errors are retried automatically up to three times with
  backoff; a problem with no accepted submission is recorded as a failure and skipped.
- **The repo README index is written once at the end** of a bulk run rather than after
  every problem, which keeps the commit history readable and avoids hundreds of redundant
  writes.
- If Chrome suspends the extension mid-run, the queue is persisted, so the run picks up
  where it left off — and the popup offers **Resume** if it doesn't.

## Options

| Option | Default | Effect |
| --- | --- | --- |
| When a submission is accepted | Ask me | `Ask me` / `Push automatically` / `Off` |
| Folder inside the repo | *(none)* | Nest everything under e.g. `leetcode/` |
| Number padding | `0001-two-sum` | Or `001-` / `1-` |
| Commit message | `Add solution for {id}. {title} ({difficulty}) [{lang}]` | Placeholders: `{id} {title} {slug} {difficulty} {lang} {runtime} {memory} {date}` |
| Group folders by difficulty | off | `Easy/0001-two-sum/` |
| Header comment in each solution | on | Problem link, difficulty, runtime, memory, topics |
| `README.md` per problem folder | on | Problem statement converted to Markdown |
| Progress table in the repo README | on | Regenerated table of everything solved |
| Keep `solution.<ext>` | on | Mirrors the newest accepted submission |
| Only offer Accepted submissions | on | Turn off to archive failed attempts too |
| Desktop notification | on | Fires after each successful push |
| Verbose logging | on | `[LeetHub Sync]` traces in the page console |
| Skip problems already pushed | on | Keeps a bulk run to what isn't on GitHub yet |
| Pace | Balanced (1s) | Gap between problems during a bulk run |

## Troubleshooting

**Nothing happens when I submit.**

1. **Reload the LeetCode tab.** Chrome only injects content scripts into tabs opened
   *after* the extension was loaded or reloaded. This is the usual cause.
2. Open the popup → **Progress** tab. The *This tab* box says whether the extension is
   attached to the LeetCode tab you have open, and names the problem it is watching.
3. Still nothing? Open DevTools on the LeetCode page (`⌥⌘I` → Console). With
   **Verbose logging** on (Options tab, on by default) you should see:
   `[LeetHub Sync] content script active on …`, then on submit
   `submit button clicked` → `watching two-sum — baseline of N submissions` →
   `watcher found submission … Accepted` → `pushed […]`.
   Whichever line is missing tells you where it stops.
4. **Push last submission** (Progress tab) ignores detection entirely — it pulls your most
   recent accepted submission for the open problem straight from LeetCode and shows the
   push card. If that works but automatic detection doesn't, the logs from step 3 say why.

**`403 Resource not accessible by personal access token`.** The token can read the repo
but not write to it. For a fine-grained token, open it at
github.com/settings/personal-access-tokens and set **Repository permissions → Contents**
to **Read and write** (and confirm the repo is listed under *Repository access*). For a
classic token, tick **`repo`**. Then hit **Test connection** again — it now verifies
writes, not just reads.

**"The message port closed before a response was received."** A LeetCode tab opened
*before* the extension was last reloaded keeps running the previous content script, which
ignores newer requests. Reload the LeetCode tab. The extension detects this by itself now —
it checks the content script's version and quietly uses a fresh background tab instead —
but reloading yours is still the cleanest fix, and the Progress tab flags it.

**The Library tab says it can't reach LeetCode.** It needs a signed-in leetcode.com tab.
Open one, make sure you're logged in, and try again — the list comes from your account, so
a signed-out session returns nothing.

**A bulk run shows failures.** Expand *Problems that failed* for the reason per problem.
*No accepted submission found* means LeetCode has no stored accepted submission for it
(common for very old accounts, where submission history was pruned). GitHub `403` errors
are a token permission problem — see above.

**The card appears but Push is greyed out.** Either the repository isn't configured
(popup → Repository → Test connection) or the source code couldn't be retrieved — the card
says which.

## How it works

LeetCode posts your code to `/problems/<slug>/submit/` and then polls
`/submissions/detail/<id>/check/` for the verdict. The verdict response does not include
the source, so a `MAIN`-world script (`src/interceptor.js`) patches `fetch` and
`XMLHttpRequest` to capture `typed_code` from the request and join it to the verdict by
submission id, then hands the pair to the isolated content script over `postMessage`.

`src/content.js` enriches that with problem metadata from LeetCode's own GraphQL endpoint
(title, frontend number, difficulty, topics, statement) and renders the card.
`src/background.js` builds the files and writes them through the GitHub Contents API,
which behaves identically for public and private repositories and copes with a repository
that has no commits yet.

Detection has three independent layers, so a LeetCode change can't silently break it:

1. **Network interception** — fastest, and the source code arrives with it.
2. **Submission watcher** — pressing Submit (button, or ⌘/Ctrl+Enter) starts a poll of your
   own submission list over GraphQL; a new submission with a final verdict triggers the
   card. This works even if LeetCode moves or renames its submit endpoints.
3. **Verdict panel observer** — if a result panel appears and nothing is watching yet, the
   watcher starts anyway.

Whichever fires first wins; the others are suppressed for that submission id. Code is
fetched via the `submissionDetails` GraphQL query whenever interception didn't supply it.

**Bulk backfill** works the other way round. The Library list comes from LeetCode's
`problemsetQuestionList` query filtered to `status: AC`, paged 100 at a time. Because that
endpoint — like every LeetCode API — only answers with your session cookies, the service
worker cannot call it directly; every query is relayed through the content script on a real
leetcode.com tab. The run itself is a queue in `chrome.storage.local`: each problem is
removed only after its result is recorded, a heartbeat marks the run live, and a
`chrome.alarms` tick restarts the loop if Chrome evicted the worker mid-run. That is what
makes the run survive closing the popup, and what keeps a resume from pushing anything
twice.

## Layout

```
manifest.json
src/
  interceptor.js     MAIN world — captures submissions
  content.js         isolated world — metadata + the in-page card
  content.css
  background.js      service worker — builds and pushes commits
  lib/
    github.js        GitHub REST client
    storage.js       settings + progress + bulk job queue
    format.js        paths, headers, READMEs, commit messages
    mappings.js      language → extension / label / comment syntax
popup/               progress dashboard and settings
tools/make_icons.py  regenerates icons/
```

## Notes and limits

- The solution file is written first; a failure writing the per-problem README or the
  index never loses the code, and the card reports what was skipped.
- The root progress table is rewritten on each push, so a repository shared with another
  device can produce a conflicting write — the client retries once with a fresh SHA.
- Premium problems return no statement over GraphQL; the folder is still created and the
  README says so.
- Progress counters live in this browser. **Reset local progress** clears them and touches
  nothing on GitHub. It also makes the Library tab treat every problem as un-pushed, so a
  bulk run after a reset will re-push everything unless you untick *Skip problems already
  pushed* or filter by hand.
- A bulk run pushes the newest accepted submission per problem, not the full submission
  history — LeetCode only reliably keeps recent submissions for older accounts anyway.
