import { extFor, labelFor, commentFor } from './mappings.js';

const pad = (n, width) => String(n).padStart(width, '0');
const two = (n) => pad(n, 2);

/** Local-time stamp used in submission file names: 20260903-141530 */
export function stamp(date = new Date()) {
  return (
    `${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}` +
    `-${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}`
  );
}

export function isoLocal(date = new Date()) {
  return `${localDate(date)} ${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`;
}

/** Local YYYY-MM-DD — toISOString() would shift the day for anyone east/west of UTC. */
export function localDate(date = new Date()) {
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
}

/** "two-sum" -> "Two Sum" (fallback when the API title is missing) */
export const titleize = (slug) =>
  String(slug || '')
    .split('-')
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');

export const sanitize = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);

/** Directory for a problem: "0001-two-sum" */
export function problemDir(problem, settings) {
  const width = Number(settings.padWidth ?? 4);
  const id = problem.frontendId || problem.questionId || '0';
  const num = /^\d+$/.test(String(id)) ? pad(id, width) : String(id);
  const slug = sanitize(problem.slug || titleize(problem.title));
  const dir = `${num}-${slug}`;
  const root = String(settings.rootPath || '').replace(/^\/+|\/+$/g, '');
  const grouped = settings.groupByDifficulty && problem.difficulty
    ? `${problem.difficulty}/`
    : '';
  return `${root ? root + '/' : ''}${grouped}${dir}`;
}

/** File name for one submission: "two-sum-20260903-141530.py" */
export function submissionFileName(problem, submission, date = new Date()) {
  const ext = extFor(submission.lang);
  const slug = sanitize(problem.slug);
  return `${slug}-${stamp(date)}.${ext}`;
}

/** Header comment prepended to every stored solution file. */
export function solutionHeader(problem, submission, date = new Date()) {
  const ext = extFor(submission.lang);
  const { line } = commentFor(ext);
  const rows = [
    `${problem.frontendId}. ${problem.title}`,
    `${problem.url}`,
    `Difficulty: ${problem.difficulty || 'Unknown'}`,
    `Language:   ${labelFor(submission.lang)}`,
    `Submitted:  ${isoLocal(date)}`
  ];
  if (submission.runtime) {
    const pct = submission.runtimePercentile != null
      ? ` (beats ${Number(submission.runtimePercentile).toFixed(2)}%)`
      : '';
    rows.push(`Runtime:    ${submission.runtime}${pct}`);
  }
  if (submission.memory) {
    const pct = submission.memoryPercentile != null
      ? ` (beats ${Number(submission.memoryPercentile).toFixed(2)}%)`
      : '';
    rows.push(`Memory:     ${submission.memory}${pct}`);
  }
  if (problem.tags?.length) rows.push(`Topics:     ${problem.tags.join(', ')}`);
  return rows.map((r) => `${line} ${r}`).join('\n') + '\n\n';
}

/** Very small HTML -> Markdown pass for the LeetCode problem statement. */
export function htmlToMarkdown(html) {
  if (!html) return '';
  let s = String(html);
  s = s.replace(/<pre>([\s\S]*?)<\/pre>/gi, (_, body) => '\n```\n' + strip(body).trim() + '\n```\n');
  s = s.replace(/<\/?(strong|b)>/gi, '**');
  s = s.replace(/<\/?(em|i)>/gi, '_');
  s = s.replace(/<code>([\s\S]*?)<\/code>/gi, (_, c) => '`' + strip(c).trim() + '`');
  s = s.replace(/<li>/gi, '\n- ').replace(/<\/li>/gi, '');
  s = s.replace(/<\/(p|div|ul|ol|h[1-6])>/gi, '\n\n');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = strip(s);
  return s.replace(/\n{3,}/g, '\n\n').trim();
}

function strip(html) {
  return String(html)
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Per-problem README.md */
export function problemReadme(problem) {
  const meta = [
    `**Difficulty:** ${problem.difficulty || 'Unknown'}`,
    `**Link:** [${problem.url}](${problem.url})`
  ];
  if (problem.tags?.length) meta.push(`**Topics:** ${problem.tags.map((t) => `\`${t}\``).join(', ')}`);
  if (problem.acRate != null) {
    const rate = typeof problem.acRate === 'number' ? `${problem.acRate}%` : problem.acRate;
    meta.push(`**Acceptance:** ${rate}`);
  }
  const parts = [
    `# ${problem.frontendId}. ${problem.title}`,
    '',
    // two trailing spaces = hard line break, so the meta block stays one stanza
    ...meta.map((line, i) => (i === meta.length - 1 ? line : `${line}  `)),
    '', '---', ''
  ];
  const body = htmlToMarkdown(problem.content);
  parts.push(body || '_Problem statement unavailable (premium or not fetched)._');
  parts.push('', '---', '', '<sub>Synced by LeetHub Sync.</sub>', '');
  return parts.join('\n');
}

/** Root index README listing everything solved. */
export function indexReadme(solvedMap, settings) {
  const rows = Object.values(solvedMap || {}).sort(
    (a, b) => Number(a.frontendId) - Number(b.frontendId)
  );
  const counts = { Easy: 0, Medium: 0, Hard: 0 };
  rows.forEach((r) => { if (counts[r.difficulty] != null) counts[r.difficulty] += 1; });

  const head = [
    '# LeetCode Solutions',
    '',
    `> Auto-synced from LeetCode by the LeetHub Sync browser extension. Last updated ${isoLocal()}.`,
    '',
    `**Solved:** ${rows.length} · ` +
      `🟢 Easy ${counts.Easy} · 🟡 Medium ${counts.Medium} · 🔴 Hard ${counts.Hard}`,
    '',
    '| # | Problem | Difficulty | Language(s) | Submissions | Last solved |',
    '| --- | --- | --- | --- | --- | --- |'
  ];

  const dot = { Easy: '🟢', Medium: '🟡', Hard: '🔴' };
  const body = rows.map((r) => {
    const dir = encodeURI(r.dir || '');
    const langs = (r.langs || []).map(labelFor).join(', ');
    const last = r.lastSolvedAt ? localDate(new Date(r.lastSolvedAt)) : '';
    return `| ${r.frontendId} | [${r.title}](${dir}) | ${dot[r.difficulty] || ''} ${r.difficulty || ''} | ${langs} | ${r.submissions || 1} | ${last} |`;
  });

  return [...head, ...body, ''].join('\n');
}

export function commitMessage(template, problem, submission) {
  const map = {
    '{id}': problem.frontendId,
    '{title}': problem.title,
    '{slug}': problem.slug,
    '{difficulty}': problem.difficulty || '',
    '{lang}': labelFor(submission.lang),
    '{runtime}': submission.runtime || '',
    '{memory}': submission.memory || '',
    '{date}': isoLocal()
  };
  let out = template || 'Add solution for {id}. {title} ({difficulty}) [{lang}]';
  for (const [k, v] of Object.entries(map)) out = out.split(k).join(v);
  return out;
}
