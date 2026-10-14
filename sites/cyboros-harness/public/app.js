/* Cyboros Harness landing — motion + clipboard.
   One reveal mechanism: elements the stylesheet hides under .js get .is-in when
   they enter the viewport. Without JS nothing is hidden, because the .js class
   is only set by the inline head script. */
'use strict';

(function () {
  var root = document.documentElement;
  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---- reveal on scroll ----------------------------------------------------
  // One mechanism: anything that starts hidden in the stylesheet gets .is-in
  // when it scrolls into view. The hero headline is primed immediately so its
  // line-by-line rise plays on load rather than waiting for the observer.
  var hero = document.querySelector('.hero h1');
  var targets = document.querySelectorAll(
    '.gap-head, .drop, .split, .chain, .pull, .heat, .oracle, .ticks,' +
    ' .props, .tree, .shell, .caveat, .docs, .cite, .gap-turn, .chain-title'
  );

  if (reduced || !('IntersectionObserver' in window)) {
    if (hero) hero.classList.add('is-in');
    targets.forEach(function (el) { el.classList.add('is-in'); });
  } else {
    if (hero) requestAnimationFrame(function () { hero.classList.add('is-in'); });
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('is-in');
        io.unobserve(entry.target);
      });
    }, { rootMargin: '0px 0px -10% 0px', threshold: 0.1 });
    targets.forEach(function (el) { io.observe(el); });
  }

  // ---- section menu (under 900px) ------------------------------------------
  // The toggle is only visible in the narrow layout. It closes on a link
  // choice, on Escape (focus back to the toggle), on a click outside the
  // header, and when the viewport widens back to the inline nav.
  var nav = document.querySelector('.nav');
  var toggle = document.querySelector('.nav-toggle');

  if (nav && toggle) {
    var setOpen = function (open) {
      nav.classList.toggle('is-open', open);
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    };
    var isOpen = function () { return nav.classList.contains('is-open'); };

    toggle.addEventListener('click', function () { setOpen(!isOpen()); });

    nav.querySelectorAll('.nav-links a').forEach(function (a) {
      a.addEventListener('click', function () { setOpen(false); });
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && isOpen()) {
        setOpen(false);
        toggle.focus();
      }
    });

    document.addEventListener('click', function (e) {
      if (isOpen() && !nav.contains(e.target)) setOpen(false);
    });

    var wide = window.matchMedia('(min-width: 901px)');
    var onWide = function () { if (wide.matches) setOpen(false); };
    if (wide.addEventListener) wide.addEventListener('change', onWide);
    else if (wide.addListener) wide.addListener(onWide);
  }

  // ---- copy to clipboard ---------------------------------------------------
  var status = document.getElementById('copy-status');
  var buttons = document.querySelectorAll('.copy');

  function announce(msg) {
    if (!status) return;
    status.textContent = msg;
    window.clearTimeout(announce._t);
    announce._t = window.setTimeout(function () { status.textContent = ''; }, 2600);
  }

  function legacyCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (err) { ok = false; }
    document.body.removeChild(ta);
    return ok;
  }

  buttons.forEach(function (btn) {
    btn.addEventListener('click', function () {
      var source = document.getElementById(btn.getAttribute('data-copy'));
      if (!source) return;
      var text = source.innerText;
      var done = function (ok) {
        if (ok) {
          announce('Copied to clipboard.');
          var label = btn.textContent;
          btn.textContent = 'Copied';
          window.setTimeout(function () { btn.textContent = label; }, 1800);
        } else {
          announce('Copy failed — select the text manually.');
        }
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () { done(true); },
          function () { done(legacyCopy(text)); });
      } else {
        done(legacyCopy(text));
      }
    });
  });
})();
