/* ════════════════════════════════════════════════════════════
   Working Paper № 01 — behaviour
   Vanilla JS. No dependencies, no build step.
   ════════════════════════════════════════════════════════════ */

(function () {
  "use strict";

  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ── Reveal on scroll ───────────────────────────────────────── */

  function reveal() {
    var els = document.querySelectorAll(".reveal");
    if (!els.length) return;

    if (reduceMotion || !("IntersectionObserver" in window)) {
      Array.prototype.forEach.call(els, function (el) {
        el.classList.add("is-visible");
      });
      return;
    }

    var io = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          entry.target.classList.add("is-visible");
          io.unobserve(entry.target);
        });
      },
      { rootMargin: "0px 0px -12% 0px", threshold: 0.08 }
    );

    Array.prototype.forEach.call(els, function (el) { io.observe(el); });
  }

  /* ── Reading progress ───────────────────────────────────────── */

  function progress() {
    var bar = document.getElementById("progressBar");
    if (!bar) return;

    var ticking = false;

    function update() {
      var doc = document.documentElement;
      var scrolled = doc.scrollTop || document.body.scrollTop;
      var height = doc.scrollHeight - doc.clientHeight;
      var pct = height > 0 ? (scrolled / height) * 100 : 0;
      bar.style.width = pct.toFixed(2) + "%";
      ticking = false;
    }

    window.addEventListener("scroll", function () {
      if (!ticking) {
        ticking = true;
        window.requestAnimationFrame(update);
      }
    }, { passive: true });

    update();
  }

  /* ── Copy email ─────────────────────────────────────────────── */

  function copyEmail() {
    var btn = document.getElementById("copyEmail");
    if (!btn) return;

    var original = "Copy";
    var email = btn.getAttribute("data-email");

    function flash(label) {
      btn.textContent = label;
      btn.classList.add("is-done");
      window.setTimeout(function () {
        btn.textContent = original;
        btn.classList.remove("is-done");
      }, 1600);
    }

    btn.addEventListener("click", function () {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(email).then(
          function () { flash("Copied ✓"); },
          function () { flash("Select above"); }
        );
      } else {
        flash("Select above");
      }
    });
  }

  /* ── Colophon year ──────────────────────────────────────────── */

  function year() {
    var el = document.getElementById("year");
    if (el) el.textContent = String(new Date().getFullYear());
  }

  /* ── Geometric Brownian Motion walk (canvas) ──────────────────
     S_t = S_0 · exp((μ − σ²/2)·t + σ·W_t)
     Integrated with Euler discretisation, Box–Muller normals.
     ---------------------------------------------------------------- */

  function randomWalk() {
    var canvas = document.getElementById("walkCanvas");
    if (!canvas) return;

    var ctx = canvas.getContext("2d");
    if (!ctx) return;

    var MU = 0.08;      // drift
    var SIGMA = 0.20;   // volatility
    var STEPS = 260;    // resolution of the path
    var INK = "#8c2f28";

    var points = [];
    var start = null;

    function build() {
      // One clean path, seeded deterministically so the figure is stable.
      var seed = 20260401;
      function rnd() {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed / 0x7fffffff;
      }
      function normal() {
        var u1 = rnd() || 1e-9;
        var u2 = rnd();
        return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      }

      var dt = 1 / STEPS;
      var s = 1;
      points = [s];
      for (var i = 1; i <= STEPS; i++) {
        s = s * Math.exp((MU - 0.5 * SIGMA * SIGMA) * dt + SIGMA * Math.sqrt(dt) * normal());
        points.push(s);
      }
    }

    function size() {
      var dpr = window.devicePixelRatio || 1;
      var rect = canvas.getBoundingClientRect();
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      return { w: rect.width, h: rect.height };
    }

    function draw(dim, upto) {
      var w = dim.w, h = dim.h;
      ctx.clearRect(0, 0, w, h);

      var padX = 2;
      var padY = h * 0.14;
      var usableH = h - padY * 2;

      var min = Math.min.apply(null, points);
      var max = Math.max.apply(null, points);
      var range = max - min || 1;

      var n = Math.max(2, Math.floor(upto));

      function px(i) { return padX + (i / (points.length - 1)) * (w - padX * 2); }
      function py(v) { return padY + (1 - (v - min) / range) * usableH; }

      // Baseline (initial price S0)
      var baseY = py(1);
      ctx.strokeStyle = "rgba(26, 24, 21, 0.16)";
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 5]);
      ctx.beginPath();
      ctx.moveTo(padX, baseY);
      ctx.lineTo(w - padX, baseY);
      ctx.stroke();
      ctx.setLineDash([]);

      // The path
      ctx.strokeStyle = INK;
      ctx.lineWidth = 1.75;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.beginPath();
      for (var i = 0; i < n; i++) {
        var x = px(i), y = py(points[i]);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();

      // Head marker
      if (n > 1 && n < points.length) {
        var hx = px(n - 1), hy = py(points[n - 1]);
        ctx.fillStyle = INK;
        ctx.beginPath();
        ctx.arc(hx, hy, 3, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    build();
    var dim = size();
    draw(dim, points.length);

    if (reduceMotion) return;

    function animate(ts) {
      if (start === null) start = ts;
      var elapsed = ts - start;
      var dur = 2600;
      var t = Math.min(1, elapsed / dur);
      var eased = 1 - Math.pow(1 - t, 3);
      draw(dim, 1 + eased * (points.length - 1));
      if (t < 1) window.requestAnimationFrame(animate);
    }

    var seen = false;
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting && !seen) {
          seen = true;
          window.requestAnimationFrame(animate);
        }
      });
    }, { threshold: 0.25 });
    io.observe(canvas);

    // Keep the canvas crisp on resize
    var resizeTimer;
    window.addEventListener("resize", function () {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(function () {
        dim = size();
        draw(dim, points.length);
      }, 150);
    });
  }

  /* ── Boot ───────────────────────────────────────────────────── */

  function init() {
    reveal();
    progress();
    copyEmail();
    year();
    randomWalk();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
