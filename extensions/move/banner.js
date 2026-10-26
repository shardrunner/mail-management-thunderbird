// Self-contained: scripting.executeScript serializes this function into the message reading pane.
export function moveBannerOperation(payload) {
  try {
    const existing = document.getElementById?.('move-suggest-banner');
    if (payload?.state === 'clear') {
      existing?.remove();
      if (document.body) document.body.style.paddingTop = '';
      return { ok: true };
    }
    if (!document.documentElement) throw new Error('Message view is unavailable.');

    const renderList = (root, host) => {
      const $ = id => root.querySelector(`#${id}`);
      const rows = JSON.parse(host.dataset.rows || '[]');
      const suggested = host.dataset.suggested || null;
      const query = ($('search').value ?? '').toLocaleLowerCase();
      const filtered = rows
        .filter(row => row.label.toLocaleLowerCase().includes(query))
        .toSorted((a, b) => (b.label === suggested) - (a.label === suggested)
          || !!b.isFavorite - !!a.isFavorite
          || (a.recentIndex ?? Infinity) - (b.recentIndex ?? Infinity)
          || a.label.localeCompare(b.label));
      const current = $('folders').value;
      $('folders').replaceChildren(...filtered.map(row => {
        const option = document.createElement('option');
        option.value = row.label;
        const badges = [
          row.label === suggested && 'Suggested',
          row.isFavorite && 'Favorite',
          row.recentIndex != null && 'Recent',
        ].filter(Boolean);
        option.textContent = badges.length ? `${badges.join(' · ')}: ${row.label}` : row.label;
        return option;
      }));
      if (filtered.some(row => row.label === current)) {
        $('folders').value = current;
      } else if ($('search').value && filtered.length) {
        $('folders').value = filtered[0].label;
      } else {
        $('folders').value = '';
      }
      const locked = host.dataset.locked === '1' || !rows.length;
      $('controls').hidden = !rows.length;
      $('search').disabled = locked;
      $('folders').disabled = locked;
      $('move').disabled = locked || !$('folders').value;
    };

    let host = existing;
    if (!host || host.dataset?.messageId !== String(payload.messageId ?? '')) {
      existing?.remove();
      host = document.createElement('div');
      host.id = 'move-suggest-banner';
      host.dataset.messageId = String(payload.messageId ?? '');
      const root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
      root.innerHTML = `<style>
        .bar { position: fixed; top: 0; left: 0; right: 0; z-index: 2147483647; display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 6px 10px; font: 13px/1.35 system-ui, sans-serif; background: #1e293b; color: #f8fafc; border-bottom: 2px solid #475569; box-shadow: 0 2px 8px rgba(0,0,0,.25); }
        .bar.error { background: #3b1212; border-bottom-color: #ef4444; }
        .msg { font-weight: 600; margin-right: 4px; overflow-wrap: anywhere; }
        .controls { display: flex; flex: 1; min-width: 240px; align-items: center; gap: 6px; }
        input, select, button { font: inherit; border-radius: 4px; border: 1px solid rgba(255,255,255,.3); background: #0f172a; color: #f8fafc; padding: 3px 7px; }
        input { width: 150px; }
        select { flex: 1; min-width: 140px; }
        button { background: #2563eb; border-color: #3b82f6; cursor: pointer; white-space: nowrap; }
        button.secondary { background: rgba(255,255,255,.1); border-color: rgba(255,255,255,.3); }
        button:disabled, input:disabled, select:disabled { opacity: .55; cursor: not-allowed; }
        [ hidden ] { display: none !important; }
      </style>
      <div id="bar" class="bar" role="region" aria-label="Move Suggest">
        <span id="status" class="msg" role="status"></span>
        <span id="error" class="msg" role="alert"></span>
        <div id="controls" class="controls">
          <input id="search" type="search" placeholder="Filter folders…" autocomplete="off">
          <select id="folders" aria-label="Destination folder"></select>
          <button id="move" type="button" disabled>Move (Enter)</button>
        </div>
        <button id="settings" class="secondary" type="button">Settings</button>
        <button id="close" class="secondary" type="button" title="Close (Esc)">×</button>
      </div>`;

      const $ = id => root.querySelector(`#${id}`);
      const send = message => globalThis.browser?.runtime?.sendMessage?.(message);

      const triggerMove = async () => {
        if ($('move').disabled) return;
        const folderLabel = $('folders').value;
        const rows = JSON.parse(host.dataset.rows || '[]');
        const folderId = rows.find(r => r.label === folderLabel)?.id ?? '';
        host.dataset.locked = '1';
        $('bar').className = 'bar';
        $('error').textContent = '';
        $('status').textContent = 'Moving…';
        renderList(root, host);
        try {
          const res = await send({
            type: 'move-confirm',
            messageId: Number(host.dataset.messageId),
            folderId,
            folderLabel,
          });
          if (res?.outcome === 'confirmed') {
            host.remove();
            if (document.body) document.body.style.paddingTop = '';
            return;
          }
          if (res?.error) {
            host.dataset.locked = '';
            $('bar').className = 'bar error';
            $('status').textContent = '';
            $('error').textContent = res.error;
            renderList(root, host);
          } else if (res?.status) {
            $('status').textContent = res.status;
          }
        } catch (err) {
          host.dataset.locked = '';
          $('bar').className = 'bar error';
          $('status').textContent = '';
          $('error').textContent = `Move Suggest: ${err?.message || 'Move failed.'}`;
          renderList(root, host);
        }
      };

      $('search').addEventListener('input', () => {
        host.dataset.manual = '1';
        renderList(root, host);
      });

      $('search').addEventListener('keydown', event => {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
        const options = $('folders').children;
        if (!options.length) return;
        event.preventDefault();
        host.dataset.manual = '1';
        const current = Array.from(options).findIndex(o => o.value === $('folders').value);
        const next = event.key === 'ArrowDown'
          ? (current < 0 ? 0 : Math.min(current + 1, options.length - 1))
          : (current < 0 ? options.length - 1 : Math.max(current - 1, 0));
        $('folders').value = options[next].value;
        renderList(root, host);
      });

      $('folders').addEventListener('change', () => {
        host.dataset.manual = '1';
        renderList(root, host);
      });

      $('move').addEventListener('click', triggerMove);
      $('settings').addEventListener('click', () => send({ type: 'move-open-options' }));
      $('close').addEventListener('click', () => {
        host.remove();
        if (document.body) document.body.style.paddingTop = '';
        send({ type: 'move-cancel', messageId: Number(host.dataset.messageId) });
      });

      host.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
          event.preventDefault();
          $('close').click();
        } else if (event.key === 'Enter' && event.target !== $('settings') && event.target !== $('close') && !$('move').disabled) {
          event.preventDefault();
          triggerMove();
        }
      });

      document.documentElement.appendChild(host);
      if (document.body) document.body.style.paddingTop = '44px';
    }

    const root = host.shadowRoot ?? host;
    const $ = id => root.querySelector(`#${id}`);
    if (payload.rows) host.dataset.rows = JSON.stringify(payload.rows);
    if (payload.suggestion !== undefined) host.dataset.suggested = payload.suggestion?.label ?? '';
    host.dataset.locked = (payload.state === 'moving' || payload.state === 'done') ? '1' : '';
    $('bar').className = payload.error ? 'bar error' : 'bar';
    $('status').textContent = payload.status ?? '';
    $('error').textContent = payload.error ?? '';
    renderList(root, host);
    if (payload.suggestion?.label && !host.dataset.manual) {
      $('folders').value = payload.suggestion.label;
      renderList(root, host);
    }
    if (payload.state === 'loading' || payload.state === 'ready') {
      globalThis.window?.focus?.();
      $('search')?.focus?.();
    }
    return { ok: true, selected: $('folders').value, status: $('status').textContent, error: $('error').textContent };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}
