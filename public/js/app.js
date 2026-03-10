(function () {
  'use strict';

  // ----------------------------------------------------------------
  // Helpers
  // ----------------------------------------------------------------

  function makeReasonTag(text) {
    var tag = document.createElement('span');
    tag.className = 'reason-tag';
    var inner = document.createElement('span');
    inner.className = 'reason-tag-text';
    inner.textContent = text;
    tag.appendChild(inner);
    setTimeout(function () {
      var cs = getComputedStyle(tag);
      var tagExtra = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) +
                     parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth);
      var overflow = inner.getBoundingClientRect().width - (tag.getBoundingClientRect().width - tagExtra);
      if (overflow > 1) {
        var dist = Math.ceil(overflow) + 6;
        var dur = Math.max(3, (dist / 40 + 2)).toFixed(1) + 's';
        tag.style.setProperty('--tag-scroll-dist', '-' + dist + 'px');
        tag.style.setProperty('--tag-scroll-duration', dur);
        tag.classList.add('reason-tag-scroll');
      }
    }, 50);
    return tag;
  }

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
    modalEl.className = 'detail-modal-wrap';
    modalEl.setAttribute('aria-hidden', 'true');
    modalEl.innerHTML = `
      <div class="detail-modal-card" role="dialog" aria-modal="true">
        <button class="detail-modal-close" id="lib-modal-close" aria-label="Close">✕</button>
        <div class="detail-modal-hero" id="lib-modal-hero"></div>
        <div class="detail-modal-body" id="lib-modal-body">
          <img class="detail-modal-poster" id="lib-modal-poster" src="" alt="">
          <div class="detail-modal-info" id="lib-modal-info">
            <div class="detail-modal-title" id="lib-modal-title"></div>
            <div class="detail-modal-meta" id="lib-modal-meta"></div>
            <div id="lib-modal-ratings"></div>
            <div class="detail-modal-reasons" id="lib-modal-reasons"></div>
            <div class="detail-modal-genres" id="lib-modal-genres"></div>
            <p class="detail-modal-overview" id="lib-modal-overview"></p>
            <div class="detail-modal-credits" id="lib-modal-credits"></div>
            <div class="detail-modal-actions" id="lib-modal-actions"></div>
          </div>
        </div>
        <div class="detail-modal-trailer" id="lib-modal-trailer"></div>
      </div>`;
    document.body.appendChild(modalEl);
    document.getElementById('lib-modal-close').addEventListener('click', closeModal);
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
    modalEl.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
    const t = document.getElementById('lib-modal-trailer');
    if (t) { t.innerHTML = ''; t.classList.remove('active'); }
  }

  function openModal(item) {
    ensureModal();

    // Hero backdrop — use art (backdrop) if available, fallback to thumb
    const heroEl = document.getElementById('lib-modal-hero');
    const bodyEl = document.getElementById('lib-modal-body');
    const infoEl = document.getElementById('lib-modal-info');
    const bgPath = item.art || item.thumb;
    if (heroEl) {
      if (bgPath) {
        heroEl.style.backgroundImage = 'url(' + posterUrl(bgPath) + ')';
        heroEl.style.display = '';
        if (bodyEl) { bodyEl.style.marginTop = ''; bodyEl.style.paddingTop = ''; }
        if (infoEl) infoEl.style.paddingTop = '';
      } else {
        heroEl.style.display = 'none';
        if (bodyEl) { bodyEl.style.marginTop = '0'; bodyEl.style.paddingTop = '22px'; }
        if (infoEl) infoEl.style.paddingTop = '0';
      }
    }

    // Poster
    const posterEl = document.getElementById('lib-modal-poster');
    if (posterEl) {
      if (item.thumb) {
        posterEl.src = posterUrl(item.thumb);
        posterEl.alt = item.title;
        posterEl.style.display = '';
        posterEl.onerror = function () { this.style.display = 'none'; };
      } else {
        posterEl.style.display = 'none';
      }
    }

    // Title
    document.getElementById('lib-modal-title').textContent = item.title;

    // Meta row: year · type · content rating
    const metaParts = [];
    if (item.year) metaParts.push(item.year);
    if (item.type) metaParts.push(item.type === 'movie' ? 'Movie' : 'TV Show');
    const metaEl = document.getElementById('lib-modal-meta');
    metaEl.textContent = metaParts.join(' · ');
    if (item.contentRating) {
      const badge = document.createElement('span');
      badge.className = 'content-rating-badge rating-' + item.contentRating.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
      badge.textContent = item.contentRating;
      metaEl.appendChild(document.createTextNode(' · '));
      metaEl.appendChild(badge);
    }

    // Ratings (RT badges)
    const ratingsEl = document.getElementById('lib-modal-ratings');
    ratingsEl.innerHTML = '';
    const criticScore = item.rating ? Math.round(item.rating * 10) : null;
    const audienceScore = item.audienceRating ? Math.round(item.audienceRating * 10) : null;
    const isFresh = item.ratingImage && item.ratingImage.includes('.ripe');
    const isUpright = item.audienceRatingImage && item.audienceRatingImage.includes('.upright');
    const isRT = item.ratingImage && item.ratingImage.includes('rottentomatoes');
    if (criticScore || audienceScore) {
      ratingsEl.style.display = 'flex';
      ratingsEl.style.gap = '8px';
      ratingsEl.style.flexWrap = 'wrap';
      ratingsEl.style.marginBottom = '8px';
      if (criticScore && isRT) {
        const b = document.createElement('div');
        b.className = 'rating-badge rating-critic' + (isFresh ? ' fresh' : ' rotten');
        b.innerHTML = '<span class="rating-icon">🍅</span>'
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
    } else {
      ratingsEl.style.display = 'none';
    }

    // Reason tags
    const reasonsEl = document.getElementById('lib-modal-reasons');
    reasonsEl.innerHTML = '';
    (item.reasons || []).forEach(function (r) {
      reasonsEl.appendChild(makeReasonTag(r));
    });

    // Genre chips
    const genresEl = document.getElementById('lib-modal-genres');
    genresEl.innerHTML = '';
    (item.genres || []).slice(0, 5).forEach(function (g) {
      const chip = document.createElement('span');
      chip.className = 'genre-tag';
      chip.textContent = g;
      genresEl.appendChild(chip);
    });

    // Overview / Summary
    document.getElementById('lib-modal-overview').textContent = item.summary || '';

    // Credits
    const creditsEl = document.getElementById('lib-modal-credits');
    creditsEl.innerHTML = '';
    if (item.directors && item.directors.length) {
      const d = document.createElement('div');
      d.className = 'detail-credit-row';
      d.innerHTML = '<span class="detail-credit-label">Director:</span> ' + escHtml(item.directors.join(', '));
      creditsEl.appendChild(d);
    }
    if (item.cast && item.cast.length) {
      const c = document.createElement('div');
      c.className = 'detail-credit-row';
      c.innerHTML = '<span class="detail-credit-label">Cast:</span> ' + escHtml(item.cast.slice(0, 6).join(', '));
      creditsEl.appendChild(c);
    }
    if (item.studio) {
      const s = document.createElement('div');
      s.className = 'detail-credit-row';
      s.innerHTML = '<span class="detail-credit-label">Studio:</span> ' + escHtml(item.studio);
      creditsEl.appendChild(s);
    }

    // Actions
    const actionsEl = document.getElementById('lib-modal-actions');
    actionsEl.innerHTML = '';

    const wlBtn = document.createElement('button');
    wlBtn.className = 'modal-btn modal-btn-watchlist' + (item.isInWatchlist ? ' in-watchlist' : '');
    wlBtn.textContent = item.isInWatchlist ? '✓ In Watchlist' : '+ Watchlist';
    wlBtn.addEventListener('click', function () {
      window.Watchlist.toggle(wlBtn, item);
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
      if (card) handleDismiss(card, item.ratingKey, item.title);
      closeModal();
    });
    actionsEl.appendChild(dismissBtn);

    // Trailer — lazy fetch, autoplay muted
    const trailerEl = document.getElementById('lib-modal-trailer');
    if (trailerEl) {
      trailerEl.innerHTML = '';
      trailerEl.classList.remove('active');
      if (item.tmdbId) {
        const mediaType = item.type === 'movie' ? 'movie' : 'tv';
        fetch('/api/trailer?tmdbId=' + item.tmdbId + '&mediaType=' + mediaType)
          .then(r => r.json())
          .then(data => {
            if (!data.trailerKey || !trailerEl.isConnected) return;
            const iframe = document.createElement('iframe');
            iframe.src = 'https://www.youtube.com/embed/' + data.trailerKey +
              '?autoplay=1&mute=1&rel=0&modestbranding=1&playsinline=1';
            iframe.setAttribute('allow', 'autoplay; encrypted-media; fullscreen');
            iframe.setAttribute('allowfullscreen', '');
            trailerEl.innerHTML = '';
            trailerEl.appendChild(iframe);
            trailerEl.classList.add('active');
          })
          .catch(() => {});
      }
    }

    modalEl.classList.add('open');
    modalEl.setAttribute('aria-hidden', 'false');
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
    wlBtn.title = item.isInWatchlist ? 'Remove from Watchlist' : 'Add to Watchlist';
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
      handleDismiss(card, item.ratingKey, item.title);
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
        reasons.appendChild(makeReasonTag(r));
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

  function handleDismiss(cardEl, ratingKey, title) {
    if (window.Watchlist?.isTouchDevice()) {
      window.Watchlist.mobileConfirm(
        title || 'this title',
        function () { doDismiss(cardEl, ratingKey); },
        function () {},
        { heading: 'Hide this title?', confirmLabel: 'Hide' }
      );
      return;
    }
    doDismiss(cardEl, ratingKey);
  }

  function doDismiss(cardEl, ratingKey) {
    cardEl.classList.add('card-dismissing');
    fetch('/api/dismiss', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ratingKey }),
    })
      .then(r => r.json())
      .then(() => {
        setTimeout(() => { cardEl.remove(); }, 300);
      })
      .catch(err => {
        console.error('Dismiss error:', err);
        cardEl.classList.remove('card-dismissing');
      });
  }

  // ----------------------------------------------------------------
  // Carousel renderer
  // ----------------------------------------------------------------

  function renderCarousel(sectionId, items) {
    const grid = document.getElementById('grid-' + sectionId);
    if (!grid) return;

    grid.innerHTML = '';
    grid.classList.remove('skeleton-grid');

    if (!items || items.length === 0) {
      grid.innerHTML = '<div class="empty-state">No recommendations found yet. Watch some content and check back!</div>';
      return;
    }

    const frag = document.createDocumentFragment();
    items.forEach(item => frag.appendChild(renderCard(item)));
    grid.appendChild(frag);
    grid.scrollLeft = 0;
    if (grid._updateArrows) grid._updateArrows();
  }

  function initCarouselArrows() {
    document.querySelectorAll('.carousel-wrap').forEach(function (wrap) {
      const grid = wrap.querySelector('.card-grid');
      const btnPrev = wrap.querySelector('.carousel-arrow-prev');
      const btnNext = wrap.querySelector('.carousel-arrow-next');
      if (!grid || !btnPrev || !btnNext) return;

      function updateArrows() {
        btnPrev.disabled = grid.scrollLeft <= 2;
        btnNext.disabled = grid.scrollLeft + grid.clientWidth >= grid.scrollWidth - 2;
      }

      btnPrev.onclick = function () { grid.scrollBy({ left: -grid.clientWidth, behavior: 'smooth' }); };
      btnNext.onclick = function () { grid.scrollBy({ left: grid.clientWidth, behavior: 'smooth' }); };
      grid.addEventListener('scroll', updateArrows, { passive: true });
      grid._updateArrows = updateArrows;
      updateArrows();
    });
  }

  // Expose renderCard globally for discover.js
  window.renderCard = renderCard;

  // ----------------------------------------------------------------
  // Shuffle — re-fetches a fresh random sample from the cached pool
  // ----------------------------------------------------------------

  function shuffleAll(triggerBtn) {
    // Spin the button briefly
    if (triggerBtn) {
      triggerBtn.style.transition = 'transform 0.4s ease';
      triggerBtn.style.transform = 'rotate(360deg)';
      setTimeout(function () {
        triggerBtn.style.transform = '';
        triggerBtn.style.transition = '';
      }, 400);
    }

    // Show skeleton on all grids while loading
    ['top-picks', 'movies', 'tv', 'anime'].forEach(function (id) {
      const grid = document.getElementById('grid-' + id);
      if (!grid) return;
      grid.innerHTML = '';
      grid.classList.add('skeleton-grid');
      for (let i = 0; i < 8; i++) {
        const card = document.createElement('div');
        card.className = 'card card-skeleton';
        card.innerHTML = '<div class="skeleton-poster shimmer"></div>'
          + '<div class="skeleton-info">'
          + '<div class="skeleton-line shimmer" style="width:70%"></div>'
          + '<div class="skeleton-line shimmer" style="width:40%"></div>'
          + '</div>';
        grid.appendChild(card);
      }
    });

    fetch('/api/recommendations')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data) return;
        renderCarousel('top-picks', data.topPicks);
        renderCarousel('movies', data.movies);
        renderCarousel('tv', data.tvShows);
        renderCarousel('anime', data.anime);
      })
      .catch(function (err) { console.error('Shuffle error:', err); });
  }

  // ----------------------------------------------------------------
  // Bootstrap
  // ----------------------------------------------------------------

  document.addEventListener('DOMContentLoaded', function () {
    initCarouselArrows();

    // Wire shuffle buttons
    document.querySelectorAll('.carousel-btn-shuffle').forEach(function (btn) {
      btn.addEventListener('click', function () { shuffleAll(btn); });
    });

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
        renderCarousel('top-picks', data.topPicks);
        renderCarousel('movies', data.movies);
        renderCarousel('tv', data.tvShows);
        renderCarousel('anime', data.anime);
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
