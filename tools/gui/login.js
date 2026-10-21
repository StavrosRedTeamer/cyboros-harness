/* Cyboros Console — sign-in page logic. No deps, no token in the URL. */
'use strict';

(function () {
  const form = document.getElementById('login-form');
  const userEl = document.getElementById('username');
  const passEl = document.getElementById('password');
  const msgEl = document.getElementById('msg');
  const btn = document.getElementById('submit');

  // Only same-origin relative paths: never redirect to an attacker-supplied host.
  function nextPath() {
    try {
      const raw = new URLSearchParams(location.search).get('next') || '/';
      if (!raw.startsWith('/') || raw.startsWith('//')) return '/';
      return raw;
    } catch { return '/'; }
  }

  function show(text) {
    msgEl.textContent = text;
  }

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    show('');
    const username = userEl.value.trim();
    const password = passEl.value;
    if (!username || !password) {
      show('Operator and password are required.');
      return;
    }
    btn.disabled = true;
    btn.textContent = 'Signing in…';
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      let body = null;
      try { body = await res.json(); } catch { /* non-JSON */ }
      if (res.ok && body && body.user) {
        location.replace(nextPath());
        return;
      }
      if (res.status === 429) {
        const wait = body && body.retryAfter ? body.retryAfter : 60;
        show('Too many failed attempts. Try again in ' + wait + 's.');
      } else if (res.status === 503) {
        show('The account store is unavailable on this host — an admin must fix users.json.');
      } else {
        show('Invalid credentials.');
        passEl.value = '';
        passEl.focus();
      }
    } catch (e) {
      show('Console unreachable: ' + (e && e.message ? e.message : 'network error'));
    } finally {
      btn.disabled = false;
      btn.textContent = 'Sign in';
    }
  });
})();
