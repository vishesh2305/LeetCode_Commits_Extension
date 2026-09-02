/**
 * MAIN-world interceptor.
 *
 * LeetCode submits code with  POST /problems/<slug>/submit/   -> { submission_id }
 * then polls                  GET  /submissions/detail/<id>/check/ -> { state, status_msg, ... }
 *
 * The verdict response does NOT carry the source code, so we capture `typed_code`
 * from the submit request body and join the two by submission_id.
 *
 * Everything here runs in the page's own JS world, so it can only talk to the
 * isolated content script through window.postMessage.
 */
(() => {
  'use strict';
  if (window.__LGS_INTERCEPTOR__) return;
  window.__LGS_INTERCEPTOR__ = true;

  const SUBMIT_RE = /\/problems\/([^/?#]+)\/submit\/?(?:\?|$)/;
  const CHECK_RE = /\/submissions\/detail\/(\d+)\/check\/?(?:\?|$)/;

  /** submission_id -> { slug, lang, questionId, code, submittedAt } */
  const pending = new Map();
  /** most recent submit payload, used when the id join fails */
  let lastSubmit = null;
  /** submission ids we have already reported */
  const reported = new Set();

  const debugOn = () => {
    try { return localStorage.getItem('lgs-debug') === '1'; } catch (_) { return false; }
  };
  const log = (...args) => { if (debugOn()) console.log('%c[LeetHub Sync/page]', 'color:#ffa116', ...args); };

  const send = (type, detail) => {
    log('->', type, detail);
    window.postMessage({ __lgs: true, dir: 'page->cs', type, detail }, window.location.origin);
  };

  log('interceptor installed on', location.href);

  const absolute = (input) => {
    try {
      if (typeof input === 'string') return new URL(input, location.href).href;
      if (input instanceof Request) return new URL(input.url, location.href).href;
      if (input && input.url) return new URL(input.url, location.href).href;
    } catch (_) {}
    return '';
  };

  const parse = (text) => {
    try { return JSON.parse(text); } catch (_) { return null; }
  };

  function rememberSubmit(url, bodyText) {
    const m = SUBMIT_RE.exec(url);
    if (!m) return null;
    const body = parse(bodyText) || {};
    const record = {
      slug: decodeURIComponent(m[1]),
      lang: body.lang || null,
      questionId: body.question_id != null ? String(body.question_id) : null,
      code: typeof body.typed_code === 'string' ? body.typed_code : null,
      submittedAt: Date.now()
    };
    lastSubmit = record;
    log('submit captured', { slug: record.slug, lang: record.lang, codeChars: record.code?.length ?? 0 });
    send('SUBMIT_STARTED', { slug: record.slug, lang: record.lang });
    return record;
  }

  function linkSubmitResponse(record, responseText) {
    const json = parse(responseText);
    if (!json) return;
    const id = json.submission_id ?? json.submissionId ?? json.interpret_id;
    if (id == null) return log('submit response had no submission id', json);
    log('submission id', id);
    pending.set(String(id), record);
    // keep the map from growing without bound in a long session
    if (pending.size > 40) pending.delete(pending.keys().next().value);
  }

  function handleCheck(url, responseText) {
    const m = CHECK_RE.exec(url);
    if (!m) return;
    const id = m[1];
    const json = parse(responseText);
    if (!json) return;
    if (json.state !== 'SUCCESS') return log('verdict pending for', id, json.state);
    if (reported.has(id)) return;
    reported.add(id);

    const accepted = json.status_msg === 'Accepted' && Number(json.status_code) === 10;
    // Prefer the id-joined record. Fall back to the last submit only when it is
    // recent and for the problem currently open, so a replayed or unrelated
    // verdict never picks up somebody else's source.
    const FALLBACK_WINDOW_MS = 3 * 60 * 1000;
    const fallback =
      lastSubmit &&
      Date.now() - lastSubmit.submittedAt < FALLBACK_WINDOW_MS &&
      lastSubmit.slug === slugFromLocation()
        ? lastSubmit
        : null;
    const src = pending.get(id) || fallback || {};
    pending.delete(id);

    send('SUBMISSION_RESULT', {
      accepted,
      submissionId: id,
      statusMsg: json.status_msg || 'Unknown',
      slug: src.slug || slugFromLocation(),
      lang: json.lang || src.lang || null,
      prettyLang: json.pretty_lang || null,
      questionId: json.question_id != null ? String(json.question_id) : src.questionId || null,
      code: src.code || null,
      runtime: json.status_runtime || null,
      memory: json.status_memory || null,
      runtimePercentile: json.runtime_percentile ?? null,
      memoryPercentile: json.memory_percentile ?? null,
      totalCorrect: json.total_correct ?? null,
      totalTestcases: json.total_testcases ?? null,
      finishedAt: Date.now()
    });
  }

  function slugFromLocation() {
    const m = /\/problems\/([^/?#]+)/.exec(location.pathname);
    return m ? decodeURIComponent(m[1]) : null;
  }

  /* ------------------------------- fetch ------------------------------- */
  const nativeFetch = window.fetch;
  window.fetch = async function (input, init) {
    const url = absolute(input);
    let submitRecord = null;

    if (url && SUBMIT_RE.test(url)) {
      let bodyText = null;
      try {
        if (init && typeof init.body === 'string') bodyText = init.body;
        else if (input instanceof Request) bodyText = await input.clone().text();
      } catch (_) {}
      submitRecord = rememberSubmit(url, bodyText);
    }

    const response = await nativeFetch.apply(this, arguments);

    if (url && (submitRecord || CHECK_RE.test(url))) {
      response
        .clone()
        .text()
        .then((text) => {
          if (submitRecord) linkSubmitResponse(submitRecord, text);
          else handleCheck(url, text);
        })
        .catch(() => {});
    }
    return response;
  };

  /* ----------------------------- XMLHttpRequest ----------------------------- */
  const open = XMLHttpRequest.prototype.open;
  const send_ = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    this.__lgsUrl = absolute(url);
    return open.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    const url = this.__lgsUrl || '';
    let record = null;
    if (url && SUBMIT_RE.test(url) && typeof body === 'string') record = rememberSubmit(url, body);

    if (url && (record || CHECK_RE.test(url))) {
      this.addEventListener('load', () => {
        let text = '';
        try {
          text = this.responseType === '' || this.responseType === 'text'
            ? this.responseText
            : JSON.stringify(this.response);
        } catch (_) { return; }
        if (record) linkSubmitResponse(record, text);
        else handleCheck(url, text);
      });
    }
    return send_.apply(this, arguments);
  };
})();
