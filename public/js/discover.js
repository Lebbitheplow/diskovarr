(function () {
  'use strict';

  // ── State ──────────────────────────────────────────────────────────
  let state = {
    type: 'all',
    decade: '',
    minRating: 0,
    sort: 'rating',
    genres: new Set(),
    includeWatched: false,
    search: '',
    page: 1,
    totalPages: 1,
    totalResults: 0,
    loading: false,
  };

  const RATING_VALUES = [0, 5, 6, 7, 7.5, 8, 8.5, 9, 9.5, 10];

  // ── Init ───────────────────────────────────────────────────────────

  async function init() {
    await loadGenres();
    setupSearch();
    setupTypeChips();
    setupDecadeChips();
    setupRatingSlider();
    setupSort();
    setupIncludeWatched();
    fetchResults(true);
  }

  // ── Search ─────────────────────────────────────────────────────────

  function setupSearch() {
    const input = document.getElementById('filter-search');
    const clearBtn = document.getElementById('search-clear');
    if (!input) return;

    input.addEventListener('input', () => {
      state.search = input.value.trim();
      clearBtn.classList.toggle('visible', state.search.length > 0);
      fetchResults(true);
    });

    clearBtn.addEventListener('click', () => {
      input.value = '';
      state.search = '';
      clearBtn.classList.remove('visible');
      fetchResults(true);
      input.focus();
    });
  }

  // ── Genre loader ───────────────────────────────────────────────────

  async function loadGenres() {
    try {
      const data = await fetch('/api/discover/genres').then(r => r.json());
      const container = document.getElementById('filter-genres');
      container.innerHTML = '';
      data.genres.forEach(genre => {
        const btn = document.createElement('button');
        btn.className = 'genre-chip';
        btn.textContent = genre;
        btn.dataset.genre = genre.toLowerCase();
        btn.addEventListener('click', () => toggleGenre(btn, genre));
        container.appendChild(btn);
      });
    } catch (err) {
      document.getElementById('filter-genres').innerHTML =
        '<span class="genre-loading">Failed to load genres</span>';
    }
  }

  function toggleGenre(btn, genre) {
    const key = genre.toLowerCase();
    if (state.genres.has(key)) {
      state.genres.delete(key);
      btn.classList.remove('active');
    } else {
      state.genres.add(key);
      btn.classList.add('active');
    }
    updateClearGenresLink();
    fetchResults(true);
  }

  function updateClearGenresLink() {
    const el = document.getElementById('clear-genres');
    el.style.display = state.genres.size > 0 ? 'inline' : 'none';
  }

  document.getElementById('clear-genres').addEventListener('click', () => {
    state.genres.clear();
    document.querySelectorAll('.genre-chip.active').forEach(b => b.classList.remove('active'));
    updateClearGenresLink();
    fetchResults(true);
  });

  // ── Type chips ─────────────────────────────────────────────────────

  function setupTypeChips() {
    document.getElementById('filter-type').addEventListener('click', e => {
      const btn = e.target.closest('.chip');
      if (!btn) return;
      document.querySelectorAll('#filter-type .chip').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.type = btn.dataset.value;
      fetchResults(true);
    });
  }

  // ── Decade chips ───────────────────────────────────────────────────

  function setupDecadeChips() {
    document.getElementById('filter-decade').addEventListener('click', e => {
      const btn = e.target.closest('.chip');
      if (!btn) return;
      document.querySelectorAll('#filter-decade .chip').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.decade = btn.dataset.value;
      fetchResults(true);
    });
  }

  // ── Rating slider ──────────────────────────────────────────────────

  function setupRatingSlider() {
    const slider = document.getElementById('filter-rating');
    const label = document.getElementById('rating-value');

    function update() {
      const idx = parseInt(slider.value);
      const val = RATING_VALUES[idx];
      state.minRating = val;
      label.textContent = val === 0 ? 'Any' : val.toString();
    }

    slider.addEventListener('input', update);
    slider.addEventListener('change', () => fetchResults(true));
    update();
  }

  // ── Sort ───────────────────────────────────────────────────────────

  function setupSort() {
    const sel = document.getElementById('filter-sort');
    sel.addEventListener('change', () => {
      state.sort = sel.value;
      fetchResults(true);
    });
  }

  // ── Include watched ────────────────────────────────────────────────

  function setupIncludeWatched() {
    document.getElementById('filter-include-watched').addEventListener('change', e => {
      state.includeWatched = e.target.checked;
      fetchResults(true);
    });
  }

  // ── Clear all filters ──────────────────────────────────────────────

  window.clearAllFilters = function () {
    state.type = 'all';
    state.decade = '';
    state.minRating = 0;
    state.sort = 'rating';
    state.genres.clear();
    state.includeWatched = false;
    state.search = '';

    document.querySelectorAll('#filter-type .chip').forEach((b, i) => b.classList.toggle('active', i === 0));
    document.querySelectorAll('#filter-decade .chip').forEach((b, i) => b.classList.toggle('active', i === 0));
    document.querySelectorAll('.genre-chip').forEach(b => b.classList.remove('active'));
    document.getElementById('filter-rating').value = 0;
    document.getElementById('rating-value').textContent = 'Any';
    document.getElementById('filter-sort').value = 'rating';
    document.getElementById('filter-include-watched').checked = false;
    const searchInput = document.getElementById('filter-search');
    if (searchInput) { searchInput.value = ''; }
    const searchClear = document.getElementById('search-clear');
    if (searchClear) { searchClear.classList.remove('visible'); }
    updateClearGenresLink();
    fetchResults(true);
  };

  // ── Fetch & render ─────────────────────────────────────────────────

  let fetchDebounce = null;

  function fetchResults(reset) {
    clearTimeout(fetchDebounce);
    fetchDebounce = setTimeout(() => doFetch(reset), 120);
  }

  async function doFetch(reset) {
    if (state.loading) return;
    state.loading = true;

    if (reset) {
      state.page = 1;
      document.getElementById('discover-grid').innerHTML = buildSkeletons(8);
      document.getElementById('load-more-wrap').style.display = 'none';
    }

    const params = new URLSearchParams({
      type: state.type,
      decade: state.decade,
      minRating: state.minRating,
      sort: state.sort,
      genres: [...state.genres].join(','),
      includeWatched: state.includeWatched,
      page: state.page,
      q: state.search,
    });

    try {
      const data = await fetch('/api/discover?' + params).then(r => {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      });

      state.totalPages = data.pages;
      state.totalResults = data.total;

      const grid = document.getElementById('discover-grid');

      if (reset) grid.innerHTML = '';

      if (data.items.length === 0 && reset) {
        grid.innerHTML = `
          <div class="discover-empty">
            <div class="discover-empty-icon">◈</div>
            <p>No results match your filters</p>
          </div>`;
      } else {
        const fragment = document.createDocumentFragment();
        data.items.forEach(item => fragment.appendChild(renderCard(item)));
        grid.appendChild(fragment);
      }

      // Results header
      const header = document.getElementById('results-header');
      const countEl = document.getElementById('results-count');
      header.style.display = 'flex';
      countEl.textContent = state.totalResults.toLocaleString() + ' result' + (state.totalResults !== 1 ? 's' : '');

      // Load more
      const loadWrap = document.getElementById('load-more-wrap');
      const loadBtn = document.getElementById('btn-load-more');
      if (state.page < state.totalPages) {
        loadWrap.style.display = 'block';
        loadBtn.disabled = false;
        loadBtn.textContent = 'Load more';
      } else {
        loadWrap.style.display = 'none';
      }
    } catch (err) {
      console.error('Discover fetch error:', err);
      if (reset) {
        document.getElementById('discover-grid').innerHTML = `
          <div class="discover-empty">
            <div class="discover-empty-icon">◈</div>
            <p>Failed to load results. Please try again.</p>
          </div>`;
      }
    } finally {
      state.loading = false;
    }
  }

  window.loadMore = function () {
    state.page++;
    doFetch(false);
  };

  // ── Skeleton ───────────────────────────────────────────────────────

  function buildSkeletons(n) {
    return Array.from({ length: n }, () => `
      <div class="card card-skeleton">
        <div class="skeleton-poster shimmer"></div>
        <div class="skeleton-info">
          <div class="skeleton-line shimmer" style="width:75%"></div>
          <div class="skeleton-line shimmer" style="width:45%"></div>
        </div>
      </div>`).join('');
  }

  // Boot
  init();
})();
