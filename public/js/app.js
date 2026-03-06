(function () {
  'use strict';

  // ----------------------------------------------------------------
  // Card rendering
  // ----------------------------------------------------------------

  function posterUrl(thumb) {
    if (!thumb) return null;
    return '/api/poster?path=' + encodeURIComponent(thumb);
  }

  // ----------------------------------------------------------------
  // Detail modal
  // ----------------------------------------------------------------

  let modalEl = null;

  function ensureModal() {
    if (modalEl) return;
    modalEl = document.createElement('div');
    modalEl.className = 'modal-backdrop';
    modalEl.innerHTML = `
      <div class="modal-card" role="dialog" aria-modal="true">
        <button class="modal-close" id="modal-close" aria-label="Close">✕</button>
        <div class="modal-body">
          <div class="modal-poster-wrap">
            <img class="modal-poster" id="modal-poster" src="" alt="">
            <div class="modal-poster-placeholder" id="modal-poster-ph" style="display:none">🎬</div>
          </div>
          <div class="modal-info">
            <h2 class="modal-title" id="modal-title"></h2>
            <div class="modal-meta" id="modal-meta"></div>
            <div class="modal-ratings" id="modal-ratings"></div>
            <div class="modal-genres" id="modal-genres"></div>
            <p class="modal-summary" id="modal-summary"></p>
            <div class="modal-credits" id="modal-credits"></div>
            <div class="modal-actions" id="modal-actions"></div>
          </div>
        </div>
      </div>`;
    document.body.appendChild(modalEl);
    document.getElementById('modal-close').addEventListener('click', closeModal);
    modalEl.addEventListener('click', function (e) {
      if (e.target === modalEl) closeModal();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeModal();
    });
  }

  function closeModal() {
    if (!modalEl) return;
    modalEl.classList.remove('open');
    document.body.style.overflow = '';
  }

  function openModal(item) {
    ensureModal();

    // Poster
    const posterImg = document.getElementById('modal-poster');
    const posterPh = document.getElementById('modal-poster-ph');
    if (item.thumb) {
      posterImg.src = posterUrl(item.thumb);
      posterImg.alt = item.title;
      posterImg.style.display = '';
      posterPh.style.display = 'none';
      posterImg.onerror = function () {
        this.style.display = 'none';
        posterPh.style.display = 'flex';
      };
    } else {
      posterImg.style.display = 'none';
      posterPh.style.display = 'flex';
    }

    // Title
    document.getElementById('modal-title').textContent = item.title;

    // Meta row: year · type · content rating
    const metaParts = [];
    if (item.year) metaParts.push(item.year);
    if (item.type) metaParts.push(item.type === 'movie' ? 'Movie' : 'TV Show');
    if (item.contentRating) metaParts.push(item.contentRating);
    document.getElementById('modal-meta').textContent = metaParts.join(' · ');

    // Ratings
    const ratingsEl = document.getElementById('modal-ratings');
    ratingsEl.innerHTML = '';
    const criticScore = item.rating ? Math.round(item.rating * 10) : null;
    const audienceScore = item.audienceRating ? Math.round(item.audienceRating * 10) : null;
    const isFresh = item.ratingImage && item.ratingImage.includes('.ripe');
    const isUpright = item.audienceRatingImage && item.audienceRatingImage.includes('.upright');
    const isRT = item.ratingImage && item.ratingImage.includes('rottentomatoes');

    if (criticScore || audienceScore) {
      if (criticScore && isRT) {
        const b = document.createElement('div');
        b.className = 'rating-badge rating-critic' + (isFresh ? ' fresh' : ' rotten');
        b.innerHTML = '<span class="rating-icon">' + (isFresh ? '🍅' : '🍅') + '</span>'
          + '<span class="rating-label">Tomatometer</span>'
          + '<span class="rating-score">' + criticScore + '%</span>';
        ratingsEl.appendChild(b);
      }
      if (audienceScore) {
        const b = document.createElement('div');
        b.className = 'rating-badge rating-audience' + (isUpright ? ' upright' : ' spilled');
        b.innerHTML = '<span class="rating-icon">🍿</span>'
          + '<span class="rating-label">Audience</span>'
          + '<span class="rating-score">' + audienceScore + '%</span>';
        ratingsEl.appendChild(b);
      }
    }

    // Genres
    const genresEl = document.getElementById('modal-genres');
    genresEl.innerHTML = '';
    (item.genres || []).forEach(function (g) {
      const chip = document.createElement('span');
      chip.className = 'modal-genre-chip';
      chip.textContent = g;
      genresEl.appendChild(chip);
    });

    // Summary
    document.getElementById('modal-summary').textContent = item.summary || '';

    // Credits
    const creditsEl = document.getElementById('modal-credits');
    creditsEl.innerHTML = '';
    if (item.directors && item.directors.length) {
      const d = document.createElement('div');
      d.className = 'modal-credit-row';
      d.innerHTML = '<span class="modal-credit-label">Director</span> '
        + escHtml(item.directors.join(', '));
      creditsEl.appendChild(d);
    }
    if (item.cast && item.cast.length) {
      const c = document.createElement('div');
      c.className = 'modal-credit-row';
      c.innerHTML = '<span class="modal-credit-label">Cast</span> '
        + escHtml(item.cast.slice(0, 6).join(', '));
      creditsEl.appendChild(c);
    }

    // Actions
    const actionsEl = document.getElementById('modal-actions');
    actionsEl.innerHTML = '';

    const wlBtn = document.createElement('button');
    wlBtn.className = 'modal-btn modal-btn-watchlist' + (item.isInWatchlist ? ' in-watchlist' : '');
    wlBtn.textContent = item.isInWatchlist ? '✓ In Watchlist' : '+ Watchlist';
    wlBtn.addEventListener('click', function () {
      window.Watchlist.toggle(wlBtn, item);
      // Sync state back to card in the grid
      const card = document.querySelector('[data-rating-key="' + item.ratingKey + '"]');
      if (card) {
        const cardWlBtn = card.querySelector('.btn-watchlist');
        if (cardWlBtn) {
          cardWlBtn.className = 'btn-icon btn-watchlist' + (item.isInWatchlist ? ' in-watchlist' : '');
          cardWlBtn.textContent = item.isInWatchlist ? '✓ In Watchlist' : '+ Watchlist';
        }
      }
    });
    actionsEl.appendChild(wlBtn);

    const dismissBtn = document.createElement('button');
    dismissBtn.className = 'modal-btn modal-btn-dismiss';
    dismissBtn.textContent = '✕ Not Interested';
    dismissBtn.addEventListener('click', function () {
      const card = document.querySelector('[data-rating-key="' + item.ratingKey + '"]');
      if (card) handleDismiss(card, item.ratingKey);
      closeModal();
    });
    actionsEl.appendChild(dismissBtn);

    modalEl.classList.add('open');
    document.body.style.overflow = 'hidden';
  }

  window.openModal = openModal;

  // ----------------------------------------------------------------
  // Card rendering
  // ----------------------------------------------------------------

  function renderCard(item) {
    const card = document.createElement('div');
    card.className = 'card';
    card.dataset.ratingKey = item.ratingKey;

    // --- Poster (opens detail modal on click) ---
    const posterLink = document.createElement('button');
    posterLink.className = 'card-poster-link';
    posterLink.type = 'button';
    posterLink.title = item.title;
    posterLink.addEventListener('click', function () {
      openModal(item);
    });

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
      e.stopPropagation();
      window.Watchlist.toggle(wlBtn, item);
    });

    // Dismiss button
    const dismissBtn = document.createElement('button');
    dismissBtn.className = 'btn-icon btn-dismiss';
    dismissBtn.textContent = '✕';
    dismissBtn.title = "Don't show this again";
    dismissBtn.addEventListener('click', function (e) {
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
