/**
 * Watchlist helpers — used by app.js card rendering
 */
window.Watchlist = (function () {

  // ── Toast notification ────────────────────────────────────────────
  let toastTimeout = null;

  function showToast(message, type) {
    let toast = document.getElementById('wl-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'wl-toast';
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.className = 'wl-toast wl-toast-' + (type || 'add') + ' wl-toast-show';
    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => toast.classList.remove('wl-toast-show'), 3000);
  }

  async function add(ratingKey) {
    const res = await fetch('/api/watchlist/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ratingKey }),
    });
    if (!res.ok) throw new Error('Failed to add to watchlist');
    return res.json();
  }

  async function remove(playlistId, playlistItemId) {
    const res = await fetch('/api/watchlist/remove', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playlistId, playlistItemId }),
    });
    if (!res.ok) throw new Error('Failed to remove from watchlist');
    return res.json();
  }

  /**
   * Toggle watchlist status for a card.
   * btn: the watchlist button element
   * item: the recommendation item object
   * After add, re-fetches watchlist to get the playlistItemId.
   */
  async function toggle(btn, item) {
    btn.disabled = true;
    try {
      if (item.isInWatchlist) {
        await remove(item.watchlistPlaylistId, item.watchlistItemId);
        item.isInWatchlist = false;
        item.watchlistItemId = null;
        btn.classList.remove('in-watchlist');
        btn.textContent = '+ Watchlist';
        btn.title = 'Add to Diskovarr Watchlist';
      } else {
        await add(item.ratingKey);
        // Re-fetch watchlist to get playlistItemId for future removes
        const wl = await fetch('/api/watchlist').then(r => r.json());
        const match = wl.items.find(i => i.ratingKey === item.ratingKey);
        if (match) {
          item.watchlistItemId = match.playlistItemId;
          item.watchlistPlaylistId = wl.playlistId;
        }
        item.isInWatchlist = true;
        btn.classList.add('in-watchlist');
        btn.textContent = '✓ In Watchlist';
        btn.title = 'Remove from Diskovarr Watchlist';
        showToast('Added to your Diskovarr playlist ◈', 'add');
      }
    } catch (err) {
      console.error('Watchlist toggle error:', err);
      showToast('Something went wrong. Try again.', 'error');
    } finally {
      btn.disabled = false;
    }
  }

  return { add, remove, toggle };
})();
