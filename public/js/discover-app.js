(function () {
  'use strict';

  var cfg = window.EXPLORE_CONFIG || { services: {}, hasAnyService: false };

  // ── Helpers ───────────────────────────────────────────────────────────────

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

  // ── Mobile confirm (shared pattern with watchlist.js) ────────────────────
  var isTouchDevice = window.matchMedia('(pointer: coarse)').matches;

  function mobileConfirm(title, onConfirm, onCancel, opts) {
    var heading = (opts && opts.heading) || 'Confirm';
    var confirmLabel = (opts && opts.confirmLabel) || 'OK';
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
    popup.querySelector('.wl-confirm-ok').addEventListener('click', function () { close(); onConfirm(); });
    popup.querySelector('.wl-confirm-cancel').addEventListener('click', function () { close(); onCancel(); });
    popup.addEventListener('click', function (e) { if (e.target === popup) { close(); onCancel(); } });
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

      // Remove dismissed item from all stores and animate card out
      if (cardEl) {
        cardEl.style.transition = 'opacity 0.25s, transform 0.25s';
        cardEl.style.opacity = '0';
        cardEl.style.transform = 'scale(0.88)';
        setTimeout(function () { cardEl.remove(); }, 260);
      }
      for (var sid in itemStore) {
        var idx = itemStore[sid].findIndex(function (i) { return i.tmdbId === item.tmdbId && i.mediaType === item.mediaType; });
        if (idx !== -1) itemStore[sid].splice(idx, 1);
      }
    } catch (err) {
      showToast('Could not dismiss: ' + err.message, 'error');
    }
  }

  // ── Request dialog ────────────────────────────────────────────────────────

  var pendingRequest = null;

  // Season picker state per dialog open
  var _seasonSelection = ['all']; // 'all' or array of numbers as strings

  function buildSeasonPicker(tmdbId, onReady) {
    var wrap = document.createElement('div');
    wrap.className = 'season-picker-wrap';

    var label = document.createElement('div');
    label.className = 'season-picker-label';
    label.textContent = 'Seasons:';
    wrap.appendChild(label);

    var chipRow = document.createElement('div');
    chipRow.className = 'season-chips';
    wrap.appendChild(chipRow);

    // Loading state
    var loading = document.createElement('span');
    loading.className = 'season-loading';
    loading.textContent = 'Loading seasons…';
    chipRow.appendChild(loading);

    _seasonSelection = ['all'];

    fetch('/api/search/seasons?tmdbId=' + tmdbId)
      .then(function (r) { return r.json(); })
      .then(function (data) {
        chipRow.innerHTML = '';
        var seasonNums = data.seasons || [];

        function renderChips() {
          chipRow.innerHTML = '';
          var allChip = document.createElement('button');
          allChip.type = 'button';
          allChip.className = 'season-chip' + (_seasonSelection[0] === 'all' ? ' active' : '');
          allChip.textContent = 'All';
          allChip.addEventListener('click', function () {
            _seasonSelection = ['all'];
            renderChips();
          });
          chipRow.appendChild(allChip);

          seasonNums.forEach(function (n) {
            var chip = document.createElement('button');
            chip.type = 'button';
            var isActive = _seasonSelection[0] !== 'all' && _seasonSelection.includes(String(n));
            chip.className = 'season-chip' + (isActive ? ' active' : '');
            chip.textContent = String(n);
            chip.addEventListener('click', function () {
              if (_seasonSelection[0] === 'all') {
                _seasonSelection = [String(n)];
              } else {
                var idx = _seasonSelection.indexOf(String(n));
                if (idx === -1) {
                  _seasonSelection.push(String(n));
                } else {
                  _seasonSelection.splice(idx, 1);
                  if (_seasonSelection.length === 0) _seasonSelection = ['all'];
                }
              }
              renderChips();
            });
            chipRow.appendChild(chip);
          });
        }
        renderChips();
        if (onReady) onReady();
      })
      .catch(function () {
        chipRow.innerHTML = '<span class="season-loading">Could not load seasons</span>';
        if (onReady) onReady();
      });

    return wrap;
  }

  function getSelectedSeasons() {
    if (_seasonSelection[0] === 'all') return null;
    return _seasonSelection.map(Number);
  }

  function openRequestDialog(item) {
    pendingRequest = item;
    var dialog = document.getElementById('request-dialog');
    var titleEl = document.getElementById('request-dialog-title');
    var subEl = document.getElementById('request-dialog-sub');
    var actionsEl = document.getElementById('request-dialog-actions');

    titleEl.textContent = 'Request "' + item.title + '"?';

    var posterEl = document.getElementById('request-dialog-poster');
    if (posterEl) {
      if (item.posterUrl) { posterEl.src = item.posterUrl; posterEl.classList.add('visible'); }
      else { posterEl.src = ''; posterEl.classList.remove('visible'); }
    }

    var isMovie = item.mediaType === 'movie';
    var s = cfg.services;
    var hasOverseerr = s.overseerr;
    var hasDirect    = isMovie ? s.radarr : s.sonarr;
    var directName   = isMovie ? 'Radarr' : 'Sonarr';
    var directSvc    = isMovie ? 'radarr' : 'sonarr';

    subEl.textContent = item.year ? item.year + ' · ' + (isMovie ? 'Movie' : 'TV Show') : (isMovie ? 'Movie' : 'TV Show');

    var hasBothSides = hasOverseerr && hasDirect;
    var defaultSvc;
    if (hasBothSides) {
      defaultSvc = (s.defaultService === 'direct') ? directSvc : 'overseerr';
    } else {
      defaultSvc = hasOverseerr ? 'overseerr' : directSvc;
    }

    actionsEl.innerHTML = '';

    var dialogBox = dialog.querySelector('.request-dialog-box') || dialog.firstElementChild;
    var existingAdv = dialog.querySelector('.request-dialog-advanced');
    if (existingAdv) existingAdv.remove();
    var existingSeason = dialog.querySelector('.season-picker-wrap');
    if (existingSeason) existingSeason.remove();

    // Season picker (TV shows + individual seasons enabled)
    var showSeasonPicker = !isMovie && cfg.individualSeasonsEnabled;
    if (showSeasonPicker) {
      var pickerEl = buildSeasonPicker(item.tmdbId, null);
      actionsEl.parentNode.insertBefore(pickerEl, actionsEl);
    }

    var canSeeAdvanced = hasBothSides && (cfg.directRequestAccess !== 'admin' || cfg.isOwner);
    if (canSeeAdvanced) {
      var altSvc  = (defaultSvc === 'overseerr') ? directSvc : 'overseerr';
      var altName = (defaultSvc === 'overseerr') ? directName : 'Overseerr';

      var advWrap = document.createElement('div');
      advWrap.className = 'request-dialog-advanced';

      var advToggle = document.createElement('button');
      advToggle.className = 'request-dialog-adv-toggle';
      advToggle.textContent = 'Advanced ▸';
      advToggle.type = 'button';

      var advPanel = document.createElement('div');
      advPanel.className = 'request-dialog-adv-panel';
      advPanel.style.display = 'none';

      var altBtn = document.createElement('button');
      altBtn.className = 'btn-dialog-alt';
      altBtn.textContent = 'Send to ' + altName + ' instead';
      altBtn.type = 'button';
      altBtn.onclick = function () { submitRequest(item, altSvc, showSeasonPicker ? getSelectedSeasons() : null); };
      advPanel.appendChild(altBtn);

      advToggle.onclick = function () {
        var open = advPanel.style.display === 'none';
        advPanel.style.display = open ? '' : 'none';
        advToggle.textContent = open ? 'Advanced ▾' : 'Advanced ▸';
      };

      advWrap.appendChild(advToggle);
      advWrap.appendChild(advPanel);
      actionsEl.parentNode.insertBefore(advWrap, actionsEl);
    }

    var cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn-dialog-cancel';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.onclick = closeRequestDialog;
    actionsEl.appendChild(cancelBtn);

    var confirmBtn = document.createElement('button');
    confirmBtn.className = 'btn-dialog-confirm';
    confirmBtn.textContent = 'Request';
    confirmBtn.onclick = function () { submitRequest(item, defaultSvc, showSeasonPicker ? getSelectedSeasons() : null); };
    actionsEl.appendChild(confirmBtn);

    dialog.classList.add('open');
    dialog.setAttribute('aria-hidden', 'false');
  }

  function closeRequestDialog() {
    var dialog = document.getElementById('request-dialog');
    dialog.classList.remove('open');
    dialog.setAttribute('aria-hidden', 'true');
    pendingRequest = null;
  }

  async function submitRequest(item, service, seasons) {
    closeRequestDialog();

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
          seasons: seasons || null,
        }),
      });
      var data = await r.json();
      if (!r.ok || !data.success) {
        throw new Error(data.error || 'Request failed');
      }

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
    var metaEl = document.getElementById('detail-modal-meta');
    metaEl.textContent = metaParts.join(' · ');
    if (item.contentRating) {
      var ratingBadge = document.createElement('span');
      ratingBadge.className = 'content-rating-badge rating-' + item.contentRating.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
      ratingBadge.textContent = item.contentRating;
      metaEl.appendChild(document.createTextNode(' · '));
      metaEl.appendChild(ratingBadge);
    }

    // Reason tags (why it's recommended)
    var reasonsEl = document.getElementById('detail-modal-reasons');
    reasonsEl.innerHTML = '';
    if (item.reasons && item.reasons.length > 0) {
      item.reasons.forEach(function (r) {
        reasonsEl.appendChild(makeReasonTag(r));
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
    if (item.adult) card.dataset.adult = 'true';

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
    var overlayActions = document.createElement('div');
    overlayActions.className = 'card-overlay-actions';
    if (cfg.hasAnyService) {
      var reqBtn = document.createElement('button');
      reqBtn.className = 'btn-icon btn-request' + (item.isRequested ? ' btn-request-sent' : '');
      reqBtn.setAttribute('data-request-tmdb', String(item.tmdbId));
      reqBtn.textContent = item.isRequested ? 'Requested ✓' : 'Request';
      reqBtn.disabled = item.isRequested;
      reqBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        if (!item.isRequested) openRequestDialog(item);
      });
      overlayActions.appendChild(reqBtn);
    }
    var dismissCardBtn = document.createElement('button');
    dismissCardBtn.className = 'btn-icon btn-dismiss';
    dismissCardBtn.textContent = '✕';
    dismissCardBtn.title = 'Not Interested';
    dismissCardBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (isTouchDevice) {
        mobileConfirm(item.title || 'this title', function () { dismissItem(item, card); }, function () {},
          { heading: 'Hide this title?', confirmLabel: 'Hide' });
      } else {
        dismissItem(item, card);
      }
    });
    overlayActions.appendChild(dismissCardBtn);
    overlay.appendChild(overlayActions);
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
        reasons.appendChild(makeReasonTag(r));
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

  // itemStore: sectionId -> items[] (for dismiss re-render)
  var itemStore = {};

  function renderCarousel(sectionId, gridId, items) {
    var grid = document.getElementById(gridId);
    if (!grid) return;

    grid.classList.remove('skeleton-grid');
    grid.innerHTML = '';

    if (!items.length) return;

    itemStore[sectionId] = items;
    var frag = document.createDocumentFragment();
    items.forEach(function (item) { frag.appendChild(renderCard(item)); });
    grid.appendChild(frag);
    grid.scrollLeft = 0;
    applyMatureFilter();
    if (grid._updateArrows) grid._updateArrows();
  }

  function initCarouselArrows() {
    document.querySelectorAll('.carousel-wrap').forEach(function (wrap) {
      var grid = wrap.querySelector('.card-grid');
      var btnPrev = wrap.querySelector('.carousel-arrow-prev');
      var btnNext = wrap.querySelector('.carousel-arrow-next');
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

  function attachCarouselListeners(sectionId, gridId) {
    var section = document.getElementById(sectionId);
    if (!section) return;

    // per-section shuffle removed — single global button handles all sections
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
      var url = '/api/explore/recommendations?mature=true';
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

      // Trending sections — show only if at least 8 items outside the library
      [
        { sectionId: 'section-trending-movies', gridId: 'grid-trending-movies', key: 'trendingMovies' },
        { sectionId: 'section-trending-tv',     gridId: 'grid-trending-tv',     key: 'trendingTV' },
      ].forEach(function (s) {
        var items = data[s.key] || [];
        var section = document.getElementById(s.sectionId);
        if (!section) return;
        if (items.length < 8) {
          section.style.display = 'none';
          return;
        }
        section.style.display = '';
        renderCarousel(s.sectionId, s.gridId, items);
        // Wire carousel arrows for the newly visible section
        var wrap = section.querySelector('.carousel-wrap');
        if (wrap) {
          var grid = wrap.querySelector('.card-grid');
          var btnPrev = wrap.querySelector('.carousel-arrow-prev');
          var btnNext = wrap.querySelector('.carousel-arrow-next');
          if (grid && btnPrev && btnNext) {
            function makeUpdate(g, p, n) {
              return function () {
                p.disabled = g.scrollLeft <= 2;
                n.disabled = g.scrollLeft + g.clientWidth >= g.scrollWidth - 2;
              };
            }
            var update = makeUpdate(grid, btnPrev, btnNext);
            btnPrev.onclick = function () { grid.scrollBy({ left: -grid.clientWidth, behavior: 'smooth' }); };
            btnNext.onclick = function () { grid.scrollBy({ left: grid.clientWidth, behavior: 'smooth' }); };
            grid.addEventListener('scroll', update, { passive: true });
            grid._updateArrows = update;
            update();
          }
        }
      });
    } catch (err) {
      hideBuildingBar();
      showToast('Failed to load recommendations: ' + err.message, 'error');
      showSectionError('Could not load recommendations. Check your connection and try again.');
    }
  }

  function applyMatureFilter() {
    var show = isMatureEnabled();
    document.querySelectorAll('.explore-card[data-adult="true"]').forEach(function (card) {
      card.style.display = show ? '' : 'none';
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    initCarouselArrows();
  });

  document.addEventListener('DOMContentLoaded', function () {
    var toggle = document.getElementById('mature-toggle');
    if (toggle) {
      toggle.checked = isMatureEnabled();
      toggle.addEventListener('change', function () {
        localStorage.setItem('matureEnabled', toggle.checked ? 'true' : 'false');
        applyMatureFilter();
      });
    }
    var shuffleBtn = document.getElementById('btn-shuffle-all');
    if (shuffleBtn) {
      shuffleBtn.addEventListener('click', function () {
        shuffleBtn.classList.add('spinning');
        setTimeout(function () { shuffleBtn.classList.remove('spinning'); }, 600);
        fetchAndRender(true);
      });
    }
    initHeroSearch();
    fetchAndRender(false);
  });

  // ── Hero search bar + autocomplete ────────────────────────────────────────

  function initHeroSearch() {
    var input = document.getElementById('hero-search');
    var clearBtn = document.getElementById('hero-search-clear');
    var dropdown = document.getElementById('hero-search-dropdown');
    if (!input || !dropdown) return;

    var suggestTimer = null;
    var activeIdx = -1;
    var suggestions = [];

    function showClear(v) { if (clearBtn) clearBtn.style.display = v ? 'block' : 'none'; }

    function closeDropdown() {
      dropdown.innerHTML = '';
      dropdown.classList.remove('open');
      activeIdx = -1;
      suggestions = [];
    }

    function navigateTo(q) {
      closeDropdown();
      window.location.href = '/search?q=' + encodeURIComponent(q);
    }

    function renderDropdown(results) {
      dropdown.innerHTML = '';
      if (!results.length) { closeDropdown(); return; }
      suggestions = results;
      activeIdx = -1;

      results.forEach(function (item, idx) {
        var row = document.createElement('div');
        row.className = 'hero-suggest-row';
        row.setAttribute('role', 'option');
        row.setAttribute('tabindex', '-1');

        var poster = document.createElement('div');
        poster.className = 'hero-suggest-poster';
        if (item.posterUrl) {
          var img = document.createElement('img');
          img.src = item.posterUrl;
          img.alt = '';
          img.loading = 'lazy';
          poster.appendChild(img);
        } else {
          poster.textContent = (item.title || '?').charAt(0);
        }

        var text = document.createElement('div');
        text.className = 'hero-suggest-text';

        var titleSpan = document.createElement('span');
        titleSpan.className = 'hero-suggest-title';
        titleSpan.textContent = item.title;

        var metaSpan = document.createElement('span');
        metaSpan.className = 'hero-suggest-meta';
        var metaParts = [];
        if (item.year) metaParts.push(item.year);
        metaParts.push(item.mediaType === 'movie' ? 'Movie' : 'TV Show');
        metaSpan.textContent = metaParts.join(' · ');

        text.appendChild(titleSpan);
        text.appendChild(metaSpan);
        row.appendChild(poster);
        row.appendChild(text);

        row.addEventListener('mousedown', function (e) {
          e.preventDefault(); // prevent blur before click
          navigateTo(item.title);
        });

        dropdown.appendChild(row);
      });

      // "See all results" row
      var allRow = document.createElement('div');
      allRow.className = 'hero-suggest-row hero-suggest-all';
      allRow.setAttribute('role', 'option');
      allRow.textContent = 'See all results for "' + input.value.trim() + '"';
      allRow.addEventListener('mousedown', function (e) {
        e.preventDefault();
        navigateTo(input.value.trim());
      });
      dropdown.appendChild(allRow);

      dropdown.classList.add('open');
    }

    function setActive(idx) {
      var rows = dropdown.querySelectorAll('.hero-suggest-row');
      rows.forEach(function (r) { r.classList.remove('active'); });
      activeIdx = idx;
      if (idx >= 0 && idx < rows.length) rows[idx].classList.add('active');
    }

    async function fetchSuggestions(q) {
      try {
        var r = await fetch('/api/search/suggest?q=' + encodeURIComponent(q));
        if (!r.ok) return;
        var data = await r.json();
        if (input.value.trim() === q) renderDropdown(data.results || []);
      } catch { /* ignore */ }
    }

    input.addEventListener('input', function () {
      var q = input.value.trim();
      showClear(q.length > 0);
      clearTimeout(suggestTimer);
      if (q.length < 2) { closeDropdown(); return; }
      suggestTimer = setTimeout(function () { fetchSuggestions(q); }, 280);
    });

    input.addEventListener('keydown', function (e) {
      var rows = dropdown.querySelectorAll('.hero-suggest-row');
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActive(Math.min(activeIdx + 1, rows.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActive(Math.max(activeIdx - 1, -1));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (activeIdx >= 0 && activeIdx < suggestions.length) {
          navigateTo(suggestions[activeIdx].title);
        } else {
          var q = input.value.trim();
          if (q) navigateTo(q);
        }
      } else if (e.key === 'Escape') {
        closeDropdown();
        input.blur();
      }
    });

    input.addEventListener('blur', function () {
      // Delay so mousedown on dropdown fires first
      setTimeout(closeDropdown, 150);
    });

    if (clearBtn) {
      clearBtn.addEventListener('click', function () {
        input.value = '';
        showClear(false);
        closeDropdown();
        input.focus();
      });
    }

    // Close dropdown on outside click
    document.addEventListener('click', function (e) {
      if (!document.getElementById('hero-search-wrap')?.contains(e.target)) closeDropdown();
    });
  }

})();
