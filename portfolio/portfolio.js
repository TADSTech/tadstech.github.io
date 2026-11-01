/* ════════════════════════════════════════════════════════════
   Working Paper № 01 — §P Repository Index
   A client-side GitHub index. Vanilla JS, no dependencies.

   Engineering notes (this file is the point of the page):
     · Transport  — GitHub REST v3, retry w/ backoff, AbortController
     · Resilience — Promise.allSettled so one 404 never kills a batch
     · Cache      — sessionStorage with TTL, surfaced as telemetry
     · Safety     — markdown rendered through a hand-rolled parser that
                    HTML-escapes first, so README content can't inject
     · Feedback   — five pipeline stages + six live telemetry readouts,
                    all read from real response headers and timers
   ════════════════════════════════════════════════════════════ */

(function () {
  "use strict";

  /* ── Configuration ──────────────────────────────────────────── */

  var USER = "TADSTech";
  var BATCH = 3;      // repos per click
  var MAX_REPOS = 12; // hard ceiling
  var CACHE_TTL = {
    list: 5 * 60 * 1000,     // 5 min — repo list changes slowly
    readme: 24 * 60 * 60 * 1000 // 24 h — READMEs change rarely
  };

  var API = "https://api.github.com";

  /* ── State ──────────────────────────────────────────────────── */

  var state = {
    all: [],          // normalized + sorted repo records
    shown: 0,         // how many cards are in the DOM
    sort: "pushed",   // 'pushed' | 'created'
    controller: null, // aborts in-flight README fetches
    loading: false,
    requests: 0,
    latency: null,    // ms, list fetch
    cacheHits: 0,
    rate: null        // { remaining, limit }
  };

  var $ = function (id) { return document.getElementById(id); };

  /* ── Small formatters ───────────────────────────────────────── */

  function pad(n) { return n < 10 ? "0" + n : String(n); }

  function fmtDate(iso) {
    if (!iso) return "—";
    var d = new Date(iso);
    if (isNaN(d)) return "—";
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }

  function fmtInt(n) {
    if (n === null || n === undefined) return "—";
    return Number(n).toLocaleString("en-US");
  }

  function fmtSize(kb) {
    if (kb === null || kb === undefined) return "—";
    if (kb < 1024) return kb + " KB";
    return (kb / 1024).toFixed(1) + " MB";
  }

  function fmtMs(ms) {
    if (ms === null || ms === undefined) return "—";
    if (ms < 1000) return Math.round(ms) + " ms";
    return (ms / 1000).toFixed(2) + " s";
  }

  function esc(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  /* ══ Telemetry ═════════════════════════════════════════════ */

  function setTelemetry(id, value, cls) {
    var el = $(id);
    if (!el) return;
    el.textContent = value;
    el.classList.remove("is-hot", "is-warn");
    if (cls) el.classList.add(cls);
  }

  function paintTelemetry() {
    setTelemetry("tReq", String(state.requests));
    setTelemetry("tLat", fmtMs(state.latency));
    setTelemetry(
      "tCache",
      state.cacheHits > 0 ? state.cacheHits + " hit" + (state.cacheHits > 1 ? "s" : "") : "cold",
      state.cacheHits > 0 ? "is-hot" : null
    );

    if (state.rate) {
      var left = state.rate.remaining;
      setTelemetry(
        "tRate",
        left + " / " + state.rate.limit,
        left < 10 ? "is-warn" : null
      );
    }

    var batches = Math.ceil(MAX_REPOS / BATCH);
    var used = Math.ceil(state.shown / BATCH);
    setTelemetry("tShown", state.shown + " / " + MAX_REPOS);
    setTelemetry("tBatch", used + " / " + batches);
  }

  function readRateLimit(res) {
    var remaining = res.headers.get("x-ratelimit-remaining");
    var limit = res.headers.get("x-ratelimit-limit");
    if (remaining !== null && limit !== null) {
      state.rate = { remaining: Number(remaining), limit: Number(limit) };
    }
  }

  /* ══ Pipeline stages ═══════════════════════════════════════ */

  function stage(name, status, detail) {
    var el = document.querySelector('.stage[data-stage="' + name + '"]');
    if (!el) return;
    el.classList.remove("is-active", "is-done", "is-error");
    if (status) el.classList.add(status);
    var v = el.querySelector(".stage__v");
    if (v) v.textContent = detail || "";
  }

  function resetStages() {
    ["fetch", "normalize", "readme", "parse", "render"].forEach(function (s) {
      stage(s, null, "idle");
    });
  }

  /* ══ Cache (sessionStorage, TTL-guarded) ═══════════════════ */

  function cacheGet(key, ttl) {
    try {
      var raw = sessionStorage.getItem("wp:repos:" + key);
      if (!raw) return null;
      var bag = JSON.parse(raw);
      if (!bag || typeof bag.t !== "number") return null;
      if (Date.now() - bag.t > ttl) {
        sessionStorage.removeItem("wp:repos:" + key);
        return null;
      }
      state.cacheHits++;
      return bag.v;
    } catch (e) {
      return null;
    }
  }

  function cachePut(key, value) {
    try {
      sessionStorage.setItem(
        "wp:repos:" + key,
        JSON.stringify({ t: Date.now(), v: value })
      );
    } catch (e) { /* quota or private mode — degrade to no cache */ }
  }

  function cacheDrop(prefix) {
    try {
      var doomed = [];
      for (var i = 0; i < sessionStorage.length; i++) {
        var k = sessionStorage.key(i);
        if (k && k.indexOf("wp:repos:" + prefix) === 0) doomed.push(k);
      }
      doomed.forEach(function (k) { sessionStorage.removeItem(k); });
    } catch (e) { /* ignore */ }
  }

  /* ══ Transport: fetch with retry + backoff + abort ═════════ */

  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  /**
   * fetchJSON — GET a URL, parse JSON, honour an AbortSignal.
   * Retries twice on network failure or 5xx with exponential backoff.
   * 4xx (other than 403 rate-limit) is terminal: retrying won't help.
   */
  function fetchJSON(url, signal, attempt) {
    attempt = attempt || 0;
    var t0 = performance.now();

    return fetch(url, {
      signal: signal,
      headers: { Accept: "application/vnd.github+json" }
    }).then(function (res) {
      state.requests++;
      readRateLimit(res);

      if (res.status === 403 || res.status === 429) {
        var err = new Error("rate-limited");
        err.code = "RATE_LIMIT";
        throw err;
      }

      if (res.status >= 500 && attempt < 2) {
        return sleep(400 * Math.pow(3, attempt)).then(function () {
          return fetchJSON(url, signal, attempt + 1);
        });
      }

      if (!res.ok) {
        var e2 = new Error("HTTP " + res.status);
        e2.code = res.status;
        throw e2;
      }

      state.latency = performance.now() - t0;
      return res.json();
    }).catch(function (err) {
      if (err && err.name === "AbortError") throw err;
      if (err && (err.code === "RATE_LIMIT" || typeof err.code === "number")) throw err;
      // network-level failure → retry
      if (attempt < 2) {
        return sleep(400 * Math.pow(3, attempt)).then(function () {
          return fetchJSON(url, signal, attempt + 1);
        });
      }
      throw err;
    });
  }

  /**
   * fetchReadme — pull raw README text.
   * The /readme endpoint resolves filename casing and default branch for us,
   * and the raw media type skips base64 entirely. Falls back to decoding
   * the base64 payload if the raw type isn't honoured.
   */
  function fetchReadme(fullName, signal) {
    var url = API + "/repos/" + fullName + "/readme";
    var t0 = performance.now();

    return fetch(url, {
      signal: signal,
      headers: {
        Accept: "application/vnd.github.raw+json",
        "X-GitHub-Api-Version": "2022-11-28"
      }
    }).then(function (res) {
      state.requests++;
      readRateLimit(res);

      if (res.status === 404) return null;      // legitimately no README
      if (res.status >= 500) throw new Error("HTTP " + res.status);
      if (!res.ok) throw new Error("HTTP " + res.status);

      var type = res.headers.get("content-type") || "";
      if (type.indexOf("json") !== -1) {
        return res.json().then(function (j) {
          if (!j || !j.content) return null;
          if (j.encoding === "base64") return b64ToUtf8(j.content);
          return String(j.content);
        });
      }
      return res.text();
    }).then(function (text) {
      if (text !== null && performance.now() - t0 > 0) {
        // no-op branch kept for clarity: latency reported by list fetch
      }
      return text;
    });
  }

  function b64ToUtf8(b64) {
    try {
      var bin = atob(b64.replace(/\s/g, ""));
      var bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new TextDecoder("utf-8").decode(bytes);
    } catch (e) {
      return null;
    }
  }

  /* ══ Markdown renderer ═════════════════════════════════════
     Escapes everything first, then applies markdown. Because the
     source is escaped before any tag is produced, a README containing
     <script> or <img onerror=…> can only ever render as text.
     Relative URLs are rewritten against the repo so links and images
     actually resolve off-GitHub.
     ─────────────────────────────────────────────────────────── */

  function makeRenderer(ctx) {
    var blobBase = "https://github.com/" + ctx.full_name + "/blob/" + ctx.branch + "/";
    var rawBase = "https://raw.githubusercontent.com/" + ctx.full_name + "/" + ctx.branch + "/";

    function resolveUrl(u, forImage) {
      u = String(u || "").trim();
      if (!u) return "";
      if (/^(https?:|mailto:)/i.test(u)) return u;
      if (u.indexOf("//") === 0) return "https:" + u;
      if (u.charAt(0) === "#") return u;
      // drop leading ./ and resolve relative to the repo
      var rel = u.replace(/^\.\//, "").replace(/^\//, "");
      return (forImage ? rawBase : blobBase) + rel;
    }

    /* Inline pass — runs on already-escaped text. */
    function inline(raw) {
      var text = raw;

      // 1. stash inline code so later rules can't touch it
      var codes = [];
      text = text.replace(/`([^`\n]+)`/g, function (m, c) {
        codes.push(c);
        return "\u0000C" + (codes.length - 1) + "\u0000";
      });

      // 2. images (before links — they share the ![…](…) shape)
      text = text.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;.*?&quot;)?\)/g,
        function (m, alt, url) {
          var href = resolveUrl(url, true);
          if (!href) return "";
          return '<img src="' + href + '" alt="' + alt + '" loading="lazy">';
        });

      // 3. links
      text = text.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;.*?&quot;)?\)/g,
        function (m, label, url) {
          var href = resolveUrl(url, false);
          if (!href) return label;
          var ext = /^https?:/i.test(href);
          return '<a href="' + href + '"' +
            (ext ? ' target="_blank" rel="noopener noreferrer"' : "") +
            ">" + label + "</a>";
        });

      // 4. emphasis — bold before italic so ** isn't eaten by *
      text = text.replace(/\*\*\*([\s\S]+?)\*\*\*/g, "<strong><em>$1</em></strong>");
      text = text.replace(/\*\*([\s\S]+?)\*\*/g, "<strong>$1</strong>");
      text = text.replace(/(^|[^*\w])\*([^*\n]+)\*(?![*\w])/g, "$1<em>$2</em>");
      text = text.replace(/(^|[^_\w])__([\s\S]+?)__(?![_\w])/g, "$1<strong>$2</strong>");
      text = text.replace(/(^|[^_\w])_([^_\n]+)_(?![_\w])/g, "$1<em>$2</em>");
      text = text.replace(/~~([\s\S]+?)~~/g, "<del>$1</del>");

      // 5. autolink bare URLs that survived outside [ ]( )
      text = text.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g,
        function (m, pre, url) {
          return pre + '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + url + "</a>";
        });

      // 6. restore code spans
      text = text.replace(/\u0000C(\d+)\u0000/g, function (m, i) {
        return "<code>" + codes[Number(i)] + "</code>";
      });

      return text;
    }

    /* Block-level list building with one-or-more levels of nesting. */
    function renderListEntries(entries, idx, indent) {
      var ordered = entries[idx].ordered;
      var tag = ordered ? "ol" : "ul";
      var html = "<" + tag + ">";
      var i = idx;

      while (i < entries.length && entries[i].indent >= indent) {
        if (entries[i].indent > indent) break;

        // gather any deeper entries as a nested list inside this <li>
        var nested = "";
        var j = i + 1;
        while (j < entries.length && entries[j].indent > indent) {
          var sub = renderListEntries(entries, j, entries[j].indent);
          nested += sub.html;
          j = sub.next;
        }

        var content = entries[i].content;
        var task = content.match(/^\[([ xX])\]\s*([\s\S]*)$/);
        if (task) {
          var checked = task[1] !== " " ? " checked" : "";
          html += '<li class="md-task"><input type="checkbox" disabled' + checked +
            "> " + inline(task[2]) + "</li>";
        } else {
          html += "<li>" + inline(content) + nested + "</li>";
        }

        i = j;
      }

      html += "</" + tag + ">";
      return { html: html, next: i };
    }

    /* Main block pass. */
    function render(src) {
      if (!src) return "";

      // ── Step 1: lift fenced code out BEFORE escaping, so we can
      //    escape its contents exactly once, at emit time.
      var fences = [];
      var srcLines = String(src).replace(/\r\n/g, "\n").split("\n");
      var staged = [];
      var k = 0;

      while (k < srcLines.length) {
        var open = srcLines[k].match(/^\s*(`{3,}|~{3,})\s*([^\s`]*)\s*$/);
        if (open) {
          var ch = open[1].charAt(0);
          var len = open[1].length;
          var buf = [];
          k++;
          while (k < srcLines.length) {
            var t = srcLines[k].trim();
            // closing fence = a run of the same fence char, at least as long
            var isClose = t.length >= len && !t.split("").some(function (c) { return c !== ch; });
            if (isClose) { k++; break; }
            buf.push(srcLines[k]);
            k++;
          }
          fences.push({ lang: open[2] || "", code: buf.join("\n") });
          staged.push("\u0000F" + (fences.length - 1) + "\u0000");
        } else {
          staged.push(srcLines[k]);
          k++;
        }
      }

      // ── Step 2: escape everything that is left
      var text = esc(staged.join("\n"));

      // ── Step 3: stash inline code
      var codes = [];
      text = text.replace(/`([^`\n]+)`/g, function (m, c) {
        codes.push(c);
        return "\u0000C" + (codes.length - 1) + "\u0000";
      });

      // ── Step 4: walk blocks
      var lines = text.split("\n");
      var out = [];
      var para = [];
      var i = 0;

      function flush() {
        if (para.length) {
          out.push("<p>" + inline(para.join(" ")) + "</p>");
          para = [];
        }
      }

      while (i < lines.length) {
        var line = lines[i];
        var trimmed = line.trim();

        // emitted fence placeholder
        var fm = trimmed.match(/^\u0000F(\d+)\u0000$/);
        if (fm) {
          flush();
          var f = fences[Number(fm[1])];
          var cls = f.lang ? ' class="language-' + esc(f.lang) + '"' : "";
          out.push("<pre><code" + cls + ">" + esc(f.code) + "</code></pre>");
          i++;
          continue;
        }

        if (!trimmed) { flush(); i++; continue; }

        // heading
        var hm = trimmed.match(/^(#{1,6})\s+(.*)$/);
        if (hm) {
          flush();
          var lvl = hm[1].length;
          out.push("<h" + lvl + ">" + inline(hm[2]) + "</h" + lvl + ">");
          i++;
          continue;
        }

        // horizontal rule
        if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
          flush();
          out.push("<hr>");
          i++;
          continue;
        }

        // blockquote ( '>' becomes '&gt;' after escaping )
        if (/^(?:&gt;|\u003e)\s?/.test(trimmed)) {
          flush();
          var q = [];
          while (i < lines.length && /^\s*(?:&gt;|>)/.test(lines[i])) {
            q.push(lines[i].replace(/^\s*(?:&gt;|>)\s?/, ""));
            i++;
          }
          out.push("<blockquote>" + render(q.join("\n")) + "</blockquote>");
          continue;
        }

        // table
        if (trimmed.charAt(0) === "|" && i + 1 < lines.length &&
            /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1])) {
          flush();
          var head = splitRow(lines[i]);
          i += 2;
          var rows = [];
          while (i < lines.length && lines[i].trim().charAt(0) === "|") {
            rows.push(splitRow(lines[i]));
            i++;
          }
          out.push(renderTable(head, rows));
          continue;
        }

        // list
        if (/^\s*(?:[-*+]|\d+[.)])\s+/.test(line)) {
          flush();
          var entries = [];
          while (i < lines.length && /^\s*(?:[-*+]|\d+[.)])\s+/.test(lines[i])) {
            var m = lines[i].match(/^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/);
            entries.push({
              indent: m[1].replace(/\t/g, "  ").length,
              ordered: /^\s*\d+/.test(lines[i]),
              content: m[2]
            });
            i++;
          }
          out.push(renderListEntries(entries, 0, entries[0].indent).html);
          continue;
        }

        // indented code (4 spaces) — only when not continuing a paragraph
        if (/^(?: {4}|\t)/.test(line) && !para.length) {
          flush();
          var code = [];
          while (i < lines.length && (/^(?: {4}|\t)/.test(lines[i]) || !lines[i].trim())) {
            if (!lines[i].trim() && code.length && code[code.length - 1] === "") break;
            code.push(lines[i].replace(/^(?: {4}|\t)/, ""));
            i++;
          }
          out.push("<pre><code>" + esc(code.join("\n")) + "</code></pre>");
          continue;
        }

        para.push(trimmed);
        i++;
      }
      flush();

      // ── Step 5: restore inline code spans
      var html = out.join("\n");
      html = html.replace(/\u0000C(\d+)\u0000/g, function (m, n) {
        return "<code>" + codes[Number(n)] + "</code>";
      });

      return html;
    }

    function splitRow(row) {
      var r = row.trim().replace(/^\|/, "").replace(/\|$/, "");
      return r.split("|").map(function (c) { return c.trim(); });
    }

    function renderTable(head, rows) {
      var th = head.map(function (c) { return "<th>" + inline(c) + "</th>"; }).join("");
      var tb = rows.map(function (r) {
        return "<tr>" + head.map(function (_, n) {
          return "<td>" + inline(r[n] || "") + "</td>";
        }).join("") + "</tr>";
      }).join("");
      return '<div class="md-tablewrap"><table><thead><tr>' + th +
        "</tr></thead><tbody>" + tb + "</tbody></table></div>";
    }

    return { render: render, inline: inline };
  }

  /* ══ Normalization ═════════════════════════════════════════ */

  function normalize(list) {
    return list
      .filter(function (r) { return r && !r.private; })
      .map(function (r) {
        return {
          id: r.id,
          name: r.name,
          full_name: r.full_name,
          html_url: r.html_url,
          description: r.description,
          language: r.language,
          stargazers_count: r.stargazers_count || 0,
          forks_count: r.forks_count || 0,
          open_issues_count: r.open_issues_count || 0,
          size: r.size,
          fork: !!r.fork,
          archived: !!r.archived,
          license: r.license && r.license.spdx_id ? r.license.spdx_id : null,
          default_branch: r.default_branch || "main",
          created_at: r.created_at,
          pushed_at: r.pushed_at,
          topics: r.topics || []
        };
      });
  }

  // data-sort values are UI-facing; the normalized records use *_at fields.
  var SORT_FIELDS = { pushed: "pushed_at", created: "created_at" };

  function applySort() {
    var key = SORT_FIELDS[state.sort] || "pushed_at";
    state.all.sort(function (a, b) {
      var av = a[key] || "";
      var bv = b[key] || "";
      return av < bv ? 1 : av > bv ? -1 : 0; // desc
    });
  }

  /* ══ Card rendering ════════════════════════════════════════ */

  function metaCell(k, v, href) {
    var value = href
      ? '<a href="' + href + '" target="_blank" rel="noopener noreferrer">' + esc(v) + "</a>"
      : esc(v);
    return '<div><span class="meta__k">' + esc(k) + '</span><span class="meta__v">' + value + "</span></div>";
  }

  function buildCard(repo, index, readmeText) {
    var art = document.createElement("article");
    art.className = "log__item";

    var panelId = "readme-" + repo.id;
    var hasReadme = typeof readmeText === "string" && readmeText.trim().length > 0;

    var flags = [];
    if (repo.language) flags.push('<span class="flag flag--lang">' + esc(repo.language) + "</span>");
    if (repo.fork) flags.push('<span class="flag flag--fork">fork</span>');
    if (repo.archived) flags.push('<span class="flag flag--archived">archived</span>');
    if (repo.license) flags.push('<span class="flag">' + esc(repo.license) + "</span>");
    (repo.topics || []).slice(0, 4).forEach(function (t) {
      flags.push('<span class="flag">' + esc(t) + "</span>");
    });

    var desc = repo.description
      ? '<p class="repo__desc">' + esc(repo.description) + "</p>"
      : '<p class="repo__desc is-empty">// no description provided</p>';

    var readmeInner;
    if (!hasReadme) {
      readmeInner = '<p class="readme__none">// no README in this repository</p>';
    } else {
      var md = makeRenderer({ full_name: repo.full_name, branch: repo.default_branch });
      readmeInner = '<div class="readme__body md">' + md.render(readmeText) + "</div>";
    }

    art.innerHTML =
      '<div class="log__node" aria-hidden="true"></div>' +
      '<div class="log__card">' +
        '<div class="repo__head">' +
          '<h3 class="repo__name"><a href="' + esc(repo.html_url) + '" target="_blank" rel="noopener noreferrer">' +
            esc(repo.name) + "</a></h3>" +
          '<span class="repo__idx">' + pad(index + 1) + " / " + pad(MAX_REPOS) + "</span>" +
        "</div>" +
        (flags.length ? '<div class="repo__flags">' + flags.join("") + "</div>" : "") +
        desc +
        '<div class="repo__meta">' +
          metaCell("updated", fmtDate(repo.pushed_at)) +
          metaCell("created", fmtDate(repo.created_at)) +
          metaCell("stars", fmtInt(repo.stargazers_count)) +
          metaCell("forks", fmtInt(repo.forks_count)) +
          metaCell("issues", fmtInt(repo.open_issues_count)) +
          metaCell("size", fmtSize(repo.size)) +
          metaCell("branch", repo.default_branch) +
        "</div>" +
        '<button type="button" class="readme__toggle" aria-expanded="false" aria-controls="' + panelId + '">' +
          '<span class="readme__chev">▶</span> README' +
        "</button>" +
        '<div class="readme__panel" id="' + panelId + '"><div class="readme__inner">' +
          '<div class="readme__inner-pad">' + readmeInner + "</div>" +
        "</div></div>" +
      "</div>";

    var btn = art.querySelector(".readme__toggle");
    var panel = art.querySelector(".readme__panel");
    btn.addEventListener("click", function () {
      var open = btn.getAttribute("aria-expanded") === "true";
      btn.setAttribute("aria-expanded", open ? "false" : "true");
      panel.classList.toggle("is-open", !open);
    });

    return art;
  }

  /* ══ Orchestration ═════════════════════════════════════════ */

  function setStatus(text, done) {
    var el = $("loadStatus");
    if (!el) return;
    el.textContent = text;
    el.classList.toggle("is-done", !!done);
  }

  function showError(message) {
    var box = $("errorBox");
    if (!box) return;
    box.hidden = false;
    box.innerHTML =
      "<strong>Index unavailable.</strong> " + esc(message) +
      "<br>GitHub allows 60 unauthenticated requests per hour per IP; the counter resets " +
      "on the hour. Try again shortly, or browse the repositories directly at " +
      '<a href="https://github.com/' + USER + '?tab=repositories" target="_blank" rel="noopener noreferrer">github.com/' +
      USER + "</a>." +
      '<br><button type="button" class="btn" id="retryBtn">Retry</button>';

    var retry = $("retryBtn");
    if (retry) {
      retry.addEventListener("click", function () {
        box.hidden = true;
        cacheDrop("list");
        loadInitial();
      });
    }
  }

  function loadInitial() {
    var list = $("repoList");
    var btn = $("loadMore");
    if (btn) btn.hidden = true;
    resetStages();
    state.requests = 0;
    state.cacheHits = 0;
    state.latency = null;
    paintTelemetry();

    // ── Stage 01 · fetch
    stage("fetch", "is-active", "GET /users/" + USER + "/repos");

    // cache key is sort-independent: we fetch once, sort client-side
    var cached = cacheGet("list", CACHE_TTL.list);

    var t0 = performance.now();
    var chain;

    if (cached) {
      chain = Promise.resolve(cached);
    } else {
      chain = fetchJSON(API + "/users/" + USER + "/repos?per_page=100&type=owner", null);
    }

    chain.then(function (raw) {
      if (!cached) cachePut("list", raw);
      stage("fetch", "is-done", fmtMs(performance.now() - t0) +
        (cached ? " · cache" : ""));

      // ── Stage 02 · normalize + sort
      stage("normalize", "is-active", "filter · sort · cap");
      state.all = normalize(raw);
      applySort();
      stage("normalize", "is-done", state.all.length + " public");

      var stamp = $("pheadStamp");
      if (stamp) {
        stamp.textContent = "as of " + new Date().toISOString().slice(0, 10) +
          " · " + state.all.length + " repos";
      }

      list.innerHTML = "";
      state.shown = 0;
      return loadBatch();
    }).catch(function (err) {
      if (err && err.name === "AbortError") return;
      stage("fetch", "is-error", err && err.code === "RATE_LIMIT" ? "403 rate-limited" : "failed");
      list.innerHTML = "";
      showError(
        err && err.code === "RATE_LIMIT"
          ? "The GitHub API rate limit for this IP has been reached."
          : (err && err.message ? err.message : "network error")
      );
      setStatus("Could not reach the GitHub API.", false);
    });
  }

  function loadBatch() {
    if (state.loading) return;
    var btn = $("loadMore");
    if (btn) btn.disabled = true;

    var slice = state.all.slice(state.shown, state.shown + BATCH);
    if (!slice.length) { finish(); return; }

    state.loading = true;

    // ── Stage 03 · READMEs, allSettled so one 404 doesn't sink the batch
    stage("readme", "is-active", "0 / " + slice.length);

    if (state.controller) state.controller.abort();
    state.controller = new AbortController();
    var signal = state.controller.signal;

    var t0 = performance.now();
    var settled = 0;

    var promises = slice.map(function (repo) {
      var key = "readme:" + repo.full_name;
      var hit = cacheGet(key, CACHE_TTL.readme);
      if (hit !== null) {
        settled++;
        stage("readme", "is-active", settled + " / " + slice.length + " · cache");
        return Promise.resolve(hit);
      }
      return fetchReadme(repo.full_name, signal).then(function (text) {
        if (text !== null) cachePut(key, text);
        settled++;
        stage("readme", "is-active", settled + " / " + slice.length);
        return text;
      }).catch(function (err) {
        if (err && err.name === "AbortError") throw err;
        settled++;
        stage("readme", "is-active", settled + " / " + slice.length + " · 1 failed");
        return null; // degrade to "no README" rather than failing the card
      });
    });

    Promise.allSettled(promises).then(function (results) {
      if (results.some(function (r) { return r.status === "rejected" &&
          r.reason && r.reason.name === "AbortError"; })) return;

      var ok = results.filter(function (r) { return r.status === "fulfilled"; }).length;
      stage("readme", ok === results.length ? "is-done" : "is-error",
        ok + " / " + results.length + " · " + fmtMs(performance.now() - t0));

      // ── Stage 04 · parse + Stage 05 · render
      stage("parse", "is-active", "escape → blocks → inline");
      var docs = results.map(function (r) {
        return r.status === "fulfilled" ? r.value : null;
      });
      stage("parse", "is-done", docs.filter(function (d) { return d; }).length + " docs");

      stage("render", "is-active", "mounting " + slice.length + " nodes");
      var list = $("repoList");
      var frag = document.createDocumentFragment();
      slice.forEach(function (repo, n) {
        frag.appendChild(buildCard(repo, state.shown + n, docs[n]));
      });
      list.appendChild(frag);
      stage("render", "is-done", "+" + slice.length + " cards");

      state.shown += slice.length;
      state.loading = false;
      paintTelemetry();
      updateControls();
    });
  }

  function updateControls() {
    var btn = $("loadMore");
    var remaining = Math.min(MAX_REPOS, state.all.length) - state.shown;
    var total = Math.min(MAX_REPOS, state.all.length);

    if (remaining > 0) {
      if (btn) {
        btn.hidden = false;
        btn.disabled = false;
        btn.textContent = "Load " + Math.min(BATCH, remaining) + " more";
      }
      setStatus("Showing " + state.shown + " of " + total +
        " · " + remaining + " remaining" +
        (state.all.length > MAX_REPOS ? " · " + (state.all.length - MAX_REPOS) + " older repos truncated" : ""));
    } else {
      if (btn) btn.hidden = true;
      setStatus(state.shown === 0
        ? "No public repositories found."
        : "All " + state.shown + " shown" +
          (state.all.length > MAX_REPOS ? " · index capped at " + MAX_REPOS : "") + ".",
        true);
    }
  }

  function finish() {
    state.loading = false;
    updateControls();
  }

  /* ══ Controls ══════════════════════════════════════════════ */

  function wireControls() {
    Array.prototype.forEach.call(document.querySelectorAll(".seg"), function (b) {
      b.addEventListener("click", function () {
        var sort = b.getAttribute("data-sort");
        if (sort === state.sort) return;

        state.sort = sort;
        Array.prototype.forEach.call(document.querySelectorAll(".seg"), function (x) {
          var on = x === b;
          x.classList.toggle("is-active", on);
          x.setAttribute("aria-pressed", on ? "true" : "false");
        });

        // abort anything in flight, then rebuild from the cached list
        if (state.controller) state.controller.abort();
        var list = $("repoList");
        if (list) list.innerHTML = "";
        state.shown = 0;
        state.loading = false;

        var cached = cacheGet("list", CACHE_TTL.list);
        if (cached) {
          state.all = normalize(cached);
          applySort();
          stage("normalize", "is-done", state.all.length + " · re-sorted");
          loadBatch();
        } else {
          loadInitial();
        }
      });
    });

    var refresh = $("refresh");
    if (refresh) {
      refresh.addEventListener("click", function () {
        if (state.controller) state.controller.abort();
        cacheDrop("list");
        cacheDrop("readme:");
        var list = $("repoList");
        if (list) list.innerHTML = "";
        state.shown = 0;
        state.loading = false;
        loadInitial();
      });
    }

    var more = $("loadMore");
    if (more) more.addEventListener("click", loadBatch);
  }

  /* ══ Boot ══════════════════════════════════════════════════ */

  function boot() {
    wireControls();
    paintTelemetry();
    loadInitial();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
