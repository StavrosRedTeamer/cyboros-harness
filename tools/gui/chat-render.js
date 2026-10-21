/* Cyboros Console — chat rendering.
   Everything that turns transcript data into DOM: the markdown subset, a user bubble, an
   assistant turn (reasoning, text, tool cards, approval cards, action row) and the
   in-place painters used while a turn streams.

   It has no state and no transport: it receives a turn/part object, builds nodes, and asks
   the view for the behaviours it cannot own — editing a message, regenerating an answer,
   answering an approval.

   Requires app.js globals at call time: el, esc. */
(function () {
  'use strict';

  // The view sets all four at mount; a call before that is a wiring bug that should throw.
  var HOOKS = {};

  function init(hooks) {
    if (hooks) Object.assign(HOOKS, hooks);
  }

  // ── markdown ──────────────────────────────────────────────────────────────
  // The subset is the one model answers actually use: headings, horizontal rules,
  // blockquotes, ordered/unordered lists (with nesting), pipe tables, fenced and inline
  // code, bold/italic and links. Hand-rolled on purpose — a transcript renderer is not
  // worth a dependency — and safe by construction: every piece of model text goes
  // through esc() BEFORE a tag is emitted, the only attribute value interpolated is a
  // URL that matched https?://, and the tags themselves come from this fixed set. So a
  // model can write whatever it likes and none of it becomes markup.
  function markdown(src) {
    var codeBlocks = [];
    var text = String(src == null ? '' : src).replace(/\r\n?/g, '\n');
    // Fenced code first: its content is escaped once, stored, and later emitted as-is,
    // so nothing inside it is interpreted as markdown.
    text = text.replace(/```([\s\S]*?)```/g, function (_m, code) {
      var inner = code.replace(/^\n/, '').replace(/^[a-zA-Z0-9_.+-]{1,15}\n/, '').replace(/\n$/, '');
      codeBlocks.push('<pre class="chat-code">' + esc(inner) + '</pre>');
      return '\u0000B' + (codeBlocks.length - 1) + '\u0000';
    });

    var lines = text.split('\n');
    var out = [];
    var i = 0;
    while (i < lines.length) {
      var line = lines[i];
      if (!line.trim()) { i += 1; continue; }
      if (/^\u0000B\d+\u0000$/.test(line.trim())) { out.push(line.trim()); i += 1; continue; }

      var h = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
      if (h) {
        out.push('<' + 'h' + h[1].length + '>' + inline(h[2]) + '</h' + h[1].length + '>');
        i += 1;
        continue;
      }
      if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push('<hr>'); i += 1; continue; }

      if (/^\s{0,3}>\s?/.test(line)) {
        var quoted = [];
        while (i < lines.length && /^\s{0,3}>\s?/.test(lines[i])) {
          quoted.push(lines[i].replace(/^\s{0,3}>\s?/, ''));
          i += 1;
        }
        out.push('<blockquote>' + quoted.map(inline).join('<br>') + '</blockquote>');
        continue;
      }

      if (isTableStart(lines, i)) {
        out.push(renderTable(lines, i));
        i = tableEnd(lines, i);
        continue;
      }

      var item = listItem(line);
      if (item) {
        // Collect the whole run of list lines, but let buildList decide where one list
        // ends: an ordered list right after a bulleted one starts a second <ol>/<ul>.
        var start = i;
        var items = [];
        while (i < lines.length && listItem(lines[i])) { items.push(listItem(lines[i])); i += 1; }
        var built = buildList(items, 0, items[0].indent);
        out.push(built.html);
        i = start + built.next;               // re-enter for whatever the list did not take
        continue;
      }

      var para = [];
      while (i < lines.length) {
        var cur = lines[i];
        if (!cur.trim() || listItem(cur) || /^\u0000B\d+\u0000$/.test(cur.trim())) break;
        if (/^\s{0,3}>\s?/.test(cur) || /^\s{0,3}#{1,6}\s+/.test(cur)) break;
        if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(cur) || isTableStart(lines, i)) break;
        para.push(cur.trim());
        i += 1;
      }
      if (para.length) out.push('<p>' + para.map(inline).join('<br>') + '</p>');
    }
    // A fence that was not alone on its line lives on as a placeholder inside a
    // paragraph, list item or cell; swap those in last so their content is emitted verbatim.
    return out.join('').replace(/\u0000B(\d+)\u0000/g, function (_m, n) { return codeBlocks[Number(n)]; });
  }

  // Inline formatting. Backtick spans are lifted out first (their content must not be
  // bolded or linkified), then the text is escaped, then the transforms run on escaped
  // text, then the code spans come back already escaped.
  function inline(s) {
    var codes = [];
    var t = String(s == null ? '' : s).replace(/`([^`]+)`/g, function (_m, c) {
      codes.push('<code>' + esc(c) + '</code>');
      return '\u0000C' + (codes.length - 1) + '\u0000';
    });
    t = esc(t);
    t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    t = t.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
    t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    t = t.replace(/\u0000C(\d+)\u0000/g, function (_m, n) { return codes[Number(n)]; });
    return t;
  }

  // "- x" / "* x" / "+ x" / "12. x" / "12) x", with indentation for nesting. Tabs are
  // counted as two spaces so a model that mixes them still nests consistently.
  function listItem(line) {
    var m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(String(line == null ? '' : line));
    if (!m) return null;
    return {
      indent: m[1].replace(/\t/g, '  ').length,
      ordered: /\d/.test(m[2]),
      num: parseInt(m[2], 10) || 1,
      text: m[3],
    };
  }

  function buildList(items, start, indent) {
    var ordered = items[start].ordered;
    var tag = ordered ? 'ol' : 'ul';
    var open = ordered && items[start].num !== 1 ? '<ol start="' + items[start].num + '">' : '<' + tag + '>';
    var html = open;
    var i = start;
    while (i < items.length && items[i].indent >= indent) {
      if (items[i].indent > indent) {          // a deeper line belongs to the previous <li>
        var sub = buildList(items, i, items[i].indent);
        html += sub.html;
        i = sub.next;
        continue;
      }
      if (items[i].ordered !== ordered) break; // a different marker starts a new list
      html += '<li>' + inline(items[i].text);
      i += 1;
      if (i < items.length && items[i].indent > indent) {
        var child = buildList(items, i, items[i].indent);
        html += child.html;
        i = child.next;
      }
      html += '</li>';
    }
    return { html: html + '</' + tag + '>', next: i };
  }

  function splitRow(line) {
    return String(line).trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(function (c) { return c.trim(); });
  }

  // A pipe table needs a header row AND the |---|---| separator under it; without the
  // separator the pipes are just text (shell output lines, for instance).
  function isTableStart(lines, i) {
    if (i + 1 >= lines.length || lines[i].indexOf('|') === -1) return false;
    return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(lines[i + 1]);
  }

  function tableEnd(lines, i) {
    var j = i + 2;
    while (j < lines.length && lines[j].trim() && lines[j].indexOf('|') !== -1) j += 1;
    return j;
  }

  function renderTable(lines, i) {
    var head = splitRow(lines[i]);
    var align = splitRow(lines[i + 1]).map(function (c) {
      var left = /^:/.test(c);
      var right = /:$/.test(c);
      return left && right ? 'center' : right ? 'right' : left ? 'left' : '';
    });
    var cell = function (tag, text, a) {
      return '<' + tag + (a ? ' style="text-align:' + a + '"' : '') + '>' + inline(text) + '</' + tag + '>';
    };
    var html = '<table><thead><tr>' + head.map(function (c, k) { return cell('th', c, align[k]); }).join('') + '</tr></thead><tbody>';
    for (var r = i + 2; r < tableEnd(lines, i); r += 1) {
      var row = splitRow(lines[r]);
      html += '<tr>' + head.map(function (_c, k) { return cell('td', row[k] == null ? '' : row[k], align[k]); }).join('') + '</tr>';
    }
    return html + '</tbody></table>';
  }

  function assistantText(turn) {
    return (turn.parts || []).filter(function (p) { return p.type === 'text'; })
      .map(function (p) { return p.content; }).join('\n').trim();
  }

  var REASON_LABEL = {
    preset: 'blocked by preset',
    approval: 'denied',
    policy: 'blocked by policy',
    'invalid-args': 'invalid args'
  };

  // ── turns ─────────────────────────────────────────────────────────────────
  function turn(t) {
    return t.role === 'user' ? user(t) : assistant(t);
  }

  function user(t) {
    var bubble = el('div', { class: 'chat-user-bubble', html: esc(t.content).replace(/\n/g, '<br>') });
    var edit = el('button', {
      type: 'button', class: 'chat-action',
      title: 'Edit this message and resend from here',
      'aria-label': 'Edit message'
    }, 'edit');
    edit.addEventListener('click', function () { HOOKS.onEdit(t); });
    var node = el('div', { class: 'chat-turn chat-user' }, [
      el('div', { class: 'chat-user-wrap' }, [
        bubble,
        el('div', { class: 'chat-user-actions' }, [edit])
      ])
    ]);
    t.node = node;
    return node;
  }

  function assistant(t) {
    var body = el('div', { class: 'chat-assistant-body' });
    var node = el('div', { class: 'chat-turn chat-assistant' }, [
      el('div', { class: 'chat-avatar' }, [
        el('img', { src: '/img/mark.webp', alt: '', width: '22', height: '22' })
      ]),
      el('div', { class: 'chat-assistant-main' }, [body])
    ]);
    t.body = body;

    if (t.thinking) body.appendChild(thinking(t));
    (t.parts || []).forEach(function (part) {
      body.appendChild(partNode(t, part));
    });
    if (!t.parts.length && t.status === 'streaming') {
      body.appendChild(el('div', { class: 'chat-typing', html: '<span></span><span></span><span></span>' }));
    }
    body.appendChild(actionsRow(t));
    t.node = node;
    return node;
  }

  function thinking(t) {
    var pre = el('div', { class: 'chat-think-body' }, t.thinking || '');
    var wrap = el('details', { class: 'chat-think', open: true }, [
      el('summary', { class: 'chat-think-sum' }, 'Reasoning'),
      pre
    ]);
    t.thinkEl = pre;
    t.thinkWrap = wrap;
    return wrap;
  }

  function partNode(t, part) {
    if (part.type === 'text') return text(t, part);
    if (part.type === 'tool') return tool(part);
    if (part.type === 'approval') return approval(part);
    return el('div', null, '');
  }

  function text(t, part) {
    var node = el('div', { class: 'chat-prose', html: markdown(part.content || '') });
    if (part.open && t.status === 'streaming') {
      node.appendChild(el('span', { class: 'chat-cursor' }, '▍'));
    }
    part.node = node;
    return node;
  }

  function tool(part) {
    var head = el('button', { type: 'button', class: 'chat-tool-head', 'aria-expanded': 'false' }, [
      el('span', { class: 'chat-tool-dot' }),
      el('code', { class: 'chat-tool-name' }, part.tool),
      el('span', { class: 'chat-tool-args' }, summarizeArgs(part.args)),
      el('span', { class: 'chat-tool-badge' }, part.status === 'running' ? 'running' : '')
    ]);
    var pre = el('pre', { class: 'chat-tool-out' }, '');
    var body = el('div', { class: 'chat-tool-body', hidden: true }, [pre]);
    var node = el('div', { class: 'chat-tool', 'data-status': part.status || 'running' }, [head, body]);
    head.addEventListener('click', function () {
      var open = body.hidden;
      body.hidden = !open;
      head.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    part.node = node;
    part.head = head;
    part.body = body;
    part.pre = pre;
    paintTool(part);
    return node;
  }

  function summarizeArgs(args) {
    if (args == null) return '';
    try {
      var s = typeof args === 'string' ? args : JSON.stringify(args);
      return s.length > 88 ? s.slice(0, 88) + '…' : s;
    } catch (e) { return ''; }
  }

  function paintTool(part) {
    if (!part.node) return;
    var status = part.status || 'running';
    part.node.setAttribute('data-status', status);
    var badge = part.head.querySelector('.chat-tool-badge');
    // `interrupted` is not an exit code: the tool never reported one. Naming it
    // separately keeps a stopped turn from reading as a failed command.
    if (part.interrupted) badge.textContent = 'interrupted';
    else if (status === 'running') badge.textContent = 'running';
    else if (status === 'blocked') badge.textContent = REASON_LABEL[part.reason] || 'blocked';
    else if (status === 'error') badge.textContent = 'exit ' + (part.exit == null ? '?' : part.exit);
    else badge.textContent = 'done' + (part.durationMs != null ? ' · ' + part.durationMs + 'ms' : '');
    part.pre.textContent = part.output || (status === 'running' ? '…' : '(no output)');
    // A refusal is shown expanded: hiding the reason behind a click is how a blocked
    // action gets mistaken for an executed one. An interrupted card gets the same
    // treatment — its point is that there is no result behind it.
    if ((status === 'blocked' || part.interrupted) && part.body.hidden) {
      part.body.hidden = false;
      part.head.setAttribute('aria-expanded', 'true');
    }
  }

  function approval(part) {
    var actions = el('div', { class: 'chat-approval-actions' });
    var state = el('span', { class: 'chat-approval-state' }, '');
    [['approve', 'Approve', 'btn btn-primary btn-sm'], ['deny', 'Deny', 'btn btn-sm']].forEach(function (d) {
      var b = el('button', { type: 'button', class: d[2], 'data-decision': d[0] }, d[1]);
      b.addEventListener('click', function () { HOOKS.onDecide(part, d[0]); });
      actions.appendChild(b);
    });
    var node = el('div', { class: 'chat-approval', 'data-decision': part.decision || '' }, [
      el('div', { class: 'chat-approval-head' }, [
        el('span', { class: 'chat-approval-title' }, 'Approval required'),
        el('span', { class: 'chat-chip chat-chip-warn' }, part.tier || 'intrusive')
      ]),
      el('p', { class: 'chat-approval-why' }, 'This tool changes state on the target. Nothing runs until you decide.'),
      el('pre', { class: 'chat-approval-cmd' }, part.command || ''),
      part.reason ? el('span', { class: 'chat-approval-meta' }, part.reason) : null,
      actions,
      state
    ]);
    part.node = node;
    part.actions = actions;
    part.state = state;
    paintApproval(part);
    return node;
  }

  function paintApproval(part) {
    if (!part.node) return;
    var decided = !!part.decision;
    part.node.setAttribute('data-decision', part.decision || '');
    if (part.actions) part.actions.hidden = decided;
    if (part.state) {
      part.state.textContent = decided
        ? (part.decision === 'approve' ? 'approved by the operator'
          : part.decision === 'deny' ? 'denied by the operator'
            : part.decision === 'timeout' ? 'no answer — denied' : part.decision)
        : 'waiting for your decision · unanswered approves nothing';
    }
  }

  // Per-answer actions and the metadata that says which model produced it, how long it
  // took and what it cost in tokens. All three come from the server (the `done` frame,
  // persisted on the assistant transcript entry), never from what the page guesses.
  function actionsRow(t) {
    var row = el('div', { class: 'chat-actions' });
    var copy = el('button', { type: 'button', class: 'chat-action', title: 'Copy the answer' }, 'copy');
    copy.addEventListener('click', function () {
      var body = assistantText(t);
      if (!body) return;
      var done = function () { copy.textContent = 'copied'; setTimeout(function () { copy.textContent = 'copy'; }, 1200); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(body).then(done, done);
      else done();
    });
    row.appendChild(copy);
    // Regenerate applies to the latest answer only; the view decides which one that is.
    if (HOOKS.canRegenerate(t)) {
      var regen = el('button', {
        type: 'button', class: 'chat-action', 'data-needs-idle': '1',
        title: 'Run this question again, replacing this answer'
      }, 'regenerate');
      regen.addEventListener('click', function () { HOOKS.onRegenerate(t); });
      t.regenBtn = regen;
      row.appendChild(regen);
    }
    var bits = [];
    var meta = t.meta || {};
    if (meta.model) bits.push(meta.model);
    if (meta.durationMs != null) bits.push((meta.durationMs / 1000).toFixed(1) + ' s');
    if (meta.tokensOut != null) bits.push(meta.tokensOut + ' tok');
    if (bits.length) row.appendChild(el('span', { class: 'chat-meta' }, bits.join(' · ')));
    return row;
  }

  // Only the newest answer keeps a regenerate control: after the next turn it would
  // rewrite history that is no longer at the end.
  function pruneRegen(keep, turns) {
    (turns || []).forEach(function (t) {
      if (t === keep || !t.regenBtn) return;
      if (t.regenBtn.parentNode) t.regenBtn.parentNode.removeChild(t.regenBtn);
      t.regenBtn = null;
    });
  }

  window.ChatRender = {
    init: init,
    markdown: markdown,
    assistantText: assistantText,
    turn: turn,
    text: text,
    tool: tool,
    thinking: thinking,
    approval: approval,
    paintTool: paintTool,
    paintApproval: paintApproval,
    actionsRow: actionsRow,
    pruneRegen: pruneRegen
  };
})();
