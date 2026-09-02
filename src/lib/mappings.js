/** LeetCode language slug -> file extension. */
export const LANG_EXT = {
  python: 'py', python3: 'py', pythondata: 'py',
  java: 'java', c: 'c', cpp: 'cpp', csharp: 'cs',
  javascript: 'js', typescript: 'ts', react: 'jsx',
  php: 'php', swift: 'swift', kotlin: 'kt', dart: 'dart',
  golang: 'go', ruby: 'rb', scala: 'scala', rust: 'rs',
  racket: 'rkt', erlang: 'erl', elixir: 'ex',
  mysql: 'sql', mssql: 'sql', oraclesql: 'sql', postgresql: 'sql',
  bash: 'sh'
};

/** LeetCode language slug -> human label. */
export const LANG_LABEL = {
  python: 'Python', python3: 'Python3', pythondata: 'Pandas',
  java: 'Java', c: 'C', cpp: 'C++', csharp: 'C#',
  javascript: 'JavaScript', typescript: 'TypeScript', react: 'React',
  php: 'PHP', swift: 'Swift', kotlin: 'Kotlin', dart: 'Dart',
  golang: 'Go', ruby: 'Ruby', scala: 'Scala', rust: 'Rust',
  racket: 'Racket', erlang: 'Erlang', elixir: 'Elixir',
  mysql: 'MySQL', mssql: 'MS SQL Server', oraclesql: 'Oracle SQL',
  postgresql: 'PostgreSQL', bash: 'Bash'
};

/** Comment syntax per extension, used for the solution file header. */
const HASH = { open: null, line: '#' };
const SLASH = { open: null, line: '//' };
const DASH = { open: null, line: '--' };
const PERCENT = { open: null, line: '%' };
const SEMI = { open: null, line: ';' };

export const COMMENT = {
  py: HASH, rb: HASH, sh: HASH, ex: HASH, kt: SLASH,
  java: SLASH, c: SLASH, cpp: SLASH, cs: SLASH, js: SLASH, ts: SLASH,
  jsx: SLASH, php: SLASH, swift: SLASH, dart: SLASH, go: SLASH,
  scala: SLASH, rs: SLASH,
  sql: DASH, erl: PERCENT, rkt: SEMI
};

export const extFor = (lang) => LANG_EXT[String(lang || '').toLowerCase()] || 'txt';
export const labelFor = (lang) => LANG_LABEL[String(lang || '').toLowerCase()] || lang || 'Unknown';
export const commentFor = (ext) => COMMENT[ext] || SLASH;
