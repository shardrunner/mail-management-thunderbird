// Action popup: suggests a folder for one message and moves it on Enter. Closing the
// popup unloads the page, which also drops a pending provider request.
import { targetMessageId, loadMessage, eligibleFolders, suggestFolder, orderedFolders, moveMessage, OUTCOMES } from './core.js';

export async function startPopup(api, doc) {
  const $ = id => doc.getElementById(id);
  let message = null, rows = [], suggested = null, busy = false;

  const show = (status, error = '') => {
    $('status').textContent = status;
    $('error').textContent = error;
  };

  // Keeps the chosen folder while it stays listed; otherwise the top filter match,
  // or the suggestion when there is no filter.
  const render = () => {
    const current = $('folders').value;
    const listed = orderedFolders(rows, suggested, $('search').value);
    $('folders').replaceChildren(...listed.map(row => {
      const option = doc.createElement('option');
      const badges = [row.label === suggested && 'Suggested', row.isFavorite && 'Favorite', row.recentIndex != null && 'Recent'].filter(Boolean);
      option.value = row.label;
      option.textContent = badges.length ? `${badges.join(' · ')}: ${row.label}` : row.label;
      return option;
    }));
    const keep = current && listed.some(row => row.label === current);
    $('folders').value = keep ? current : ($('search').value ? listed[0]?.label : suggested) ?? '';
    $('search').disabled = $('folders').disabled = busy;
    $('move').disabled = busy || !$('folders').value;
  };

  // One attempt per popup; only an API error before the outcome allows another.
  const move = async () => {
    const target = rows.find(row => row.label === $('folders').value);
    if (busy || !target) return;
    busy = true;
    show('Moving…');
    render();
    try {
      const outcome = await moveMessage(api, message, target);
      if (outcome === 'confirmed') return doc.defaultView.close();
      show(OUTCOMES[outcome]);
    } catch (error) {
      busy = false;
      show('', error.message);
      render();
    }
  };

  const step = delta => {
    const options = [...$('folders').children];
    if (!options.length) return;
    const index = options.findIndex(option => option.value === $('folders').value);
    const next = index < 0 ? (delta > 0 ? 0 : options.length - 1) : Math.min(Math.max(index + delta, 0), options.length - 1);
    $('folders').value = options[next].value;
    render();
  };

  $('search').addEventListener('input', render);
  $('search').addEventListener('keydown', event => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    step(event.key === 'ArrowDown' ? 1 : -1);
  });
  $('folders').addEventListener('change', render);
  $('move').addEventListener('click', move);
  $('settings').addEventListener('click', () => api.runtime.openOptionsPage());
  doc.addEventListener('keydown', event => {
    if (event.key !== 'Enter' || event.target === $('settings') || event.target === $('move')) return;
    event.preventDefault();
    move();
  });

  try {
    message = await loadMessage(api, await targetMessageId(api));
    rows = await eligibleFolders(api, message.folder);
    if (!rows.length) throw new Error('No eligible destination folders in this account.');
    show('Suggesting folder…');
    render();
    const suggestion = await suggestFolder(api, message, rows);
    suggested = suggestion.label;
    if (!busy) show(suggestion.rationale ? `Suggested: ${suggestion.label} — ${suggestion.rationale}` : `Suggested: ${suggestion.label}`);
    render();
  } catch (error) {
    // No automatic Settings tab here: it would take focus and close the popup, and
    // filing manually must keep working without a key.
    if (!busy) show('', error.message);
    render();
  }
}

if (globalThis.document?.getElementById('folders')) startPopup(browser, document);
