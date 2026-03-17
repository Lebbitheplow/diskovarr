(function () {
  'use strict';


  var cfg = window.SEARCH_CONFIG || { services: {}, hasAnyService: false, query: '' };

  // ── State ──────────────────────────────────────────────────────────────────
  var state = {
    query: cfg.query || '',
    page: 1,
    totalPages: 1,
    loading: false,
  };

  // ── Toast ──────────────────────────────────────────────────────────────────
  function showToast(msg, type) {
    var t = document.getElementById('search-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'search-toast';
      t.className = 'wl-toast';
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.className = 'wl-toast ' + (type === 'error' ? 'wl-toast-remove' : 'wl-toast-add') + ' wl-toast-show';
    clearTimeout(t._timer);
    t._timer = setTimeout(function () { t.classList.remove('wl-toast-show'); }, 4000);
  }

  // ── Inline search form ─────────────────────────────────────────────────────
  function initPageForm() {
    var form = document.getElementById('search-page-form');
    var input = document.getElementById('search-page-input');
    var clearBtn = document.getElementById('search-page-clear');

    if (clearBtn) {
      clearBtn.addEventListener('click', function () {
        input.value = '';
        window.location.href = '/search';
      });
    }

    if (form) {
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var q = input.value.trim();
        if (q) window.location.href = '/search?q=' + encodeURIComponent(q);
      });
    }
  }

  // ── Request dialog ─────────────────────────────────────────────────────────
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
    var hasDirect = isMovie ? s.radarr : s.sonarr;
    var directSvc = isMovie ? 'radarr' : 'sonarr';
    var directName = isMovie ? 'Radarr' : 'Sonarr';
    subEl.textContent = (item.year || '') + (item.year ? ' · ' : '') + (isMovie ? 'Movie' : 'TV Show');

    var hasBothSides = hasOverseerr && hasDirect;
    var defaultSvc = hasBothSides
      ? (s.defaultService === 'direct' ? directSvc : 'overseerr')
      : (hasOverseerr ? 'overseerr' : directSvc);

    actionsEl.innerHTML = '';

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
      var altSvc = defaultSvc === 'overseerr' ? directSvc : 'overseerr';
      var altName = defaultSvc === 'overseerr' ? directName : 'Overseerr';
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
      if (!r.ok || !data.success) throw new Error(data.error || 'Request failed');
      item.isRequested = true;
      if (data.pending) {
        btns.forEach(function (btn) {
          btn.textContent = 'Pending Approval';
          btn.disabled = true;
          btn.classList.add('btn-request-sent');
          btn.style.background = 'rgba(255,170,0,0.15)';
          btn.style.color = '#ffaa00';
        });
        showToast(item.title + ' submitted for approval');
      } else {
        btns.forEach(function (btn) {
          btn.textContent = 'Requested ✓';
          btn.disabled = true;
          btn.classList.add('btn-request-sent');
        });
        showToast('Requested: ' + item.title + ' via ' + service.charAt(0).toUpperCase() + service.slice(1));
      }
    } catch (err) {
      btns.forEach(function (btn) {
        btn.textContent = 'Request';
        btn.disabled = false;
        btn.classList.remove('btn-request-sent');
      });
      showToast('Request failed: ' + err.message, 'error');
    }
  }

  // ── Detail modal ───────────────────────────────────────────────────────────
  var modalCurrentItem = null;

  async function openModal(basicItem) {
    var modal = document.getElementById('detail-modal');
    if (!modal) return;

    // Show immediately with basic info
    renderModalContent(basicItem, true);
    modal.classList.add('open');
    modal.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
    modalCurrentItem = basicItem;

    // Async-fetch full details
    try {
      var r = await fetch('/api/search/details?tmdbId=' + basicItem.tmdbId + '&type=' + basicItem.mediaType);
      if (!r.ok) return;
      var full = await r.json();
      // Only update if same item still open
      if (modalCurrentItem && modalCurrentItem.tmdbId === basicItem.tmdbId) {
        renderModalContent(full, false);
        modalCurrentItem = full;
      }
    } catch { /* leave basic info showing */ }
  }

  function renderModalContent(item, isBasic) {
    // Hero
    var hero = document.getElementById('detail-modal-hero');
    var modalBody = document.querySelector('.detail-modal-body');
    var modalInfo = document.querySelector('.detail-modal-info');
    if (hero) {
      var backdrop = item.backdropUrl || null;
      if (backdrop) {
        hero.style.backgroundImage = 'url(' + backdrop + ')';
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

    // Trailer (only set up on first open to avoid flicker)
    if (!isBasic) {
      var trailerEl = document.getElementById('detail-modal-trailer');
      if (trailerEl && item.tmdbId) {
        fetch('/api/trailer?tmdbId=' + item.tmdbId + '&mediaType=' + item.mediaType)
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
    if (item.inLibrary) {
      metaParts.push(item.mediaType === 'movie' ? 'Movie' : (item.isAnime ? 'Anime' : 'TV Show'));
    } else {
      metaParts.push(item.mediaType === 'movie' ? 'Movie' : 'TV Show');
    }
    if (item.voteAverage && item.voteAverage > 0) metaParts.push('★ ' + item.voteAverage.toFixed(1));
    var metaEl = document.getElementById('detail-modal-meta');
    metaEl.textContent = metaParts.join(' · ');
    if (item.contentRating) {
      var badge = document.createElement('span');
      badge.className = 'content-rating-badge rating-' + item.contentRating.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
      badge.textContent = item.contentRating;
      metaEl.appendChild(document.createTextNode(' · '));
      metaEl.appendChild(badge);
    }

    // Library badge on meta
    if (item.inLibrary) {
      var libBadge = document.createElement('span');
      libBadge.className = 'search-in-library-badge';
      libBadge.textContent = 'In Library';
      metaEl.insertBefore(document.createTextNode(' '), metaEl.firstChild);
      metaEl.prepend(libBadge);
    }

    // Reasons (search won't have these)
    var reasonsEl = document.getElementById('detail-modal-reasons');
    reasonsEl.innerHTML = '';

    // Genres
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

    // Credits (only when full details loaded)
    var credEl = document.getElementById('detail-modal-credits');
    credEl.innerHTML = '';
    if (!isBasic) {
      if (item.directors && item.directors.length > 0) {
        var label = item.mediaType === 'movie' ? 'Director' : 'Created by';
        var d = document.createElement('div');
        d.className = 'detail-credit-row';
        d.innerHTML = '<span class="detail-credit-label">' + label + ':</span> ' + escHtml(item.directors.join(', '));
        credEl.appendChild(d);
      }
      if (item.cast && item.cast.length > 0) {
        var c = document.createElement('div');
        c.className = 'detail-credit-row';
        c.innerHTML = '<span class="detail-credit-label">Cast:</span> ' + escHtml(item.cast.slice(0, 6).join(', '));
        credEl.appendChild(c);
      }
      if (item.studio) {
        var s = document.createElement('div');
        s.className = 'detail-credit-row';
        var sLabel = item.mediaType === 'tv' ? 'Network' : 'Studio';
        s.innerHTML = '<span class="detail-credit-label">' + sLabel + ':</span> ' + escHtml(item.studio);
        credEl.appendChild(s);
      }
    }

    // Actions
    var actEl = document.getElementById('detail-modal-actions');
    actEl.innerHTML = '';

    if (item.inLibrary) {
      // ── Library item actions ──
      var wlBtn = document.createElement('button');
      wlBtn.className = 'modal-btn modal-btn-watchlist' + (item.isInWatchlist ? ' in-watchlist' : '');
      wlBtn.setAttribute('data-rating-key', item.ratingKey);
      wlBtn.textContent = item.isInWatchlist ? '◈ In Watchlist' : '+ Watchlist';
      wlBtn.addEventListener('click', function () {
        var inWl = wlBtn.classList.contains('in-watchlist');
        if (inWl) {
          if (window.watchlistRemove) window.watchlistRemove(item.ratingKey, wlBtn);
          else {
            fetch('/api/watchlist/remove', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ratingKey: item.ratingKey }) });
            wlBtn.classList.remove('in-watchlist');
            wlBtn.textContent = '+ Watchlist';
            item.isInWatchlist = false;
          }
        } else {
          if (window.watchlistAdd) window.watchlistAdd(item.ratingKey, wlBtn);
          else {
            fetch('/api/watchlist/add', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ratingKey: item.ratingKey }) });
            wlBtn.classList.add('in-watchlist');
            wlBtn.textContent = '◈ In Watchlist';
            item.isInWatchlist = true;
          }
        }
      });
      actEl.appendChild(wlBtn);


      // Cast to TV
      if (!isBasic && item.ratingKey) {
        var castWrap = document.createElement('div');
        castWrap.className = 'modal-cast-wrap';
        var castBtn = document.createElement('button');
        castBtn.className = 'modal-btn modal-btn-cast';
        castBtn.textContent = '▶ Cast to TV';
        var clientPicker = document.createElement('div');
        clientPicker.className = 'modal-cast-picker';
        castWrap.appendChild(castBtn);
        castWrap.appendChild(clientPicker);
        actEl.appendChild(castWrap);

        castBtn.addEventListener('click', async function () {
          clientPicker.innerHTML = '';
          castBtn.textContent = '…';
          castBtn.disabled = true;
          try {
            var cr = await fetch('/api/clients');
            var cd = await cr.json();
            castBtn.textContent = '▶ Cast to TV';
            castBtn.disabled = false;
            if (!cd.clients || cd.clients.length === 0) {
              clientPicker.innerHTML = '<span class="cast-no-clients">No Plex clients found.<br>Open your Plex app on your TV first.</span>';
            } else {
              cd.clients.forEach(function (client) {
                var btn = document.createElement('button');
                btn.className = 'cast-client-btn';
                btn.textContent = client.name;
                btn.addEventListener('click', async function () {
                  btn.textContent = 'Casting…';
                  btn.disabled = true;
                  try {
                    var pr = await fetch('/api/cast', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ ratingKey: item.ratingKey, clientId: client.machineIdentifier }),
                    });
                    var pd = await pr.json();
                    if (!pr.ok || pd.error) { showToast(pd.error || 'Cast failed', 'error'); btn.textContent = client.name; btn.disabled = false; }
                    else { showToast('Casting to ' + client.name); clientPicker.innerHTML = ''; }
                  } catch (err) { showToast(err.message, 'error'); btn.textContent = client.name; btn.disabled = false; }
                });
                clientPicker.appendChild(btn);
              });
            }
          } catch {
            castBtn.textContent = '▶ Cast to TV';
            castBtn.disabled = false;
          }
        });
      }
    } else {
      // ── Non-library item actions ──
      if (cfg.hasAnyService) {
        var reqBtn = document.createElement('button');
        reqBtn.className = 'btn-request' + (item.isRequested ? ' btn-request-sent' : '');
        reqBtn.setAttribute('data-request-tmdb', String(item.tmdbId));
        reqBtn.textContent = item.isRequested ? 'Requested ✓' : 'Request';
        reqBtn.disabled = item.isRequested;
        reqBtn.addEventListener('click', function () {
          if (!item.isRequested) {
            closeModal();
            openRequestDialog(item);
          }
        });
        actEl.appendChild(reqBtn);
      }

      var tmdbLink = document.createElement('a');
      tmdbLink.className = 'btn-tmdb-link';
      tmdbLink.href = 'https://www.themoviedb.org/' + item.mediaType + '/' + item.tmdbId;
      tmdbLink.target = '_blank';
      tmdbLink.rel = 'noopener';
      tmdbLink.textContent = 'View on TMDB';
      actEl.appendChild(tmdbLink);
    }
  }

  function closeModal() {
    var modal = document.getElementById('detail-modal');
    modal.classList.remove('open');
    modal.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
    var trailerEl = document.getElementById('detail-modal-trailer');
    if (trailerEl) { trailerEl.innerHTML = ''; trailerEl.classList.remove('active'); }
    modalCurrentItem = null;
  }

  // ── Card rendering ─────────────────────────────────────────────────────────
  function escHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function renderCard(item) {
    var card = document.createElement('div');
    card.className = 'card explore-card search-card';

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
      var ph = document.createElement('div');
      ph.className = 'card-poster-placeholder';
      ph.textContent = (item.title || '?').charAt(0);
      posterWrap.appendChild(ph);
    }

    // Badge
    var badge = document.createElement('span');
    if (item.inLibrary) {
      badge.className = 'badge-in-library';
      badge.textContent = 'In Library';
    } else {
      badge.className = 'badge-not-in-library' + (item.isRequested ? ' badge-requested' : '');
      badge.textContent = item.isRequested ? 'Requested' : 'Not in Library';
    }
    posterWrap.appendChild(badge);

    // Overlay (only for non-library items — library items use watchlist.js on the card)
    var overlay = document.createElement('div');
    overlay.className = 'card-overlay';
    var overlayActions = document.createElement('div');
    overlayActions.className = 'card-overlay-actions';

    if (item.inLibrary) {
      var wlOverlayBtn = document.createElement('button');
      wlOverlayBtn.className = 'btn-icon btn-watchlist-toggle' + (item.isInWatchlist ? ' in-watchlist' : '');
      wlOverlayBtn.setAttribute('data-rating-key', item.ratingKey);
      wlOverlayBtn.textContent = item.isInWatchlist ? '◈' : '+';
      wlOverlayBtn.title = item.isInWatchlist ? 'Remove from Watchlist' : 'Add to Watchlist';
      wlOverlayBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        var inWl = wlOverlayBtn.classList.contains('in-watchlist');
        if (inWl) {
          fetch('/api/watchlist/remove', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ratingKey: item.ratingKey }) });
          wlOverlayBtn.classList.remove('in-watchlist');
          wlOverlayBtn.textContent = '+';
          wlOverlayBtn.title = 'Add to Watchlist';
          item.isInWatchlist = false;
        } else {
          fetch('/api/watchlist/add', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ratingKey: item.ratingKey }) });
          wlOverlayBtn.classList.add('in-watchlist');
          wlOverlayBtn.textContent = '◈';
          wlOverlayBtn.title = 'Remove from Watchlist';
          item.isInWatchlist = true;
          showToast('Added to Watchlist');
        }
      });
      overlayActions.appendChild(wlOverlayBtn);
    } else if (cfg.hasAnyService) {
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

    overlay.appendChild(overlayActions);
    posterWrap.appendChild(overlay);
    card.appendChild(posterWrap);

    // Card info
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

    card.appendChild(info);

    card.addEventListener('click', function () { openModal(item); });
    return card;
  }

  // ── Fetch & render ─────────────────────────────────────────────────────────
  async function doFetch(reset) {
    if (state.loading || !state.query) return;
    state.loading = true;

    var grid = document.getElementById('search-grid');

    if (reset) {
      state.page = 1;
      grid.innerHTML = buildSkeletons(12);
      document.getElementById('search-load-more-wrap').style.display = 'none';
    }

    try {
      var params = new URLSearchParams({ q: state.query, page: state.page });
      var r = await fetch('/api/search?' + params);
      if (!r.ok) {
        var err = await r.json();
        if (err.error === 'no_tmdb_key') {
          grid.innerHTML = '<div class="search-empty" style="grid-column:1/-1"><p>TMDB API key not configured. Ask your admin to add one in Admin → Connections.</p></div>';
        } else {
          grid.innerHTML = '<div class="search-empty" style="grid-column:1/-1"><p>Search failed. Please try again.</p></div>';
        }
        return;
      }
      var data = await r.json();
      state.totalPages = data.pages;

      if (reset) grid.innerHTML = '';

      if (data.results.length === 0 && reset) {
        grid.innerHTML = '<div class="search-empty" style="grid-column:1/-1"><p>No results found for "' + escHtml(state.query) + '".</p></div>';
      } else {
        var frag = document.createDocumentFragment();
        data.results.forEach(function (item) { frag.appendChild(renderCard(item)); });
        grid.appendChild(frag);
      }

      // Results header
      var header = document.getElementById('search-results-header');
      var countEl = document.getElementById('search-results-count');
      if (reset) {
        header.style.display = 'block';
        countEl.textContent = data.total.toLocaleString() + ' result' + (data.total !== 1 ? 's' : '') + ' for "' + state.query + '"';
      }

      // Load more
      var loadWrap = document.getElementById('search-load-more-wrap');
      var loadBtn = document.getElementById('btn-search-load-more');
      if (state.page < state.totalPages) {
        loadWrap.style.display = 'block';
        loadBtn.disabled = false;
        loadBtn.textContent = 'Load more';
      } else {
        loadWrap.style.display = 'none';
      }
    } catch (err) {
      console.error('search fetch error:', err);
      if (reset) {
        grid.innerHTML = '<div class="search-empty" style="grid-column:1/-1"><p>Search failed. Please try again.</p></div>';
      }
    } finally {
      state.loading = false;
    }
  }

  function buildSkeletons(n) {
    return Array.from({ length: n }, function () {
      return '<div class="card card-skeleton"><div class="skeleton-poster shimmer"></div><div class="skeleton-info"><div class="skeleton-line shimmer" style="width:75%"></div><div class="skeleton-line shimmer" style="width:45%"></div></div></div>';
    }).join('');
  }

  // ── Load more ──────────────────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', function () {
    var loadBtn = document.getElementById('btn-search-load-more');
    if (loadBtn) {
      loadBtn.addEventListener('click', function () {
        state.page++;
        doFetch(false);
      });
    }
  });

  // ── Modal & dialog event listeners ────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', function () {
    var modal = document.getElementById('detail-modal');
    if (modal) {
      modal.addEventListener('click', function (e) { if (e.target === modal) closeModal(); });
      document.getElementById('detail-modal-close').addEventListener('click', closeModal);
    }
    var dialog = document.getElementById('request-dialog');
    if (dialog) {
      dialog.addEventListener('click', function (e) { if (e.target === dialog) closeRequestDialog(); });
    }
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { closeModal(); closeRequestDialog(); }
    });

    initPageForm();

    if (state.query) doFetch(true);
  });

})();
