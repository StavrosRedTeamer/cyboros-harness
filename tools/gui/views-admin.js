/* Cyboros Console — Users (admin). A role only exists if someone can act with it:
   this is the surface for `admin`, over the same /api/users the CLI writes. */
'use strict';

const USER_ROLES = ['viewer', 'operator', 'admin'];

function usersPane() {
  return byId('tab-users');
}

async function renderUsers() {
  const pane = usersPane();
  if (!pane) return;
  if (!can('admin')) {
    pane.replaceChildren(el('div', { class: 'card' }, [
      el('h2', {}, 'Users'),
      el('p', { class: 'muted' }, 'Accounts and roles require the admin role. Ask an admin, or use node tools/users.js on the console host.'),
    ]));
    return;
  }
  pane.replaceChildren(el('p', { class: 'muted' }, 'loading…'));
  try {
    const data = await api('/api/users');
    pane.replaceChildren(...usersView(data));
  } catch (e) {
    pane.replaceChildren(el('div', { class: 'card' }, [el('h2', {}, 'Users'), el('p', { class: 'muted' }, String(e.message || e))]));
  }
}

function usersView(data) {
  const users = data.users || [];
  const admins = users.filter((u) => u.role === 'admin' && !u.disabled).length;
  return [
    el('div', { class: 'grid cols-2' }, [
      el('div', { class: 'card keel-accent' }, [
        el('h2', {}, 'Accounts'),
        el('p', { class: 'muted' }, `${users.length} account(s) · ${admins} enabled admin(s) · ${data.store || 'users.json'}`),
        el('p', { class: 'muted' }, 'Roles: viewer reads · operator runs the engagement · admin manages accounts. Passwords are stored as scrypt hashes and never shown again.'),
      ]),
      newUserCard(),
    ]),
    el('div', { class: 'card' }, [
      el('h2', {}, 'People'),
      el('div', { class: 'table-wrap' }, [
        el('table', {}, [
          el('thead', {}, el('tr', {}, ['Operator', 'Role', 'Status', 'Last sign-in', 'Actions'].map((h) => el('th', {}, h)))),
          el('tbody', {}, users.map((u) => userRow(u))),
        ]),
      ]),
      el('p', { class: 'muted', style: { marginTop: '10px' } }, 'The last enabled admin cannot be removed or demoted. Signing out ends only this browser session.'),
    ]),
  ];
}

function newUserCard() {
  const username = el('input', { type: 'text', id: 'nu-username', placeholder: 'alice', autocomplete: 'off', spellcheck: 'false' });
  const display = el('input', { type: 'text', id: 'nu-display', placeholder: 'Alice (optional)', autocomplete: 'off' });
  const role = el('select', { id: 'nu-role' }, USER_ROLES.map((r) => el('option', { value: r }, r)));
  role.value = 'operator';
  const password = el('input', { type: 'password', id: 'nu-password', autocomplete: 'new-password', placeholder: '12+ characters' });

  const generate = () => {
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    password.value = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    password.type = 'text';
    toast('Password generated — copy it now, it is shown once', 'ok');
  };

  const submit = el('button', { class: 'btn btn-primary', type: 'submit' }, 'Create account');
  const form = el('form', {
    class: 'uform',
    onSubmit: async (ev) => {
      ev.preventDefault();
      submit.disabled = true;
      try {
        await api('/api/users', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: username.value.trim(),
            display_name: display.value.trim(),
            role: role.value,
            password: password.value,
          }),
        });
        toast('Account created: ' + username.value.trim(), 'ok');
        await renderUsers();
      } catch (e) {
        toast(String(e.message || e), 'err');
        submit.disabled = false;
      }
    },
  }, [
    el('label', { class: 'ufield' }, [el('span', {}, 'Username'), username]),
    el('label', { class: 'ufield' }, [el('span', {}, 'Display name'), display]),
    el('label', { class: 'ufield' }, [el('span', {}, 'Role'), role]),
    el('label', { class: 'ufield' }, [el('span', {}, 'Password'), password]),
    el('div', { class: 'uform-actions' }, [
      el('button', { class: 'btn', type: 'button', onClick: generate }, 'Generate'),
      submit,
    ]),
  ]);

  return el('div', { class: 'card keel-green' }, [el('h2', {}, 'Add account'), form]);
}

function userRow(u) {
  const self = CC_USER && CC_USER.username === u.username;

  const roleSelect = el('select', {
    'aria-label': 'role for ' + u.username,
    onChange: (ev) => patchUser(u, { role: ev.target.value }),
  }, USER_ROLES.map((r) => el('option', { value: r }, r)));
  roleSelect.value = u.role;

  const status = el('span', { class: 'chip ' + (u.disabled ? 'crit' : 'ok') }, u.disabled ? 'disabled' : 'active');

  const actions = el('div', { class: 'row' }, []);
  const resetCell = el('span', {});

  const resetPassword = () => {
    const input = el('input', { type: 'password', 'aria-label': 'new password for ' + u.username, placeholder: 'new password' });
    const save = el('button', { class: 'btn btn-sm btn-primary', type: 'button' }, 'Set');
    save.addEventListener('click', async () => {
      if (!input.value) return;
      try {
        await api('/api/users/' + encodeURIComponent(u.username), {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: input.value }),
        });
        toast('Password updated for ' + u.username + ' (sessions ended)', 'ok');
        renderUsers();
      } catch (e) { toast(String(e.message || e), 'err'); }
    });
    resetCell.replaceChildren(el('div', { class: 'row' }, [input, save]));
  };

  actions.append(
    el('button', { class: 'btn btn-sm', type: 'button', onClick: resetPassword }, 'password…'),
    el('button', {
      class: 'btn btn-sm', type: 'button',
      onClick: () => patchUser(u, { disabled: !u.disabled }),
    }, u.disabled ? 'enable' : 'disable'),
    el('button', {
      class: 'btn btn-sm btn-danger', type: 'button',
      onClick: async () => {
        if (!confirm('Remove ' + u.username + '? Their sessions end immediately.')) return;
        try {
          await api('/api/users/' + encodeURIComponent(u.username), { method: 'DELETE' });
          toast('Removed ' + u.username, 'ok');
          renderUsers();
        } catch (e) { toast(String(e.message || e), 'err'); }
      },
    }, 'remove'),
  );

  return el('tr', {}, [
    el('td', {}, [
      el('strong', {}, u.username),
      self ? el('span', { class: 'chip', style: { marginLeft: '6px' } }, 'you') : null,
      u.display_name ? el('div', { class: 'muted' }, u.display_name) : null,
      resetCell,
    ]),
    el('td', {}, roleSelect),
    el('td', {}, status),
    el('td', { class: 'muted' }, u.last_login ? fmtTs(u.last_login) : 'never'),
    el('td', {}, actions),
  ]);
}

async function patchUser(u, patch) {
  try {
    await api('/api/users/' + encodeURIComponent(u.username), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
    });
    toast(u.username + ' updated', 'ok');
    renderUsers();
  } catch (e) {
    toast(String(e.message || e), 'err');
    renderUsers();
  }
}
