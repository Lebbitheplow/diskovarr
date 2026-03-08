(function () {
  'use strict';

  var cfg = window.EXPLORE_CONFIG || { services: {}, hasAnyService: false };

  // ── Toast ─────────────────────────────────────────────────────────────────

  function showToast(msg, type) {
    var t = document.getElementById('explore-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'explore-toast';
      t.className = 'wl-toast';
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.className = 'wl-toast ' + (type === 'error' ? 'wl-toast-remove' : 'wl-toast-add') + ' wl-toast-show';
    clearTimeout(t._timer);
    t._timer = setTimeout(function () { t.classList.remove('wl-toast-show'); }, 4000);
  }

  // ── Dismiss (Not Interested) ──────────────────────────────────────────────

  async function dismissItem(item, cardEl) {
    try {
      var r = await fetch('/api/explore/dismiss', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tmdbId: item.tmdbId, mediaType: item.mediaType }),
      });
      if (!r.ok) throw new Error('Dismiss failed');

      // Remove from all carousel states and re-render affected sections
      for (var sid in carouselState) {
        var state = carouselState[sid];
        var idx = state.items.findIndex(function (i) { return i.tmdbId === item.tmdbId && i.mediaType === item.mediaType; });
        if (idx === -1) continue;
        state.items.splice(idx, 1);
        state.pages = Math.ceil(state.items.length / state.cpp) || 1;
        if (state.page > state.pages) state.page = state.pages;
        var section = document.getElementById(sid);
        var gridId = section ? section.querySelector('.card-grid')?.id : null;
        if (gridId) {
          renderPage(sid, gridId);
          updateControls(sid, section);
        }
      }
    } catch (err) {
      showToast('Could not dismiss: ' + err.message, 'error');
    }
  }

  // ── Request dialog ────────────────────────────────────────────────────────

  var pendingRequest = null;

  function openRequestDialog(item) {
    pendingRequest = item;
    var dialog = document.getElementById('request-dialog');
    var titleEl = document.getElementById('request-dialog-title');
    var subEl = document.getElementById('request-dialog-sub');
    var actionsEl = document.getElementById('request-dialog-actions');

    titleEl.textContent = 'Request "' + item.title + '"?';

    var isMovie = item.mediaType === 'movie';
    var s = cfg.services;
    var overseerr = s.overseerr;
    var relevant = isMovie ? s.radarr : s.sonarr;
    var serviceName = isMovie ? 'Radarr' : 'Sonarr';

    subEl.textContent = item.year ? item.year + ' · ' + (isMovie ? 'Movie' : 'TV Show') : (isMovie ? 'Movie' : 'TV Show');

    // Build action buttons
    actionsEl.innerHTML = '';

    var cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn-dialog-cancel';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.onclick = closeRequestDialog;
    actionsEl.appendChild(cancelBtn);

    if (overseerr && relevant) {
      // Both Overseerr and direct service available — let user choose
      var osBtn = document.createElement('button');
      osBtn.className = 'btn-dialog-confirm';
      osBtn.textContent = 'Overseerr';
      osBtn.onclick = function () { submitRequest(item, 'overseerr'); };
      actionsEl.appendChild(osBtn);

      var svcBtn = document.createElement('button');
      svcBtn.className = 'btn-dialog-confirm';
      svcBtn.textContent = serviceName;
      svcBtn.onclick = function () { submitRequest(item, isMovie ? 'radarr' : 'sonarr'); };
      actionsEl.appendChild(svcBtn);
    } else {
      // Only one service available
      var confirmBtn = document.createElement('button');
      confirmBtn.className = 'btn-dialog-confirm';
      confirmBtn.textContent = 'Request';
      var svc = overseerr ? 'overseerr' : (isMovie ? 'radarr' : 'sonarr');
      confirmBtn.onclick = function () { submitRequest(item, svc); };
      actionsEl.appendChild(confirmBtn);
    }

    dialog.classList.add('open');
    dialog.setAttribute('aria-hidden', 'false');
  }

  function closeRequestDialog() {
    var dialog = document.getElementById('request-dialog');
    dialog.classList.remove('open');
    dialog.setAttribute('aria-hidden', 'true');
    pendingRequest = null;
  }

  async function submitRequest(item, service) {
    closeRequestDialog();

    // Find all request buttons for this item and disable them
    var btns = document.querySelectorAll('[data-request-tmdb="' + item.tmdbId + '"]');
    btns.forEach(function (btn) {
      btn.disabled = true;
      btn.textContent = 'Requesting…';
      btn.classList.add('btn-request-sent');
    });

    try {
      var r = await fetch('/api/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tmdbId: item.tmdbId,
          mediaType: item.mediaType,
          title: item.title,
          year: item.year || null,
          service,
        }),
      });
      var data = await r.json();
      if (!r.ok || !data.success) {
        throw new Error(data.error || 'Request failed');
      }

      // Mark all cards for this item as requested
      btns.forEach(function (btn) {
        btn.textContent = 'Requested ✓';
        btn.disabled = true;
        btn.classList.add('btn-request-sent');
      });

      showToast('Requested: ' + item.title + ' via ' + service.charAt(0).toUpperCase() + service.slice(1));
    } catch (err) {
      btns.forEach(function (btn) {
        btn.textContent = 'Request';
        btn.disabled = false;
        btn.classList.remove('btn-request-sent');
      });
      showToast('Request failed: ' + err.message, 'error');
    }
  }

  // Close dialog on backdrop click or Escape
  document.addEventListener('DOMContentLoaded', function () {
    var dialog = document.getElementById('request-dialog');
    if (dialog) {
      dialog.addEventListener('click', function (e) {
        if (e.target === dialog) closeRequestDialog();
      });
    }
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeRequestDialog();
    });
  });

  // ── Detail modal ──────────────────────────────────────────────────────────

  function openDetailModal(item) {
    var modal = document.getElementById('detail-modal');
    if (!modal) return; // guard: stale page without modal HTML

    // Hero backdrop
    var hero = document.getElementById('detail-modal-hero');
    var modalBody = hero ? hero.parentElement.querySelector('.detail-modal-body') : null;
    var modalInfo = hero ? hero.parentElement.querySelector('.detail-modal-info') : null;
    if (hero) {
      if (item.backdropUrl) {
        hero.style.backgroundImage = 'url(' + item.backdropUrl + ')';
        hero.style.display = '';
        if (modalBody) { modalBody.style.marginTop = ''; modalBody.style.paddingTop = ''; }
        if (modalInfo) modalInfo.style.paddingTop = '';
      } else {
        hero.style.display = 'none';
        if (modalBody) { modalBody.style.marginTop = '0'; modalBody.style.paddingTop = '22px'; }
        if (modalInfo) modalInfo.style.paddingTop = '0';
      }
    }

    // Poster
    var posterEl = document.getElementById('detail-modal-poster');
    if (item.posterUrl) {
      posterEl.src = item.posterUrl;
      posterEl.alt = item.title;
      posterEl.style.display = '';
    } else {
      posterEl.style.display = 'none';
    }

    // Trailer — lazy fetch then inject autoplay muted iframe
    var trailerEl = document.getElementById('detail-modal-trailer');
    if (trailerEl) {
      trailerEl.innerHTML = '';
      trailerEl.classList.remove('active');
      var trailerTmdbId = item.tmdbId;
      var trailerMediaType = item.mediaType || 'movie';
      if (trailerTmdbId) {
        fetch('/api/trailer?tmdbId=' + trailerTmdbId + '&mediaType=' + trailerMediaType)
          .then(function (r) { return r.json(); })
          .then(function (data) {
            if (!data.trailerKey || !trailerEl.isConnected) return;
            var iframe = document.createElement('iframe');
            iframe.src = 'https://www.youtube.com/embed/' + data.trailerKey +
              '?autoplay=1&mute=1&rel=0&modestbranding=1&playsinline=1';
            iframe.setAttribute('allow', 'autoplay; encrypted-media; fullscreen');
            iframe.setAttribute('allowfullscreen', '');
            trailerEl.innerHTML = '';
            trailerEl.appendChild(iframe);
            trailerEl.classList.add('active');
          })
          .catch(function () {});
      }
    }

    // Title
    document.getElementById('detail-modal-title').textContent = item.title;

    // Meta
    var metaParts = [];
    if (item.year) metaParts.push(item.year);
    metaParts.push(item.mediaType === 'movie' ? 'Movie' : (item.isAnime ? 'Anime' : 'TV Show'));
    if (item.voteAverage && item.voteAverage > 0) metaParts.push('★ ' + item.voteAverage.toFixed(1));
    document.getElementById('detail-modal-meta').textContent = metaParts.join(' · ');

    // Reason tags (why it's recommended)
    var reasonsEl = document.getElementById('detail-modal-reasons');
    reasonsEl.innerHTML = '';
    if (item.reasons && item.reasons.length > 0) {
      item.reasons.forEach(function (r) {
        var tag = document.createElement('span');
        tag.className = 'reason-tag';
        tag.textContent = r;
        reasonsEl.appendChild(tag);
      });
    }

    // Genre tags
    var genresEl = document.getElementById('detail-modal-genres');
    genresEl.innerHTML = '';
    if (item.genres && item.genres.length > 0) {
      item.genres.slice(0, 5).forEach(function (g) {
        var tag = document.createElement('span');
        tag.className = 'genre-tag';
        tag.textContent = g;
        genresEl.appendChild(tag);
      });
    }

    // Overview
    document.getElementById('detail-modal-overview').textContent = item.overview || '';

    // Credits
    var credEl = document.getElementById('detail-modal-credits');
    credEl.innerHTML = '';
    if (item.directors && item.directors.length > 0) {
      var label = item.mediaType === 'movie' ? 'Director' : 'Created by';
      var d = document.createElement('div');
      d.className = 'detail-credit-row';
      d.innerHTML = '<span class="detail-credit-label">' + label + ':</span> ' + item.directors.join(', ');
      credEl.appendChild(d);
    }
    if (item.cast && item.cast.length > 0) {
      var c = document.createElement('div');
      c.className = 'detail-credit-row';
      c.innerHTML = '<span class="detail-credit-label">Cast:</span> ' + item.cast.slice(0, 5).join(', ');
      credEl.appendChild(c);
    }
    if (item.studio) {
      var s = document.createElement('div');
      s.className = 'detail-credit-row';
      var sLabel = item.mediaType === 'tv' ? 'Network' : 'Studio';
      s.innerHTML = '<span class="detail-credit-label">' + sLabel + ':</span> ' + item.studio;
      credEl.appendChild(s);
    }

    // Actions
    var actEl = document.getElementById('detail-modal-actions');
    actEl.innerHTML = '';
    if (cfg.hasAnyService) {
      var reqBtn = document.createElement('button');
      reqBtn.className = 'btn-request' + (item.isRequested ? ' btn-request-sent' : '');
      reqBtn.setAttribute('data-request-tmdb', String(item.tmdbId));
      reqBtn.textContent = item.isRequested ? 'Requested ✓' : 'Request';
      reqBtn.disabled = item.isRequested;
      reqBtn.addEventListener('click', function () {
        if (!item.isRequested) {
          closeDetailModal();
          openRequestDialog(item);
        }
      });
      actEl.appendChild(reqBtn);
    }
    var notInterestedBtn = document.createElement('button');
    notInterestedBtn.className = 'modal-btn modal-btn-dismiss';
    notInterestedBtn.textContent = '✕ Not Interested';
    notInterestedBtn.addEventListener('click', function () {
      closeDetailModal();
      dismissItem(item, null);
    });
    actEl.appendChild(notInterestedBtn);

    var tmdbLink = document.createElement('a');
    tmdbLink.className = 'btn-tmdb-link';
    tmdbLink.href = 'https://www.themoviedb.org/' + item.mediaType + '/' + item.tmdbId;
    tmdbLink.target = '_blank';
    tmdbLink.rel = 'noopener';
    tmdbLink.textContent = 'View on TMDB';
    actEl.appendChild(tmdbLink);

    modal.classList.add('open');
    modal.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
  }

  function closeDetailModal() {
    var modal = document.getElementById('detail-modal');
    modal.classList.remove('open');
    modal.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
    // Clear iframe to stop playback
    var trailerEl = document.getElementById('detail-modal-trailer');
    if (trailerEl) { trailerEl.innerHTML = ''; trailerEl.classList.remove('active'); }
  }

  document.addEventListener('DOMContentLoaded', function () {
    var modal = document.getElementById('detail-modal');
    if (modal) {
      modal.addEventListener('click', function (e) {
        if (e.target === modal) closeDetailModal();
      });
      document.getElementById('detail-modal-close').addEventListener('click', closeDetailModal);
    }
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeDetailModal();
    });
  });

  // ── Card rendering ────────────────────────────────────────────────────────

  function renderCard(item) {
    var card = document.createElement('div');
    card.className = 'card explore-card';
    card.dataset.tmdbId = item.tmdbId;

    // Poster container — same aspect-ratio structure as home cards so card-info is visible
    var posterWrap = document.createElement('div');
    posterWrap.className = 'card-poster-link';
    posterWrap.style.cursor = 'pointer';

    if (item.posterUrl) {
      var img = document.createElement('img');
      img.className = 'card-poster';
      img.src = item.posterUrl;
      img.alt = item.title;
      img.loading = 'lazy';
      img.onerror = function () { this.style.display = 'none'; };
      posterWrap.appendChild(img);
    } else {
      var placeholder = document.createElement('div');
      placeholder.className = 'card-poster-placeholder';
      placeholder.textContent = item.title.charAt(0);
      posterWrap.appendChild(placeholder);
    }

    // "Not in Library" badge
    var badge = document.createElement('span');
    badge.className = 'badge-not-in-library';
    badge.textContent = item.isRequested ? 'Requested' : 'Not in Library';
    if (item.isRequested) badge.classList.add('badge-requested');
    posterWrap.appendChild(badge);

    // Hover overlay lives inside poster wrap (covers only poster, not card-info)
    var overlay = document.createElement('div');
    overlay.className = 'card-overlay';
    if (cfg.hasAnyService) {
      var reqBtn = document.createElement('button');
      reqBtn.className = 'btn-request' + (item.isRequested ? ' btn-request-sent' : '');
      reqBtn.setAttribute('data-request-tmdb', String(item.tmdbId));
      reqBtn.textContent = item.isRequested ? 'Requested ✓' : 'Request';
      reqBtn.disabled = item.isRequested;
      reqBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        if (!item.isRequested) openRequestDialog(item);
      });
      overlay.appendChild(reqBtn);
    }
    var dismissCardBtn = document.createElement('button');
    dismissCardBtn.className = 'btn-icon btn-dismiss';
    dismissCardBtn.textContent = '✕';
    dismissCardBtn.title = 'Not Interested';
    dismissCardBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      dismissItem(item, card);
    });
    overlay.appendChild(dismissCardBtn);
    posterWrap.appendChild(overlay);

    card.appendChild(posterWrap);

    // Card info (title, meta, reason tags) — below poster, not clipped
    var info = document.createElement('div');
    info.className = 'card-info';

    var title = document.createElement('div');
    title.className = 'card-title';
    title.textContent = item.title;
    info.appendChild(title);

    var meta = document.createElement('div');
    meta.className = 'card-meta';
    var parts = [];
    if (item.year) parts.push(item.year);
    if (item.voteAverage && item.voteAverage > 0) parts.push('★ ' + item.voteAverage.toFixed(1));
    meta.textContent = parts.join(' · ');
    info.appendChild(meta);

    if (item.reasons && item.reasons.length > 0) {
      var reasons = document.createElement('div');
      reasons.className = 'card-reasons';
      item.reasons.slice(0, 2).forEach(function (r) {
        var tag = document.createElement('span');
        tag.className = 'reason-tag';
        tag.textContent = r;
        reasons.appendChild(tag);
      });
      info.appendChild(reasons);
    }

    card.appendChild(info);

    // Clicking anywhere on the card opens the detail modal
    card.addEventListener('click', function () {
      openDetailModal(item);
    });

    return card;
  }

  // ── Carousel rendering ────────────────────────────────────────────────────

  var ROWS = 2;

  function cardsPerPage(grid) {
    var computed = window.getComputedStyle(grid);
    var cols = computed.gridTemplateColumns.split(' ').length || 4;
    return cols * ROWS;
  }

  var carouselState = {}; // sectionId -> { items, page, pages, cpp }

  function renderCarousel(sectionId, gridId, items) {
    var section = document.getElementById(sectionId);
    var grid = document.getElementById(gridId);
    if (!grid || !items.length) return;

    // Remove skeleton
    grid.classList.remove('skeleton-grid');
    grid.innerHTML = '';

    var cpp = cardsPerPage(grid) || 8;
    var totalPages = Math.ceil(items.length / cpp);
    var page = 1;

    carouselState[sectionId] = { items, page, pages: totalPages, cpp };

    renderPage(sectionId, gridId);
    updateControls(sectionId, section);
  }

  function renderPage(sectionId, gridId) {
    var state = carouselState[sectionId];
    if (!state) return;

    var grid = document.getElementById(gridId);
    if (!grid) return;

    grid.innerHTML = '';
    var start = (state.page - 1) * state.cpp;
    var slice = state.items.slice(start, start + state.cpp);
    slice.forEach(function (item) {
      grid.appendChild(renderCard(item));
    });
  }

  function updateControls(sectionId, section) {
    var state = carouselState[sectionId];
    if (!state) return;

    var prevBtn = section.querySelector('.carousel-btn-prev');
    var nextBtn = section.querySelector('.carousel-btn-next');
    var counter = section.querySelector('.carousel-counter');

    if (prevBtn) prevBtn.hidden = state.page <= 1;
    if (nextBtn) nextBtn.hidden = state.page >= state.pages;
    if (counter) {
      counter.textContent = state.pages > 1 ? state.page + ' / ' + state.pages : '';
    }
  }

  function attachCarouselListeners(sectionId, gridId) {
    var section = document.getElementById(sectionId);
    if (!section) return;

    section.querySelector('.carousel-btn-prev')?.addEventListener('click', function () {
      var state = carouselState[sectionId];
      if (state && state.page > 1) {
        state.page--;
        renderPage(sectionId, gridId);
        updateControls(sectionId, section);
      }
    });

    section.querySelector('.carousel-btn-next')?.addEventListener('click', function () {
      var state = carouselState[sectionId];
      if (state && state.page < state.pages) {
        state.page++;
        renderPage(sectionId, gridId);
        updateControls(sectionId, section);
      }
    });

    section.querySelector('.carousel-btn-shuffle')?.addEventListener('click', function (e) {
      var btn = e.currentTarget;
      btn.classList.add('spinning');
      setTimeout(function () { btn.classList.remove('spinning'); }, 600);
      fetchAndRender(true);
    });
  }

  // ── Data fetching ─────────────────────────────────────────────────────────

  var sections = [
    { sectionId: 'section-top-picks', gridId: 'grid-top-picks', key: 'topPicks' },
    { sectionId: 'section-movies',    gridId: 'grid-movies',    key: 'movies' },
    { sectionId: 'section-tv',        gridId: 'grid-tv',        key: 'tvShows' },
    { sectionId: 'section-anime',     gridId: 'grid-anime',     key: 'anime' },
  ];

  function showSkeletons() {
    sections.forEach(function (s) {
      var grid = document.getElementById(s.gridId);
      if (!grid) return;
      grid.classList.add('skeleton-grid');
      grid.innerHTML = '';
      for (var i = 0; i < 12; i++) {
        var card = document.createElement('div');
        card.className = 'card card-skeleton';
        card.innerHTML = '<div class="skeleton-poster shimmer"></div><div class="skeleton-info"><div class="skeleton-line shimmer" style="width:75%"></div><div class="skeleton-line shimmer" style="width:45%"></div></div>';
        grid.appendChild(card);
      }
    });
  }

  function showSectionError(msg) {
    sections.forEach(function (s) {
      var grid = document.getElementById(s.gridId);
      if (grid) {
        grid.classList.remove('skeleton-grid');
        grid.innerHTML = '<p style="color:var(--text-muted);padding:20px 0">' + msg + '</p>';
      }
    });
  }

  function isMatureEnabled() {
    return localStorage.getItem('matureEnabled') === 'true';
  }

  // ── Building progress bar ─────────────────────────────────────────────────
  var buildingBar = null;
  var buildingInterval = null;

  function showBuildingBar() {
    if (buildingBar) return;
    buildingBar = document.createElement('div');
    buildingBar.id = 'explore-building-bar';
    buildingBar.innerHTML =
      '<div class="explore-building-inner">' +
        '<div class="explore-building-track"><div class="explore-building-fill"></div></div>' +
        '<span class="explore-building-label">Building your recommendations\u2026</span>' +
      '</div>';
    var hero = document.querySelector('.hero');
    if (hero) hero.after(buildingBar);
    else document.querySelector('.main-content').prepend(buildingBar);
  }

  function hideBuildingBar() {
    if (buildingBar) { buildingBar.remove(); buildingBar = null; }
    if (buildingInterval) { clearInterval(buildingInterval); buildingInterval = null; }
  }

  async function fetchAndRender(shuffle) {
    if (shuffle) showSkeletons();
    try {
      var url = '/api/explore/recommendations' + (isMatureEnabled() ? '?mature=true' : '');
      var r = await fetch(url);
      var data = await r.json();

      if (!r.ok) {
        hideBuildingBar();
        if (data.error === 'no_tmdb_key') {
          showSectionError('TMDB API key not configured. Add one in Admin → Connections to enable recommendations.');
        } else {
          showSectionError('Could not load recommendations: ' + (data.message || data.error || 'Unknown error'));
        }
        return;
      }

      // Pool is still building — show progress bar and poll
      if (data.status === 'building') {
        showBuildingBar();
        if (!buildingInterval) {
          buildingInterval = setInterval(function () { fetchAndRender(false); }, 5000);
        }
        return;
      }

      hideBuildingBar();
      sections.forEach(function (s) {
        var items = data[s.key] || [];
        renderCarousel(s.sectionId, s.gridId, items);
        attachCarouselListeners(s.sectionId, s.gridId);
      });
    } catch (err) {
      hideBuildingBar();
      showToast('Failed to load recommendations: ' + err.message, 'error');
      showSectionError('Could not load recommendations. Check your connection and try again.');
    }
  }

  document.addEventListener('DOMContentLoaded', function () {
    var toggle = document.getElementById('mature-toggle');
    if (toggle) {
      toggle.checked = isMatureEnabled();
      toggle.addEventListener('change', function () {
        localStorage.setItem('matureEnabled', toggle.checked ? 'true' : 'false');
        showSkeletons();
        fetchAndRender(false);
      });
    }
    fetchAndRender(false);
  });

})();
