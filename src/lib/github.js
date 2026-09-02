/**
 * Minimal GitHub REST client.
 *
 * Everything goes through the Contents API, which works identically for public
 * and private repositories and also handles a repo that has no commits yet.
 */
const API = 'https://api.github.com';

export class GitHubError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
    this.body = body;
  }
}

/** UTF-8 safe base64 (btoa alone breaks on non-Latin1 characters). */
export function toBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function fromBase64(b64) {
  const binary = atob(String(b64).replace(/\n/g, ''));
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

const encodePath = (path) =>
  String(path)
    .split('/')
    .filter(Boolean)
    .map(encodeURIComponent)
    .join('/');

/** github_pat_… = fine-grained, ghp_/gho_/ghs_ = classic/OAuth. */
export function tokenKind(token) {
  const t = String(token || '').trim();
  if (t.startsWith('github_pat_')) return 'fine-grained';
  if (/^gh[pousr]_/.test(t)) return 'classic';
  return 'unknown';
}

export class GitHub {
  constructor(token) {
    if (!token) throw new GitHubError('No GitHub token configured', 401, null);
    this.token = token.trim();
    this.kind = tokenKind(this.token);
    this.scopes = null;   // classic tokens only; filled from response headers
  }

  /** Actionable remediation for a 403 on a write. */
  writeDeniedHint(owner, repo) {
    const target = owner && repo ? `${owner}/${repo}` : 'this repository';
    if (this.kind === 'classic') {
      const have = this.scopes ? `Its current scopes are: ${this.scopes || '(none)'}.` : '';
      return `This classic token cannot write to ${target}. ${have} ` +
        `Edit it at github.com/settings/tokens and tick the "repo" scope ` +
        `("public_repo" alone cannot write to private repositories).`;
    }
    if (this.kind === 'fine-grained') {
      return `This fine-grained token can read ${target} but not write to it. ` +
        `At github.com/settings/personal-access-tokens, open the token and check two things: ` +
        `(1) "Repository access" includes ${target}, and ` +
        `(2) "Repository permissions" → "Contents" is set to "Read and write". ` +
        `If ${target} belongs to an organisation, an org owner may also have to approve the token.`;
    }
    return `This token cannot write to ${target}. Give it Contents: Read and write ` +
      `(fine-grained) or the "repo" scope (classic).`;
  }

  async request(method, path, body, { raw = false } = {}) {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });

    // classic tokens advertise their scopes here; fine-grained ones send nothing
    const scopeHeader = res.headers.get('x-oauth-scopes');
    if (scopeHeader !== null) this.scopes = scopeHeader;

    if (res.status === 204) return null;

    let json = null;
    const text = await res.text();
    try { json = text ? JSON.parse(text) : null; } catch (_) { json = { raw: text }; }

    if (!res.ok) {
      if (raw && res.status === 404) return null;
      const detail = json?.message || res.statusText;
      const hint =
        res.status === 401 ? ' — token is invalid or expired'
        : res.status === 403 && /rate limit/i.test(detail) ? ' — GitHub rate limit hit, try again shortly'
        : res.status === 403 ? ` — ${this.writeDeniedHint(this._ctxOwner, this._ctxRepo)}`
        : res.status === 404 ? ' — repository not found, or the token cannot see it (private repos need Contents access)'
        : res.status === 409 ? ' — conflict, the file changed on the remote; retry'
        : res.status === 422 ? ' — GitHub rejected the write (stale file sha or protected branch)'
        : '';
      throw new GitHubError(`GitHub ${res.status}: ${detail}${hint}`, res.status, json);
    }
    return json;
  }

  /** Authenticated user. */
  me() {
    return this.request('GET', '/user');
  }

  repo(owner, name) {
    this._ctxOwner = owner;
    this._ctxRepo = name;
    return this.request('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`);
  }

  async listRepos() {
    const out = [];
    for (let page = 1; page <= 4; page += 1) {
      const batch = await this.request(
        'GET',
        `/user/repos?per_page=100&page=${page}&affiliation=owner,collaborator&sort=updated`
      );
      if (!batch?.length) break;
      out.push(...batch);
      if (batch.length < 100) break;
    }
    return out;
  }

  createRepo({ name, isPrivate = true, description = 'My LeetCode solutions, auto-synced.' }) {
    return this.request('POST', '/user/repos', {
      name,
      private: !!isPrivate,
      description,
      auto_init: true
    });
  }

  /**
   * Check write access without creating a commit.
   *
   * A PUT carrying a sha for a file that does not exist is rejected by GitHub as
   * 422/409 *after* the permission check — so 422/409 proves the token may write,
   * while 403 proves it may not. Nothing is committed either way.
   */
  async probeWrite(owner, repo, branch) {
    this._ctxOwner = owner;
    this._ctxRepo = repo;
    const path = '.leethub-sync-write-probe';
    try {
      const res = await this.request(
        'PUT',
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${path}`,
        {
          message: 'LeetHub Sync write probe',
          content: toBase64('probe'),
          sha: '0'.repeat(40),          // deliberately wrong -> 422, never a commit
          ...(branch ? { branch } : {})
        }
      );
      // Unexpected success: clean up so we leave no trace.
      if (res?.content?.sha) {
        await this.request(
          'DELETE',
          `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${path}`,
          { message: 'LeetHub Sync write probe cleanup', sha: res.content.sha, ...(branch ? { branch } : {}) }
        ).catch(() => {});
      }
      return { canWrite: true };
    } catch (err) {
      if (err.status === 409 || err.status === 422) return { canWrite: true };
      if (err.status === 403) return { canWrite: false, reason: this.writeDeniedHint(owner, repo) };
      if (err.status === 404) {
        return {
          canWrite: false,
          reason: `The token cannot see ${owner}/${repo}. For a fine-grained token, add this ` +
            `repository under "Repository access"; for a classic token, tick the "repo" scope.`
        };
      }
      throw err;
    }
  }

  /** Returns { sha, content } or null when the file does not exist. */
  async getFile(owner, repo, path, branch) {
    const q = branch ? `?ref=${encodeURIComponent(branch)}` : '';
    const res = await this.request(
      'GET',
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodePath(path)}${q}`,
      null,
      { raw: true }
    );
    if (!res || Array.isArray(res) || res.type !== 'file') return null;
    return { sha: res.sha, content: res.content ? fromBase64(res.content) : '' };
  }

  /**
   * Create or update a file. Retries once on a 409/422 sha race.
   * `mode: 'skip'` leaves an existing file untouched.
   */
  async putFile(owner, repo, path, { content, message, branch, mode = 'overwrite' }) {
    this._ctxOwner = owner;
    this._ctxRepo = repo;
    const existing = await this.getFile(owner, repo, path, branch);
    if (existing && mode === 'skip') return { skipped: true, path };
    if (existing && existing.content === content) return { unchanged: true, path };

    const body = {
      message,
      content: toBase64(content),
      ...(branch ? { branch } : {}),
      ...(existing ? { sha: existing.sha } : {})
    };

    try {
      const res = await this.request(
        'PUT',
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodePath(path)}`,
        body
      );
      return { path, commit: res?.commit, htmlUrl: res?.content?.html_url };
    } catch (err) {
      if (err.status !== 409 && err.status !== 422) throw err;
      const fresh = await this.getFile(owner, repo, path, branch);
      const res = await this.request(
        'PUT',
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodePath(path)}`,
        { ...body, ...(fresh ? { sha: fresh.sha } : {}) }
      );
      return { path, commit: res?.commit, htmlUrl: res?.content?.html_url };
    }
  }
}
