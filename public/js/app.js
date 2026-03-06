(function () {
  'use strict';

  // ----------------------------------------------------------------
  // Card rendering
  // ----------------------------------------------------------------

  function posterUrl(thumb) {
    if (!thumb) return null;
    return '/api/poster?path=' + encodeURIComponent(thumb);
  }

  function renderCard(item) {
    const card = document.createElement('div');
    card.className = 'card';
    card.dataset.ratingKey = item.ratingKey;

    // --- Poster link (opens Plex deep link) ---
    const posterLink = document.createElement('a');
    posterLink.className = 'card-poster-link';
    // Deep link is constructed server-side via the item's ratingKey —
    // we build it client-side using the publicly safe Plex web URL pattern.
    posterLink.href = item.deepLink || '#';
    posterLink.target = '_blank';
    posterLink.rel = 'noopener noreferrer';
    posterLink.title = item.title;

    if (item.thumb) {
      const img = document.createElement('img');
      img.className = 'card-poster';
      img.src = posterUrl(item.thumb);
      img.alt = item.title;
      img.loading = 'lazy';
      img.onerror = function () {
        this.parentNode.replaceChild(makePlaceholder(item.title), this);
      };
      posterLink.appendChild(img);
    } else {
      posterLink.appendChild(makePlaceholder(item.title));
    }

    // --- Overlay with action buttons ---
    const overlay = document.createElement('div');
    overlay.className = 'card-overlay';

    const actions = document.createElement('div');
    actions.className = 'card-overlay-actions';

    // Watchlist button
    const wlBtn = document.createElement('button');
    wlBtn.className = 'btn-icon btn-watchlist' + (item.isInWatchlist ? ' in-watchlist' : '');
    wlBtn.textContent = item.isInWatchlist ? '✓ In Watchlist' : '+ Watchlist';
    wlBtn.title = item.isInWatchlist ? 'Remove from Watchlist' : 'Add to Diskovarr Watchlist';
    wlBtn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      window.Watchlist.toggle(wlBtn, item);
    });

    // Dismiss button
    const dismissBtn = document.createElement('button');
    dismissBtn.className = 'btn-icon btn-dismiss';
    dismissBtn.textContent = '✕';
    dismissBtn.title = "Don't show this again";
    dismissBtn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      handleDismiss(card, item.ratingKey);
    });

    actions.appendChild(wlBtn);
    actions.appendChild(dismissBtn);
    overlay.appendChild(actions);
    posterLink.appendChild(overlay);
    card.appendChild(posterLink);

    // --- Card info ---
    const info = document.createElement('div');
    info.className = 'card-info';

    const title = document.createElement('div');
    title.className = 'card-title';
    title.textContent = item.title;
    info.appendChild(title);

    const meta = document.createElement('div');
    meta.className = 'card-meta';
    if (item.year) {
      const year = document.createElement('span');
      year.className = 'card-year';
      year.textContent = item.year;
      meta.appendChild(year);
    }
    if (item.audienceRating && item.audienceRating > 0) {
      const rating = document.createElement('span');
      rating.className = 'card-rating';
      rating.textContent = '★ ' + item.audienceRating.toFixed(1);
      meta.appendChild(rating);
    }
    info.appendChild(meta);

    if (item.reasons && item.reasons.length > 0) {
      const reasons = document.createElement('div');
      reasons.className = 'card-reasons';
      item.reasons.slice(0, 2).forEach(r => {
        const tag = document.createElement('span');
        tag.className = 'reason-tag';
        tag.textContent = r;
        reasons.appendChild(tag);
      });
      info.appendChild(reasons);
    }

    card.appendChild(info);
    return card;
  }

  function makePlaceholder(title) {
    const el = document.createElement('div');
    el.className = 'card-poster-placeholder';
    el.innerHTML = '🎬<span>' + escHtml(title) + '</span>';
    return el;
  }

  function escHtml(str) {
    const d = document.createElement('div');
    d.appendChild(document.createTextNode(str));
    return d.innerHTML;
  }

  // ----------------------------------------------------------------
  // Dismiss
  // ----------------------------------------------------------------

  function handleDismiss(cardEl, ratingKey) {
    cardEl.classList.add('card-dismissing');
    fetch('/api/dismiss', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ratingKey }),
    })
      .then(r => r.json())
      .then(() => {
        setTimeout(() => {
          cardEl.remove();
        }, 300);
      })
      .catch(err => {
        console.error('Dismiss error:', err);
        cardEl.classList.remove('card-dismissing');
      });
  }

  // ----------------------------------------------------------------
  // Render section
  // ----------------------------------------------------------------

  function renderSection(gridId, items) {
    const grid = document.getElementById(gridId);
    if (!grid) return;

    // Clear skeleton
    grid.innerHTML = '';
    grid.classList.remove('skeleton-grid');

    if (!items || items.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = 'No recommendations found yet. Watch some content and check back!';
      grid.appendChild(empty);
      return;
    }

    const fragment = document.createDocumentFragment();
    items.forEach(item => fragment.appendChild(renderCard(item)));
    grid.appendChild(fragment);
  }

  // Expose renderCard globally for discover.js
  window.renderCard = renderCard;

  // ----------------------------------------------------------------
  // Bootstrap
  // ----------------------------------------------------------------

  document.addEventListener('DOMContentLoaded', function () {
    fetch('/api/recommendations')
      .then(r => {
        if (!r.ok) {
          if (r.status === 401) {
            window.location.href = '/login';
            return;
          }
          throw new Error('HTTP ' + r.status);
        }
        return r.json();
      })
      .then(data => {
        if (!data) return;
        renderSection('grid-top-picks', data.topPicks);
        renderSection('grid-movies', data.movies);
        renderSection('grid-tv', data.tvShows);
        renderSection('grid-anime', data.anime);
      })
      .catch(err => {
        console.error('Failed to load recommendations:', err);
        ['grid-top-picks', 'grid-movies', 'grid-tv', 'grid-anime'].forEach(id => {
          const grid = document.getElementById(id);
          if (grid) {
            grid.innerHTML = '<div class="empty-state">Failed to load recommendations. Please refresh.</div>';
          }
        });
      });
  });
})();
