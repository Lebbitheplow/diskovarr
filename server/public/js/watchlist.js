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

  async function remove(ratingKey) {
    const res = await fetch('/api/watchlist/remove', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ratingKey }),
    });
    if (!res.ok) throw new Error('Failed to remove from watchlist');
    return res.json();
  }

  // ── Mobile confirm popup ──────────────────────────────────────────
  function mobileConfirm(title, onConfirm, onCancel, opts) {
    var heading = (opts && opts.heading) || 'Add to Watchlist?';
    var confirmLabel = (opts && opts.confirmLabel) || 'Add';
    var existing = document.getElementById('wl-confirm');
    if (existing) existing.remove();

    var popup = document.createElement('div');
    popup.id = 'wl-confirm';
    popup.className = 'wl-confirm';
    popup.innerHTML =
      '<div class="wl-confirm-box">' +
        '<p class="wl-confirm-title">' + heading + '</p>' +
        '<p class="wl-confirm-name">' + title + '</p>' +
        '<div class="wl-confirm-btns">' +
          '<button class="wl-confirm-cancel">Cancel</button>' +
          '<button class="wl-confirm-ok">' + confirmLabel + '</button>' +
        '</div>' +
      '</div>';

    document.body.appendChild(popup);

    function close() { popup.remove(); }

    popup.querySelector('.wl-confirm-ok').addEventListener('click', function () {
      close(); onConfirm();
    });
    popup.querySelector('.wl-confirm-cancel').addEventListener('click', function () {
      close(); onCancel();
    });
    popup.addEventListener('click', function (e) {
      if (e.target === popup) { close(); onCancel(); }
    });
  }

  var isTouchDevice = window.matchMedia('(pointer: coarse)').matches;

  /**
   * Toggle watchlist status for a card.
   * btn: the watchlist button element
   * item: the recommendation item object
   */
  async function toggle(btn, item) {
    // On mobile, confirm before adding (not needed for removing)
    if (isTouchDevice && !item.isInWatchlist) {
      btn.disabled = true;
      mobileConfirm(
        item.title || 'this title',
        function () { doToggle(btn, item); },
        function () { btn.disabled = false; }
      );
      return;
    }
    doToggle(btn, item);
  }

  async function doToggle(btn, item) {
    btn.disabled = true;
    try {
      if (item.isInWatchlist) {
        await remove(item.ratingKey);
        item.isInWatchlist = false;
        btn.classList.remove('in-watchlist');
        btn.textContent = '+ Watchlist';
        btn.title = 'Add to Watchlist';
      } else {
        await add(item.ratingKey);
        item.isInWatchlist = true;
        btn.classList.add('in-watchlist');
        btn.textContent = '✓ In Watchlist';
        btn.title = 'Remove from Watchlist';
        showToast('Added to Watchlist ◈', 'add');
      }
    } catch (err) {
      console.error('Watchlist toggle error:', err);
      showToast('Something went wrong. Try again.', 'error');
    } finally {
      btn.disabled = false;
    }
  }

  return { add, remove, toggle, doToggle, mobileConfirm, isTouchDevice: function() { return isTouchDevice; } };
})();
