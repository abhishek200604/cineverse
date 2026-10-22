/**
 * ============================================================================
 * CINEVERSE - Frontend Application Engine
 * Pure Vanilla JavaScript (ES6+) for AWS S3 Static Website Hosting
 * Base URL: https://jtajs6rkjk.execute-api.ap-south-1.amazonaws.com
 * Region: ap-south-1 (Mumbai)
 * ============================================================================
 */

(function () {
  'use strict';

  // --- Configuration ---
  const DEFAULT_AWS_BASE_URL = 'https://jtajs6rkjk.execute-api.ap-south-1.amazonaws.com';
  
  // Auto-detect local dev proxy if running on dev-server.js (port 3000)
  const detectedBaseUrl = (window.location.hostname === 'localhost' && window.location.port === '3000')
    ? `${window.location.origin}/aws-proxy`
    : (localStorage.getItem('cineverse_custom_api') || DEFAULT_AWS_BASE_URL);

  const CONFIG = {
    API_BASE_URL: detectedBaseUrl,
    DEFAULT_BASE_URL: DEFAULT_AWS_BASE_URL,
    REQUEST_TIMEOUT_MS: 15000,
    STORAGE_KEY_EMAIL: 'cineverse_last_email',
    STORAGE_KEY_RECENT_BOOKING: 'cineverse_recent_booking',
    POSTERS: {
      'Avengers: Endgame': 'https://image.tmdb.org/t/p/w500/or06FN3Dka5tukK1e9sl16pB3iy.jpg',
      'Interstellar': 'https://image.tmdb.org/t/p/w500/gEU2QniE6E77NI6lCU6MxlNBvIx.jpg'
    }
  };

  // --- Global Application State ---
  const state = {
    shows: [],
    selectedShow: null,
    currentSeats: [],
    selectedSeats: new Map(), // Map<seat_id, seatObject>
    userTickets: [],
    activeFormatFilter: 'all',
    searchQuery: '',
    isBookingInProgress: false,
    cancelTarget: null // { show_id, seat_id, movie }
  };

  // ============================================================================
  // Reusable API Client Helper
  // ============================================================================
  const apiClient = {
    async request(endpoint, options = {}) {
      const url = `${CONFIG.API_BASE_URL}${endpoint}`;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), CONFIG.REQUEST_TIMEOUT_MS);

      const defaultHeaders = {
        'Accept': 'application/json'
      };

      if (options.body && typeof options.body === 'string') {
        defaultHeaders['Content-Type'] = 'application/json';
      }

      const mergedOptions = {
        ...options,
        signal: controller.signal,
        headers: {
          ...defaultHeaders,
          ...(options.headers || {})
        }
      };

      try {
        const response = await fetch(url, mergedOptions);
        clearTimeout(timeoutId);

        // Attempt to parse JSON response
        let data = null;
        const text = await response.text();
        if (text) {
          try {
            data = JSON.parse(text);
          } catch (e) {
            data = { raw: text };
          }
        }

        if (!response.ok) {
          const errorMessage = (data && (data.error || data.message)) || `HTTP ${response.status} ${response.statusText}`;
          const error = new Error(errorMessage);
          error.status = response.status;
          error.data = data;
          throw error;
        }

        return data;
      } catch (err) {
        clearTimeout(timeoutId);

        if (err.name === 'AbortError') {
          const timeoutErr = new Error(`Request timed out after ${CONFIG.REQUEST_TIMEOUT_MS / 1000}s. AWS backend may be experiencing latency.`);
          timeoutErr.status = 408;
          throw timeoutErr;
        }

        // Detect potential CORS or Network drop
        if (err.name === 'TypeError' && err.message.toLowerCase().includes('fetch')) {
          const corsErr = new Error(`Network or CORS error connecting to AWS API Gateway. Ensure CORS headers are deployed.`);
          corsErr.isCorsError = true;
          throw corsErr;
        }

        throw err;
      }
    },

    get(endpoint) {
      return this.request(endpoint, { method: 'GET' });
    },

    post(endpoint, payload) {
      return this.request(endpoint, {
        method: 'POST',
        body: JSON.stringify(payload)
      });
    },

    delete(endpoint) {
      return this.request(endpoint, { method: 'DELETE' });
    }
  };

  // ============================================================================
  // UI Helpers & Toast Notification System
  // ============================================================================
  const UI = {
    toastContainer: document.getElementById('toast-container'),

    showToast(message, type = 'info', title = null, duration = 5000) {
      if (!this.toastContainer) return;

      const toast = document.createElement('div');
      toast.className = `toast toast-${type}`;
      toast.setAttribute('role', 'alert');

      const icons = {
        success: '✓',
        error: '✕',
        warning: '⚠️',
        info: 'ℹ️'
      };

      const iconEl = document.createElement('div');
      iconEl.className = 'toast-icon';
      iconEl.textContent = icons[type] || 'ℹ️';

      const contentEl = document.createElement('div');
      contentEl.className = 'toast-content';

      if (title) {
        const titleEl = document.createElement('div');
        titleEl.className = 'toast-title';
        titleEl.textContent = title;
        contentEl.appendChild(titleEl);
      }

      const msgEl = document.createElement('div');
      msgEl.className = 'toast-msg';
      msgEl.textContent = message;
      contentEl.appendChild(msgEl);

      const closeBtn = document.createElement('button');
      closeBtn.className = 'toast-close';
      closeBtn.setAttribute('aria-label', 'Close toast');
      closeBtn.innerHTML = '&times;';
      closeBtn.onclick = () => {
        toast.classList.add('toast-hiding');
        setTimeout(() => toast.remove(), 250);
      };

      toast.appendChild(iconEl);
      toast.appendChild(contentEl);
      toast.appendChild(closeBtn);
      this.toastContainer.appendChild(toast);

      if (duration > 0) {
        setTimeout(() => {
          if (toast.isConnected) {
            toast.classList.add('toast-hiding');
            setTimeout(() => toast.remove(), 250);
          }
        }, duration);
      }
    },

    formatCurrency(amount) {
      return '₹' + Number(amount || 0).toLocaleString('en-IN');
    },

    formatDate(dateStr) {
      if (!dateStr) return '';
      try {
        const d = new Date(dateStr);
        if (isNaN(d.getTime())) return dateStr;
        return d.toLocaleDateString('en-US', {
          weekday: 'short',
          month: 'short',
          day: 'numeric',
          year: 'numeric'
        });
      } catch {
        return dateStr;
      }
    },

    sanitizeText(str) {
      if (!str) return '';
      const div = document.createElement('div');
      div.textContent = str;
      return div.textContent;
    }
  };

  // ============================================================================
  // Movies & Shows Feed Controller (GET /shows)
  // ============================================================================
  const MoviesController = {
    container: document.getElementById('movies-container'),
    skeleton: document.getElementById('movies-skeleton'),
    errorCard: document.getElementById('movies-error'),
    emptyCard: document.getElementById('movies-empty'),
    errorMsg: document.getElementById('movies-error-msg'),
    searchInput: document.getElementById('movie-search-input'),
    searchClearBtn: document.getElementById('search-clear-btn'),
    refreshBtn: document.getElementById('btn-refresh-shows'),
    retryBtn: document.getElementById('btn-retry-shows'),
    resetFiltersBtn: document.getElementById('btn-reset-filters'),
    corsGuidanceBtn: document.getElementById('btn-show-cors-guidance'),

    async loadShows() {
      this.showLoading();
      try {
        const data = await apiClient.get('/shows');
        if (data && Array.isArray(data.shows)) {
          state.shows = data.shows;
          this.render();
          InspectorController.updateEndpointStatus('shows', true, `${data.shows.length} shows loaded`);
          BackendStatusController.setLive(true);
        } else {
          throw new Error('Invalid format returned by GET /shows');
        }
      } catch (err) {
        console.error('Failed to load shows:', err);
        this.showError(err);
        InspectorController.updateEndpointStatus('shows', false, err.message);
        BackendStatusController.setLive(false, err.message);
      }
    },

    showLoading() {
      if (this.skeleton) this.skeleton.classList.remove('hidden');
      if (this.container) this.container.classList.add('hidden');
      if (this.errorCard) this.errorCard.classList.add('hidden');
      if (this.emptyCard) this.emptyCard.classList.add('hidden');
    },

    showError(err) {
      if (this.skeleton) this.skeleton.classList.add('hidden');
      if (this.container) this.container.classList.add('hidden');
      if (this.emptyCard) this.emptyCard.classList.add('hidden');
      if (this.errorCard) {
        this.errorCard.classList.remove('hidden');
        if (this.errorMsg) {
          if (err.isCorsError) {
            this.errorMsg.textContent = 'Browser blocked request due to CORS policy. AWS API Gateway /shows requires Access-Control-Allow-Origin header.';
          } else {
            this.errorMsg.textContent = err.message || 'Unable to communicate with AWS API Gateway.';
          }
        }
      }
      UI.showToast(err.message, 'error', 'API Connection Error');
    },

    getFilteredShows() {
      let filtered = [...state.shows];

      if (state.activeFormatFilter !== 'all') {
        filtered = filtered.filter(show => 
          (show.format || '').toLowerCase() === state.activeFormatFilter.toLowerCase()
        );
      }

      if (state.searchQuery.trim()) {
        const query = state.searchQuery.toLowerCase().trim();
        filtered = filtered.filter(show => 
          (show.movie || '').toLowerCase().includes(query) ||
          (`screen ${show.screen || ''}`).toLowerCase().includes(query) ||
          (show.format || '').toLowerCase().includes(query)
        );
      }

      return filtered;
    },

    render() {
      if (this.skeleton) this.skeleton.classList.add('hidden');
      if (this.errorCard) this.errorCard.classList.add('hidden');

      const filteredShows = this.getFilteredShows();

      if (!filteredShows.length) {
        if (this.container) this.container.classList.add('hidden');
        if (this.emptyCard) this.emptyCard.classList.remove('hidden');
        return;
      }

      if (this.emptyCard) this.emptyCard.classList.add('hidden');
      if (this.container) {
        this.container.classList.remove('hidden');
        this.container.innerHTML = '';

        filteredShows.forEach(show => {
          const card = this.createMovieCard(show);
          this.container.appendChild(card);
        });
      }
    },

    createMovieCard(show) {
      const card = document.createElement('article');
      card.className = 'movie-card';
      card.setAttribute('data-show-id', show.show_id);

      // Poster wrapping
      const posterWrap = document.createElement('div');
      posterWrap.className = 'movie-poster-wrap';

      const posterImg = document.createElement('img');
      posterImg.className = 'movie-poster';
      posterImg.alt = `${show.movie} Poster`;
      posterImg.loading = 'lazy';

      const posterSrc = CONFIG.POSTERS[show.movie] || '';
      if (posterSrc) {
        posterImg.src = posterSrc;
        posterImg.onerror = () => {
          posterWrap.innerHTML = '';
          posterWrap.appendChild(this.createFallbackPoster(show.movie));
        };
        posterWrap.appendChild(posterImg);
      } else {
        posterWrap.appendChild(this.createFallbackPoster(show.movie));
      }

      // Format Tag & Screen Badge
      const formatTag = document.createElement('span');
      formatTag.className = 'movie-format-tag';
      formatTag.textContent = show.format || 'STANDARD';
      posterWrap.appendChild(formatTag);

      const screenBadge = document.createElement('span');
      screenBadge.className = 'movie-screen-badge';
      screenBadge.textContent = `SCREEN ${show.screen || '1'}`;
      posterWrap.appendChild(screenBadge);

      // Card Body
      const body = document.createElement('div');
      body.className = 'movie-card-body';

      const title = document.createElement('h3');
      title.className = 'movie-card-title';
      title.textContent = show.movie;

      // Meta info (Date & Time)
      const metaRow = document.createElement('div');
      metaRow.className = 'movie-meta-row';

      const dateItem = document.createElement('span');
      dateItem.className = 'meta-icon-item';
      dateItem.innerHTML = `📅 <span>${UI.formatDate(show.date)}</span>`;

      const timeItem = document.createElement('span');
      timeItem.className = 'meta-icon-item';
      timeItem.innerHTML = `⏰ <span>${UI.sanitizeText(show.time)}</span>`;

      metaRow.appendChild(dateItem);
      metaRow.appendChild(timeItem);

      // Seating tiers preview
      const tiersPreview = document.createElement('div');
      tiersPreview.className = 'movie-tiers-preview';

      const tiersLabel = document.createElement('div');
      tiersLabel.className = 'tiers-label';
      tiersLabel.textContent = 'Seating Categories & Prices:';
      tiersPreview.appendChild(tiersLabel);

      const tiersPills = document.createElement('div');
      tiersPills.className = 'tiers-pills';

      if (show.prices && typeof show.prices === 'object') {
        Object.entries(show.prices).forEach(([tier, price]) => {
          const pill = document.createElement('span');
          pill.className = `tier-pill ${tier.toLowerCase()}`;
          pill.textContent = `${tier}: ₹${price}`;
          tiersPills.appendChild(pill);
        });
      }
      tiersPreview.appendChild(tiersPills);

      // Card Action Footer
      const footer = document.createElement('div');
      footer.className = 'movie-card-footer';

      const bookBtn = document.createElement('button');
      bookBtn.className = 'btn btn-primary';
      bookBtn.type = 'button';
      bookBtn.setAttribute('aria-label', `Select seats for ${show.movie} on Screen ${show.screen}`);
      bookBtn.innerHTML = `
        <span>Select Seats</span>
        <svg viewBox="0 0 20 20" fill="currentColor" width="16" height="16">
          <path fill-rule="evenodd" d="M10.293 3.293a1 1 0 011.414 0l6 6a1 1 0 010 1.414l-6 6a1 1 0 01-1.414-1.414L14.586 11H3a1 1 0 110-2h11.586l-4.293-4.293a1 1 0 010-1.414z" clip-rule="evenodd"/>
        </svg>
      `;

      bookBtn.addEventListener('click', () => {
        SeatModalController.open(show);
      });

      footer.appendChild(bookBtn);

      body.appendChild(title);
      body.appendChild(metaRow);
      body.appendChild(tiersPreview);
      body.appendChild(footer);

      card.appendChild(posterWrap);
      card.appendChild(body);

      return card;
    },

    createFallbackPoster(title) {
      const fallback = document.createElement('div');
      fallback.className = 'fallback-poster';
      fallback.innerHTML = `
        <div class="fallback-poster-icon">🎬</div>
        <div class="fallback-poster-text">${UI.sanitizeText(title)}</div>
      `;
      return fallback;
    },

    initEvents() {
      // Search input with debounce
      let debounceTimeout = null;
      if (this.searchInput) {
        this.searchInput.addEventListener('input', (e) => {
          clearTimeout(debounceTimeout);
          const val = e.target.value;
          if (this.searchClearBtn) {
            this.searchClearBtn.classList.toggle('hidden', !val);
          }
          debounceTimeout = setTimeout(() => {
            state.searchQuery = val;
            this.render();
          }, 200);
        });
      }

      if (this.searchClearBtn) {
        this.searchClearBtn.addEventListener('click', () => {
          this.searchInput.value = '';
          this.searchClearBtn.classList.add('hidden');
          state.searchQuery = '';
          this.render();
          this.searchInput.focus();
        });
      }

      // Format Filter Chips
      const filterChips = document.querySelectorAll('.filter-chip');
      filterChips.forEach(chip => {
        chip.addEventListener('click', () => {
          filterChips.forEach(c => c.classList.remove('active'));
          chip.classList.add('active');
          state.activeFormatFilter = chip.getAttribute('data-filter') || 'all';
          this.render();
        });
      });

      if (this.refreshBtn) {
        this.refreshBtn.addEventListener('click', () => this.loadShows());
      }
      if (this.retryBtn) {
        this.retryBtn.addEventListener('click', () => this.loadShows());
      }
      if (this.resetFiltersBtn) {
        this.resetFiltersBtn.addEventListener('click', () => {
          state.searchQuery = '';
          state.activeFormatFilter = 'all';
          if (this.searchInput) this.searchInput.value = '';
          if (this.searchClearBtn) this.searchClearBtn.classList.add('hidden');
          filterChips.forEach(c => c.classList.toggle('active', c.getAttribute('data-filter') === 'all'));
          this.render();
        });
      }
      if (this.corsGuidanceBtn) {
        this.corsGuidanceBtn.addEventListener('click', () => {
          InspectorController.open();
        });
      }
    }
  };

  // ============================================================================
  // Interactive Seat Selection Controller (GET /seats?show_id={SHOW_ID})
  // ============================================================================
  const SeatModalController = {
    modal: document.getElementById('seat-modal'),
    closeBtn: document.getElementById('btn-close-seat-modal'),
    titleEl: document.getElementById('seat-modal-title'),
    screenPill: document.getElementById('seat-modal-screen'),
    formatPill: document.getElementById('seat-modal-format'),
    dateEl: document.getElementById('seat-modal-date'),
    timeEl: document.getElementById('seat-modal-time'),
    pricingLegend: document.getElementById('seat-pricing-legend'),
    matrixContainer: document.getElementById('seats-matrix'),
    loader: document.getElementById('seat-loader'),
    errorBanner: document.getElementById('seat-error-msg'),
    refreshBtn: document.getElementById('btn-refresh-seats'),
    retryBtn: document.getElementById('btn-retry-seats'),
    selectedCountEl: document.getElementById('selected-count'),
    selectedChipsWrap: document.getElementById('selected-seats-chips'),
    totalPriceEl: document.getElementById('selected-total-price'),
    clearBtn: document.getElementById('btn-clear-selection'),
    proceedBtn: document.getElementById('btn-proceed-checkout'),

    async open(show) {
      state.selectedShow = show;
      state.selectedSeats.clear();
      this.updateSelectionSummary();

      // Populate Show Details in Modal
      if (this.titleEl) this.titleEl.textContent = show.movie;
      if (this.screenPill) this.screenPill.textContent = `Screen ${show.screen || '1'}`;
      if (this.formatPill) this.formatPill.textContent = show.format || 'STANDARD';
      if (this.dateEl) this.dateEl.textContent = UI.formatDate(show.date);
      if (this.timeEl) this.timeEl.textContent = show.time || '';

      // Populate Category Pricing Legend
      this.renderPricingLegend(show.prices);

      this.modal.classList.remove('hidden');
      document.body.style.overflow = 'hidden';

      await this.fetchSeats();
    },

    close() {
      this.modal.classList.add('hidden');
      document.body.style.overflow = '';
      state.selectedSeats.clear();
      this.updateSelectionSummary();
    },

    renderPricingLegend(prices = {}) {
      if (!this.pricingLegend) return;
      this.pricingLegend.innerHTML = '';

      Object.entries(prices).forEach(([tier, price]) => {
        const badge = document.createElement('div');
        badge.className = 'legend-price-badge';
        badge.innerHTML = `<span>${UI.sanitizeText(tier)}:</span> <strong>₹${price}</strong>`;
        this.pricingLegend.appendChild(badge);
      });
    },

    async fetchSeats() {
      if (!state.selectedShow) return;

      this.setLoading(true);
      if (this.errorBanner) this.errorBanner.classList.add('hidden');

      try {
        const data = await apiClient.get(`/seats?show_id=${encodeURIComponent(state.selectedShow.show_id)}`);
        
        if (data && Array.isArray(data.seats)) {
          state.currentSeats = data.seats;
          
          // If backend also returns updated show prices or info, sync it
          if (data.show && data.show.prices) {
            state.selectedShow.prices = data.show.prices;
            this.renderPricingLegend(data.show.prices);
          }

          // Retain selected seats only if still available
          const newlySelected = new Map();
          state.selectedSeats.forEach((seat, seatId) => {
            const found = data.seats.find(s => s.seat_id === seatId);
            if (found && found.available) {
              newlySelected.set(seatId, found);
            }
          });
          state.selectedSeats = newlySelected;

          this.renderMatrix();
          this.updateSelectionSummary();
          InspectorController.updateEndpointStatus('seats', true, `${data.seats.length} seats fetched`);
        } else {
          throw new Error('Invalid response structure from GET /seats');
        }
      } catch (err) {
        console.error('Failed to fetch seats:', err);
        if (this.errorBanner) {
          this.errorBanner.classList.remove('hidden');
          const span = this.errorBanner.querySelector('span');
          if (span) span.textContent = `Error loading seats: ${err.message}`;
        }
        InspectorController.updateEndpointStatus('seats', false, err.message);
        UI.showToast(err.message, 'error', 'Seat Map Error');
      } finally {
        this.setLoading(false);
      }
    },

    setLoading(isLoading) {
      if (this.loader) {
        this.loader.classList.toggle('hidden', !isLoading);
      }
    },

    renderMatrix() {
      if (!this.matrixContainer) return;
      this.matrixContainer.innerHTML = '';

      // Group seats by Row (first character of seat_id, e.g. 'A', 'B', ...)
      const rowGroups = new Map();
      state.currentSeats.forEach(seat => {
        const rowLetter = seat.seat_id.charAt(0).toUpperCase();
        if (!rowGroups.has(rowLetter)) {
          rowGroups.set(rowLetter, []);
        }
        rowGroups.get(rowLetter).push(seat);
      });

      // Sort rows alphabetically (A, B, C...)
      const sortedRowLetters = Array.from(rowGroups.keys()).sort();

      // Organize by seating tiers (Silver: A,B; Gold: C,D; Platinum: E,F; Recliner: G)
      let currentTier = null;
      let currentSection = null;

      sortedRowLetters.forEach(rowLetter => {
        const seatsInRow = rowGroups.get(rowLetter);
        // Sort seats numerically in row (e.g. A01, A02, A10)
        seatsInRow.sort((a, b) => a.seat_id.localeCompare(b.seat_id, undefined, { numeric: true }));

        const rowCategory = seatsInRow[0]?.category || 'General';

        if (rowCategory !== currentTier) {
          currentTier = rowCategory;
          currentSection = document.createElement('div');
          currentSection.className = 'seat-tier-section';

          const tierHeader = document.createElement('div');
          tierHeader.className = 'tier-section-header';
          const tierPrice = state.selectedShow?.prices?.[currentTier] || seatsInRow[0]?.price || '';
          tierHeader.innerHTML = `
            <span>${UI.sanitizeText(currentTier)} SECTION</span>
            <span>₹${tierPrice}</span>
          `;
          currentSection.appendChild(tierHeader);
          this.matrixContainer.appendChild(currentSection);
        }

        const rowEl = document.createElement('div');
        rowEl.className = 'seat-row';

        // Left Row Label
        const leftLabel = document.createElement('span');
        leftLabel.className = 'row-label';
        leftLabel.textContent = rowLetter;
        rowEl.appendChild(leftLabel);

        // Seats wrapper
        const seatsWrap = document.createElement('div');
        seatsWrap.className = 'row-seats';

        seatsInRow.forEach(seat => {
          const seatBtn = this.createSeatButton(seat);
          seatsWrap.appendChild(seatBtn);
        });

        rowEl.appendChild(seatsWrap);

        // Right Row Label
        const rightLabel = document.createElement('span');
        rightLabel.className = 'row-label';
        rightLabel.textContent = rowLetter;
        rowEl.appendChild(rightLabel);

        if (currentSection) {
          currentSection.appendChild(rowEl);
        } else {
          this.matrixContainer.appendChild(rowEl);
        }
      });
    },

    createSeatButton(seat) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `seat-btn category-${(seat.category || '').toLowerCase()}`;
      btn.setAttribute('data-seat-id', seat.seat_id);

      const isSelected = state.selectedSeats.has(seat.seat_id);

      if (!seat.available) {
        btn.classList.add('booked');
        btn.disabled = true;
        btn.setAttribute('aria-disabled', 'true');
        btn.setAttribute('aria-label', `Seat ${seat.seat_id}, ${seat.category}, ₹${seat.price}, Booked`);
        btn.textContent = seat.seat_id;
      } else {
        btn.classList.add('available');
        if (isSelected) {
          btn.classList.add('selected');
        }
        btn.setAttribute('aria-label', `Seat ${seat.seat_id}, ${seat.category}, ₹${seat.price}, ${isSelected ? 'Selected' : 'Available'}`);
        btn.textContent = seat.seat_id;

        btn.addEventListener('click', () => {
          this.toggleSeatSelection(seat, btn);
        });
      }

      return btn;
    },

    toggleSeatSelection(seat, btnElement) {
      if (!seat.available) return;

      if (state.selectedSeats.has(seat.seat_id)) {
        state.selectedSeats.delete(seat.seat_id);
        btnElement.classList.remove('selected');
        btnElement.setAttribute('aria-label', `Seat ${seat.seat_id}, ${seat.category}, ₹${seat.price}, Available`);
      } else {
        state.selectedSeats.set(seat.seat_id, seat);
        btnElement.classList.add('selected');
        btnElement.setAttribute('aria-label', `Seat ${seat.seat_id}, ${seat.category}, ₹${seat.price}, Selected`);
      }

      this.updateSelectionSummary();
    },

    updateSelectionSummary() {
      const count = state.selectedSeats.size;
      let total = 0;

      if (this.selectedCountEl) this.selectedCountEl.textContent = count;

      if (this.selectedChipsWrap) {
        this.selectedChipsWrap.innerHTML = '';

        if (count === 0) {
          const hint = document.createElement('span');
          hint.className = 'no-selection-hint';
          hint.textContent = 'No seats selected yet. Click any available seat above.';
          this.selectedChipsWrap.appendChild(hint);
        } else {
          // Sort selected seats by ID
          const sorted = Array.from(state.selectedSeats.values()).sort((a, b) => 
            a.seat_id.localeCompare(b.seat_id, undefined, { numeric: true })
          );

          sorted.forEach(seat => {
            total += Number(seat.price || 0);

            const chip = document.createElement('span');
            chip.className = 'selected-chip';
            chip.innerHTML = `
              <span>${seat.seat_id} (₹${seat.price})</span>
              <span class="chip-remove-btn" role="button" aria-label="Deselect seat ${seat.seat_id}">&times;</span>
            `;

            const removeBtn = chip.querySelector('.chip-remove-btn');
            removeBtn.addEventListener('click', (e) => {
              e.stopPropagation();
              state.selectedSeats.delete(seat.seat_id);
              const btn = this.matrixContainer.querySelector(`[data-seat-id="${seat.seat_id}"]`);
              if (btn) {
                btn.classList.remove('selected');
                btn.setAttribute('aria-label', `Seat ${seat.seat_id}, ${seat.category}, ₹${seat.price}, Available`);
              }
              this.updateSelectionSummary();
            });

            this.selectedChipsWrap.appendChild(chip);
          });
        }
      }

      if (this.totalPriceEl) {
        this.totalPriceEl.textContent = UI.formatCurrency(total);
      }

      const hasSeats = count > 0;
      if (this.clearBtn) this.clearBtn.disabled = !hasSeats;
      if (this.proceedBtn) this.proceedBtn.disabled = !hasSeats;
    },

    initEvents() {
      if (this.closeBtn) {
        this.closeBtn.addEventListener('click', () => this.close());
      }

      if (this.refreshBtn) {
        this.refreshBtn.addEventListener('click', () => this.fetchSeats());
      }

      if (this.retryBtn) {
        this.retryBtn.addEventListener('click', () => this.fetchSeats());
      }

      if (this.clearBtn) {
        this.clearBtn.addEventListener('click', () => {
          state.selectedSeats.clear();
          const selectedBtns = this.matrixContainer.querySelectorAll('.seat-btn.selected');
          selectedBtns.forEach(b => b.classList.remove('selected'));
          this.updateSelectionSummary();
        });
      }

      if (this.proceedBtn) {
        this.proceedBtn.addEventListener('click', () => {
          if (state.selectedSeats.size === 0) return;
          CheckoutController.open();
        });
      }

      // Close modal on Escape
      window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !this.modal.classList.contains('hidden') && CheckoutController.modal.classList.contains('hidden')) {
          this.close();
        }
      });
    }
  };

  // ============================================================================
  // Checkout & Booking Controller (POST /book-ticket & POST /book-group)
  // ============================================================================
  const CheckoutController = {
    modal: document.getElementById('checkout-modal'),
    closeBtn: document.getElementById('btn-close-checkout'),
    backBtn: document.getElementById('btn-back-to-seats'),
    form: document.getElementById('checkout-form'),
    nameInput: document.getElementById('cust-name-input'),
    emailInput: document.getElementById('cust-email-input'),
    nameError: document.getElementById('cust-name-error'),
    emailError: document.getElementById('cust-email-error'),
    conflictBanner: document.getElementById('checkout-conflict-banner'),
    conflictMsg: document.getElementById('checkout-conflict-msg'),
    apiErrorBanner: document.getElementById('checkout-api-error'),
    apiErrorMsg: document.getElementById('checkout-error-msg'),
    movieNameEl: document.getElementById('checkout-movie-name'),
    movieMetaEl: document.getElementById('checkout-movie-meta'),
    tbodyEl: document.getElementById('checkout-seats-tbody'),
    finalTotalEl: document.getElementById('checkout-final-total'),
    submitBtn: document.getElementById('btn-confirm-booking'),
    submitText: document.getElementById('btn-confirm-booking-text'),
    spinner: document.getElementById('booking-spinner'),

    open() {
      if (!state.selectedShow || state.selectedSeats.size === 0) return;

      this.resetErrors();

      // Prefill last used email if stored in localStorage
      const savedEmail = localStorage.getItem(CONFIG.STORAGE_KEY_EMAIL);
      if (savedEmail && this.emailInput && !this.emailInput.value) {
        this.emailInput.value = savedEmail;
      }

      // Populate summary
      if (this.movieNameEl) this.movieNameEl.textContent = state.selectedShow.movie;
      if (this.movieMetaEl) {
        this.movieMetaEl.textContent = `Screen ${state.selectedShow.screen || '1'} • ${state.selectedShow.format} • ${UI.formatDate(state.selectedShow.date)} at ${state.selectedShow.time}`;
      }

      let total = 0;
      if (this.tbodyEl) {
        this.tbodyEl.innerHTML = '';
        const sortedSeats = Array.from(state.selectedSeats.values()).sort((a, b) => 
          a.seat_id.localeCompare(b.seat_id, undefined, { numeric: true })
        );

        sortedSeats.forEach(seat => {
          total += Number(seat.price || 0);
          const tr = document.createElement('tr');
          tr.innerHTML = `
            <td><strong>${seat.seat_id}</strong></td>
            <td>${UI.sanitizeText(seat.category)}</td>
            <td class="text-right">₹${seat.price}</td>
          `;
          this.tbodyEl.appendChild(tr);
        });
      }

      if (this.finalTotalEl) {
        this.finalTotalEl.textContent = UI.formatCurrency(total);
      }

      if (this.submitText) {
        this.submitText.textContent = `Confirm & Reserve (${UI.formatCurrency(total)})`;
      }

      this.modal.classList.remove('hidden');
    },

    close() {
      this.modal.classList.add('hidden');
    },

    resetErrors() {
      if (this.nameError) this.nameError.classList.add('hidden');
      if (this.emailError) this.emailError.classList.add('hidden');
      if (this.conflictBanner) this.conflictBanner.classList.add('hidden');
      if (this.apiErrorBanner) this.apiErrorBanner.classList.add('hidden');
    },

    validate() {
      this.resetErrors();
      let isValid = true;

      const name = (this.nameInput.value || '').trim();
      const email = (this.emailInput.value || '').trim();
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

      if (!name || name.length < 2) {
        if (this.nameError) this.nameError.classList.remove('hidden');
        isValid = false;
      }

      if (!email || !emailRegex.test(email)) {
        if (this.emailError) this.emailError.classList.remove('hidden');
        isValid = false;
      }

      return isValid;
    },

    setSubmitting(isSubmitting) {
      state.isBookingInProgress = isSubmitting;
      if (this.submitBtn) this.submitBtn.disabled = isSubmitting;
      if (this.backBtn) this.backBtn.disabled = isSubmitting;
      if (this.spinner) this.spinner.classList.toggle('hidden', !isSubmitting);
    },

    async handleBookingSubmit() {
      if (state.isBookingInProgress) return;
      if (!this.validate()) return;

      const customer = this.nameInput.value.trim();
      const email = this.emailInput.value.trim();
      const selectedSeatsArr = Array.from(state.selectedSeats.values());
      const showId = state.selectedShow.show_id;

      this.setSubmitting(true);

      try {
        let result = null;
        let isGroup = selectedSeatsArr.length > 1;

        if (!isGroup) {
          // Single Seat Booking: POST /book-ticket
          const payload = {
            show_id: showId,
            seat_id: selectedSeatsArr[0].seat_id,
            customer: customer,
            email: email
          };
          result = await apiClient.post('/book-ticket', payload);
          InspectorController.updateEndpointStatus('book-ticket', true, `Single seat ${payload.seat_id} booked`);
        } else {
          // Multiple Seats Booking: POST /book-group
          const payload = {
            show_id: showId,
            seats: selectedSeatsArr.map(s => s.seat_id),
            customer: customer,
            email: email
          };
          result = await apiClient.post('/book-group', payload);
          InspectorController.updateEndpointStatus('book-group', true, `Group booking ${payload.seats.join(',')} success`);
        }

        // Store email for user convenience
        localStorage.setItem(CONFIG.STORAGE_KEY_EMAIL, email);

        // Close checkout and seat modal, show confirmation pass
        this.close();
        SeatModalController.close();

        // Pass details to Confirmation Modal
        ConfirmationModalController.open({
          result: result,
          show: state.selectedShow,
          seats: selectedSeatsArr,
          customer: customer,
          email: email,
          isGroup: isGroup
        });

        UI.showToast(`Successfully booked ${selectedSeatsArr.length} seat(s)!`, 'success', 'Booking Confirmed');

      } catch (err) {
        console.error('Booking failed:', err);

        // Handle HTTP 409 Conflict (Seats already booked)
        if (err.status === 409) {
          if (this.conflictBanner) {
            this.conflictBanner.classList.remove('hidden');
            if (this.conflictMsg) {
              this.conflictMsg.textContent = err.message || 'One or more of your chosen seats are already booked. Seat map is refreshing.';
            }
          }
          UI.showToast('Seat collision detected (409 Conflict). Please choose alternative seats.', 'warning', 'Seats Unavailable');
          
          // Trigger seat map refresh in the background so user sees updated unavailable seats
          SeatModalController.fetchSeats();
        } else {
          // General API or network failure
          if (this.apiErrorBanner) {
            this.apiErrorBanner.classList.remove('hidden');
            if (this.apiErrorMsg) {
              this.apiErrorMsg.textContent = err.message || 'Booking transaction failed. Please try again.';
            }
          }
          UI.showToast(err.message, 'error', 'Reservation Failed');
        }
      } finally {
        this.setSubmitting(false);
      }
    },

    initEvents() {
      if (this.closeBtn) {
        this.closeBtn.addEventListener('click', () => this.close());
      }
      if (this.backBtn) {
        this.backBtn.addEventListener('click', () => this.close());
      }
      if (this.form) {
        this.form.addEventListener('submit', (e) => {
          e.preventDefault();
          this.handleBookingSubmit();
        });
      }
    }
  };

  // ============================================================================
  // Confirmation Modal Controller (Digital Ticket Pass)
  // ============================================================================
  const ConfirmationModalController = {
    modal: document.getElementById('confirmation-modal'),
    closeBtn: document.getElementById('btn-close-confirm'),
    printBtn: document.getElementById('btn-print-ticket'),
    viewInMyTicketsBtn: document.getElementById('btn-view-in-mytickets'),
    formatBadge: document.getElementById('ticket-format'),
    bookingIdEl: document.getElementById('ticket-booking-id'),
    movieTitleEl: document.getElementById('ticket-movie-title'),
    dateEl: document.getElementById('ticket-date'),
    timeEl: document.getElementById('ticket-time'),
    screenEl: document.getElementById('ticket-screen'),
    seatsEl: document.getElementById('ticket-seats'),
    customerEl: document.getElementById('ticket-customer'),
    totalPriceEl: document.getElementById('ticket-total-price'),
    snsStatusBox: document.getElementById('ticket-sns-status'),
    snsMsg: document.getElementById('ticket-sns-msg'),
    snsDot: document.getElementById('ticket-sns-dot'),
    barcodeNum: document.getElementById('ticket-barcode-num'),

    lastBookingData: null,

    open({ result, show, seats, customer, email, isGroup }) {
      this.lastBookingData = { result, show, seats, customer, email };

      // Determine booking ID from API response or fallback ID
      const bookingId = result?.booking_id || result?.ticket?.booking_id || 'CINE-' + Math.random().toString(36).substring(2, 9).toUpperCase();

      // Total Price returned by API (rely on backend calculation)
      const calculatedTotal = seats.reduce((acc, s) => acc + Number(s.price || 0), 0);
      const apiTotal = result?.total_price || result?.ticket?.price || calculatedTotal;

      if (this.formatBadge) this.formatBadge.textContent = show.format || 'STANDARD';
      if (this.bookingIdEl) this.bookingIdEl.textContent = bookingId;
      if (this.movieTitleEl) this.movieTitleEl.textContent = show.movie;
      if (this.dateEl) this.dateEl.textContent = UI.formatDate(show.date);
      if (this.timeEl) this.timeEl.textContent = show.time || '';
      if (this.screenEl) this.screenEl.textContent = `Screen ${show.screen || '1'}`;
      if (this.seatsEl) this.seatsEl.textContent = seats.map(s => s.seat_id).join(', ');
      if (this.customerEl) this.customerEl.textContent = customer;
      if (this.totalPriceEl) this.totalPriceEl.textContent = UI.formatCurrency(apiTotal);

      // Handle email notification flag
      const emailSent = Boolean(result?.email_notification_sent);
      if (this.snsStatusBox) {
        if (emailSent) {
          this.snsStatusBox.style.display = 'flex';
          if (this.snsDot) this.snsDot.style.backgroundColor = 'var(--status-success)';
          if (this.snsMsg) this.snsMsg.textContent = `Email notification delivered via Amazon SNS to ${email}`;
        } else {
          this.snsStatusBox.style.display = 'flex';
          if (this.snsDot) this.snsDot.style.backgroundColor = 'var(--status-info)';
          if (this.snsMsg) this.snsMsg.textContent = `Digital pass reserved. Confirmation linked to ${email}`;
        }
      }

      if (this.barcodeNum) {
        this.barcodeNum.textContent = `${bookingId.substring(0, 18).toUpperCase()}`;
      }

      this.modal.classList.remove('hidden');
    },

    close() {
      this.modal.classList.add('hidden');
    },

    initEvents() {
      if (this.closeBtn) {
        this.closeBtn.addEventListener('click', () => this.close());
      }
      if (this.printBtn) {
        this.printBtn.addEventListener('click', () => window.print());
      }
      if (this.viewInMyTicketsBtn) {
        this.viewInMyTicketsBtn.addEventListener('click', () => {
          this.close();
          const targetSection = document.getElementById('my-tickets-section');
          if (targetSection) {
            targetSection.scrollIntoView({ behavior: 'smooth' });
          }
          if (this.lastBookingData?.email) {
            MyTicketsController.fetchUserTickets(this.lastBookingData.email);
          }
        });
      }
    }
  };

  // ============================================================================
  // My Tickets & Lookup Controller (GET /tickets?email={EMAIL} & DELETE /ticket)
  // ============================================================================
  const MyTicketsController = {
    form: document.getElementById('tickets-lookup-form'),
    emailInput: document.getElementById('lookup-email-input'),
    validationError: document.getElementById('lookup-validation-error'),
    submitBtn: document.getElementById('btn-fetch-tickets'),
    spinner: document.getElementById('lookup-spinner'),
    container: document.getElementById('tickets-container'),
    skeleton: document.getElementById('tickets-skeleton'),
    initialState: document.getElementById('tickets-initial-state'),

    async fetchUserTickets(email) {
      if (!email) return;

      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email)) {
        if (this.validationError) this.validationError.classList.remove('hidden');
        return;
      }

      if (this.validationError) this.validationError.classList.add('hidden');
      if (this.emailInput) this.emailInput.value = email;

      this.setLoading(true);

      try {
        const encodedEmail = encodeURIComponent(email);
        const data = await apiClient.get(`/tickets?email=${encodedEmail}`);

        if (data && Array.isArray(data.tickets)) {
          state.userTickets = data.tickets;
          this.renderTickets(data.tickets, email);
          InspectorController.updateEndpointStatus('tickets', true, `${data.tickets.length} tickets retrieved`);
        } else {
          throw new Error('Unexpected data format from GET /tickets');
        }
      } catch (err) {
        console.error('Error fetching tickets:', err);
        InspectorController.updateEndpointStatus('tickets', false, err.message);
        this.renderError(err.message);
        UI.showToast(err.message, 'error', 'Tickets Retrieval Failed');
      } finally {
        this.setLoading(false);
      }
    },

    setLoading(isLoading) {
      if (this.submitBtn) this.submitBtn.disabled = isLoading;
      if (this.spinner) this.spinner.classList.toggle('hidden', !isLoading);
      if (this.skeleton) this.skeleton.classList.toggle('hidden', !isLoading);
      if (isLoading && this.container) {
        this.container.classList.add('hidden');
      }
    },

    renderTickets(tickets, email) {
      if (!this.container) return;
      this.container.classList.remove('hidden');
      this.container.innerHTML = '';

      if (tickets.length === 0) {
        const emptyCard = document.createElement('div');
        emptyCard.className = 'state-card empty-card';
        emptyCard.innerHTML = `
          <div class="state-icon">🎟️</div>
          <h3>No Active Bookings Found</h3>
          <p>We could not find any confirmed tickets for <strong>${UI.sanitizeText(email)}</strong>.</p>
          <a href="#movies-section" class="btn btn-primary btn-sm">Explore Shows &amp; Book</a>
        `;
        this.container.appendChild(emptyCard);
        return;
      }

      // Group tickets by booking_id
      const groupedBookings = new Map();
      tickets.forEach(ticket => {
        const id = ticket.booking_id || 'booking-' + ticket.seat_id;
        if (!groupedBookings.has(id)) {
          groupedBookings.set(id, []);
        }
        groupedBookings.get(id).push(ticket);
      });

      const grid = document.createElement('div');
      grid.className = 'tickets-grid';

      groupedBookings.forEach((seatGroup, bookingId) => {
        const first = seatGroup[0];
        const card = document.createElement('div');
        card.className = 'user-ticket-card';

        const totalPrice = seatGroup.reduce((acc, t) => acc + Number(t.price || 0), 0);
        const seatNames = seatGroup.map(t => t.seat_id).join(', ');

        card.innerHTML = `
          <div class="user-ticket-header">
            <div>
              <div class="show-format-pill">${UI.sanitizeText(first.format || 'STANDARD')}</div>
              <h3 class="movie-title">${UI.sanitizeText(first.movie || 'Movie')}</h3>
            </div>
            <div class="mono-code">${UI.sanitizeText(bookingId.substring(0, 8))}...</div>
          </div>
          <div class="user-ticket-body">
            <div class="ticket-details-grid">
              <div class="ticket-detail">
                <span class="ticket-detail-label">Date</span>
                <span class="ticket-detail-val">${UI.formatDate(first.date)}</span>
              </div>
              <div class="ticket-detail">
                <span class="ticket-detail-label">Time</span>
                <span class="ticket-detail-val">${UI.sanitizeText(first.time || '')}</span>
              </div>
              <div class="ticket-detail">
                <span class="ticket-detail-label">Screen</span>
                <span class="ticket-detail-val">Screen ${UI.sanitizeText(first.screen || '1')}</span>
              </div>
            </div>
            <div>
              <span class="ticket-detail-label">Seats (${seatGroup.length}):</span>
              <div class="ticket-seats-badge-row">
                ${seatGroup.map(s => `<span class="ticket-seat-pill">${UI.sanitizeText(s.seat_id)} (${UI.sanitizeText(s.category || 'Seat')})</span>`).join('')}
              </div>
            </div>
            <div class="ticket-detail">
              <span class="ticket-detail-label">Guest</span>
              <span class="ticket-detail-val">${UI.sanitizeText(first.customer || '')}</span>
            </div>
          </div>
          <div class="user-ticket-footer">
            <div>
              <span class="ticket-detail-label">Total Amount</span>
              <div class="price-amount" style="font-size: 1.15rem; color: #fff;">${UI.formatCurrency(totalPrice)}</div>
            </div>
            <div class="ticket-actions-group">
              <button class="btn btn-outline btn-sm btn-cancel-ticket" data-show-id="${first.show_id}" data-seat-id="${first.seat_id}" data-movie="${UI.sanitizeText(first.movie)}">
                Release Seat
              </button>
            </div>
          </div>
        `;

        const cancelBtn = card.querySelector('.btn-cancel-ticket');
        if (cancelBtn) {
          cancelBtn.addEventListener('click', () => {
            CancelTicketDialogController.open({
              show_id: first.show_id,
              seat_id: first.seat_id,
              movie: first.movie,
              email: email
            });
          });
        }

        grid.appendChild(card);
      });

      this.container.appendChild(grid);
    },

    renderError(msg) {
      if (!this.container) return;
      this.container.classList.remove('hidden');
      this.container.innerHTML = `
        <div class="state-card error-card">
          <div class="state-icon">⚠️</div>
          <h3>Failed to Fetch Bookings</h3>
          <p>${UI.sanitizeText(msg)}</p>
          <button id="btn-retry-tickets" class="btn btn-secondary btn-sm">Retry Search</button>
        </div>
      `;
      const retryBtn = document.getElementById('btn-retry-tickets');
      if (retryBtn) {
        retryBtn.addEventListener('click', () => {
          this.fetchUserTickets(this.emailInput.value.trim());
        });
      }
    },

    initEvents() {
      if (this.form) {
        this.form.addEventListener('submit', (e) => {
          e.preventDefault();
          const email = (this.emailInput.value || '').trim();
          this.fetchUserTickets(email);
        });
      }

      // Quick email sample chips
      const chips = document.querySelectorAll('.email-sample-chip');
      chips.forEach(chip => {
        chip.addEventListener('click', () => {
          const email = chip.getAttribute('data-email');
          if (email) {
            this.fetchUserTickets(email);
          }
        });
      });
    }
  };

  // ============================================================================
  // Cancel Ticket Dialog Controller (DELETE /ticket)
  // ============================================================================
  const CancelTicketDialogController = {
    modal: document.getElementById('cancel-confirm-modal'),
    closeBtn: document.getElementById('btn-close-cancel-dialog'),
    abortBtn: document.getElementById('btn-cancel-abort'),
    proceedBtn: document.getElementById('btn-cancel-proceed'),
    seatIdEl: document.getElementById('cancel-seat-id'),
    movieNameEl: document.getElementById('cancel-show-name'),
    spinner: document.getElementById('cancel-spinner'),
    target: null,

    open(target) {
      this.target = target;
      if (this.seatIdEl) this.seatIdEl.textContent = target.seat_id;
      if (this.movieNameEl) this.movieNameEl.textContent = target.movie;
      this.modal.classList.remove('hidden');
    },

    close() {
      this.modal.classList.add('hidden');
      this.target = null;
    },

    async handleCancel() {
      if (!this.target) return;

      if (this.proceedBtn) this.proceedBtn.disabled = true;
      if (this.abortBtn) this.abortBtn.disabled = true;
      if (this.spinner) this.spinner.classList.remove('hidden');

      const { show_id, seat_id, email } = this.target;

      try {
        const endpoint = `/ticket?show_id=${encodeURIComponent(show_id)}&seat_id=${encodeURIComponent(seat_id)}`;
        await apiClient.delete(endpoint);

        UI.showToast(`Seat ${seat_id} has been released.`, 'success', 'Reservation Cancelled');
        this.close();

        // Refresh user tickets list
        if (email) {
          MyTicketsController.fetchUserTickets(email);
        }

        // If seat modal is open for this show, refresh its seats
        if (state.selectedShow && state.selectedShow.show_id === show_id) {
          SeatModalController.fetchSeats();
        }

      } catch (err) {
        console.error('Cancellation failed:', err);
        UI.showToast(err.message, 'error', 'Cancellation Failed');
      } finally {
        if (this.proceedBtn) this.proceedBtn.disabled = false;
        if (this.abortBtn) this.abortBtn.disabled = false;
        if (this.spinner) this.spinner.classList.add('hidden');
      }
    },

    initEvents() {
      if (this.closeBtn) this.closeBtn.addEventListener('click', () => this.close());
      if (this.abortBtn) this.abortBtn.addEventListener('click', () => this.close());
      if (this.proceedBtn) this.proceedBtn.addEventListener('click', () => this.handleCancel());
    }
  };

  // ============================================================================
  // Backend Diagnostics & CORS Inspector Controller
  // ============================================================================
  const InspectorController = {
    modal: document.getElementById('api-inspector-modal'),
    toggleBtn: document.getElementById('btn-api-inspector-toggle'),
    closeBtn: document.getElementById('btn-close-inspector'),
    bottomCloseBtn: document.getElementById('btn-inspector-close'),
    recheckBtn: document.getElementById('btn-inspector-recheck'),
    originEl: document.getElementById('inspector-origin'),

    apiUrlEl: document.getElementById('inspector-api-url'),
    customUrlInput: document.getElementById('input-custom-api-url'),
    applyUrlBtn: document.getElementById('btn-apply-api-url'),
    resetUrlBtn: document.getElementById('btn-reset-api-url'),

    open() {
      if (this.originEl) {
        this.originEl.textContent = window.location.origin || 'file:// (Local static file)';
      }
      if (this.apiUrlEl) {
        this.apiUrlEl.textContent = CONFIG.API_BASE_URL;
      }
      if (this.customUrlInput) {
        this.customUrlInput.value = CONFIG.API_BASE_URL;
      }
      this.modal.classList.remove('hidden');
    },

    close() {
      this.modal.classList.add('hidden');
    },

    updateEndpointStatus(name, isSuccess, details = '') {
      const epEl = document.getElementById(`ep-${name}`);
      if (!epEl) return;

      const badge = epEl.querySelector('.ep-badge');
      if (!badge) return;

      if (isSuccess) {
        badge.className = 'ep-badge badge-success';
        badge.textContent = `200 OK (${details})`;
      } else {
        badge.className = 'ep-badge badge-error';
        badge.textContent = `Error: ${details}`;
      }
    },

    async runSelfTest() {
      UI.showToast('Testing AWS API Gateway routes...', 'info', 'Diagnostics');
      try {
        await MoviesController.loadShows();
        UI.showToast('Connected to AWS API Gateway in Mumbai (ap-south-1)', 'success', 'Connection Healthy');
      } catch (err) {
        UI.showToast(err.message, 'error', 'Connection Test Failed');
      }
    },

    setBaseUrl(newUrl) {
      if (!newUrl) return;
      CONFIG.API_BASE_URL = newUrl.replace(/\/+$/, '');
      localStorage.setItem('cineverse_custom_api', CONFIG.API_BASE_URL);
      if (this.apiUrlEl) this.apiUrlEl.textContent = CONFIG.API_BASE_URL;
      UI.showToast(`API Base URL set to: ${CONFIG.API_BASE_URL}`, 'info', 'Endpoint Updated');
      MoviesController.loadShows();
    },

    resetToDefaultUrl() {
      CONFIG.API_BASE_URL = CONFIG.DEFAULT_BASE_URL;
      localStorage.removeItem('cineverse_custom_api');
      if (this.apiUrlEl) this.apiUrlEl.textContent = CONFIG.API_BASE_URL;
      if (this.customUrlInput) this.customUrlInput.value = CONFIG.API_BASE_URL;
      UI.showToast('Reset to Direct AWS API Gateway URL.', 'info', 'Reset Complete');
      MoviesController.loadShows();
    },

    initEvents() {
      if (this.toggleBtn) this.toggleBtn.addEventListener('click', () => this.open());
      if (this.closeBtn) this.closeBtn.addEventListener('click', () => this.close());
      if (this.bottomCloseBtn) this.bottomCloseBtn.addEventListener('click', () => this.close());
      if (this.recheckBtn) this.recheckBtn.addEventListener('click', () => this.runSelfTest());
      if (this.applyUrlBtn && this.customUrlInput) {
        this.applyUrlBtn.addEventListener('click', () => {
          const val = this.customUrlInput.value.trim();
          if (val) this.setBaseUrl(val);
        });
      }
      if (this.resetUrlBtn) {
        this.resetUrlBtn.addEventListener('click', () => this.resetToDefaultUrl());
      }
    }
  };

  // ============================================================================
  // Top Bar Backend Status Indicator
  // ============================================================================
  const BackendStatusController = {
    dot: document.getElementById('backend-status-dot'),
    text: document.getElementById('backend-status-text'),

    setLive(isLive, reason = '') {
      if (this.dot) {
        this.dot.className = isLive ? 'status-dot live' : 'status-dot error';
      }
      if (this.text) {
        this.text.textContent = isLive 
          ? 'AWS API Gateway (ap-south-1) Active' 
          : `API Connectivity Notice (${reason || 'Error'})`;
      }
    }
  };

  // ============================================================================
  // Mobile Navigation
  // ============================================================================
  const NavController = {
    menuBtn: document.getElementById('mobile-menu-btn'),
    menu: document.getElementById('nav-menu'),

    init() {
      if (this.menuBtn && this.menu) {
        this.menuBtn.addEventListener('click', () => {
          const isOpen = this.menu.classList.toggle('open');
          this.menuBtn.setAttribute('aria-expanded', String(isOpen));
        });

        const links = this.menu.querySelectorAll('.nav-link');
        links.forEach(l => {
          l.addEventListener('click', () => {
            this.menu.classList.remove('open');
            this.menuBtn.setAttribute('aria-expanded', 'false');
          });
        });
      }
    }
  };

  // ============================================================================
  // Application Bootstrap
  // ============================================================================
  function initApp() {
    NavController.init();
    MoviesController.initEvents();
    SeatModalController.initEvents();
    CheckoutController.initEvents();
    ConfirmationModalController.initEvents();
    MyTicketsController.initEvents();
    CancelTicketDialogController.initEvents();
    InspectorController.initEvents();

    // Initial feed fetch from AWS
    MoviesController.loadShows();

    // Check if there was a saved email to preload in "My Tickets"
    const savedEmail = localStorage.getItem(CONFIG.STORAGE_KEY_EMAIL);
    if (savedEmail) {
      const emailInput = document.getElementById('lookup-email-input');
      if (emailInput) emailInput.value = savedEmail;
    }
  }

  // Run on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initApp);
  } else {
    initApp();
  }

})();
