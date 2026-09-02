# LeetHub Sync

A Chrome/Edge extension that watches your LeetCode submissions, prompts you when one is
accepted, and pushes the code to a GitHub repository — public or private — organised as
one folder per problem with one file per submission.

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
    storage.js       settings + progress
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
  nothing on GitHub.
