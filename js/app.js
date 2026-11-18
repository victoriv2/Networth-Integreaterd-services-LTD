// Public Storefront Engine - Networth Integreaterd services LTD
// Complete 5-Tab Architecture: Home (Categories & Brand Intro), Shop (Catalog & Add to Cart),
// Requests (Tracking Orders & Sourcing Inquiries), Cart (Quantity Steppers, State/LGA Pickers, Checkout), Account (Profile, Live Chat, WhatsApp)

document.addEventListener('DOMContentLoaded', async () => {
  // App State
  const state = {
    currentTab: 'home',
    categories: [],
    products: [],
    filteredProducts: [],
    selectedCategory: 'all',
    homePromotedCategory: null,
    selectedSort: 'newest',
    pageSize: 16, // STRICT 16-ROW CATALOG RULE
    hasMoreProducts: false,
    isLoadingMore: false,
    productCardTimers: {},
    currentView: localStorage.getItem('networth_product_view') || 'grid',
    cart: [],
    catalogLoaded: false
  };

  // Helper to get active authenticated user across all storage/service keys
  function getActiveUser() {
    if (window.SupabaseService) {
      if (typeof window.SupabaseService.getCurrentUser === 'function') {
        const u = window.SupabaseService.getCurrentUser();
        if (u && (u.id || u.whatsapp_number)) return u;
      }
      if (typeof window.SupabaseService.getActiveUser === 'function') {
        const u = window.SupabaseService.getActiveUser();
        if (u && (u.id || u.whatsapp_number)) return u;
      }
    }
    try {
      const raw = localStorage.getItem('networth_current_user') || localStorage.getItem('networth_user');
      return raw ? JSON.parse(raw) : null;
    } catch (_) {
      return null;
    }
  }

  // Reactive UI update on authentication state change
  const onAuthChangeHandler = (evt) => {
    try {
      const user = evt?.detail?.user || getActiveUser();
      if (user && user.id) {
        syncCartWithCloud(true);
      }
      renderAccountView();
      renderCartView();
      renderRequestsView();
      updateCartBadges();
      checkUnreadMessages();
    } catch (e) {
      console.warn('Auth reactive notice:', e);
    }
  };
  window.addEventListener('networth_auth_changed', onAuthChangeHandler);

  // DOM Elements
  const productGrid = document.getElementById('productGrid');
  const seeMoreContainer = document.getElementById('seeMoreContainer');
  const seeMoreBtn = document.getElementById('seeMoreBtn');
  const categoryPickerMount = document.getElementById('categoryPickerMount');
  const sortPickerMount = document.getElementById('sortPickerMount');
  const viewGridBtn = document.getElementById('viewGridBtn');
  const viewListBtn = document.getElementById('viewListBtn');

  // Modals
  const detailsModalOverlay = document.getElementById('productDetailsModal');
  const fullViewLightbox = document.getElementById('fullViewLightbox');
  const orderSuccessModal = document.getElementById('orderSuccessModal');

  /* ==========================================================================
     1. CART ENGINE (Persisted in localStorage with Live Count Bubbles)
     ========================================================================== */
  function getCart() {
    try {
      const stored = localStorage.getItem('networth_cart');
      return stored ? JSON.parse(stored) : [];
    } catch (e) {
      return [];
    }
  }

  function getLocalCartTimestamp() {
    try {
      return Number(localStorage.getItem('networth_cart_timestamp')) || 0;
    } catch (_) {
      return 0;
    }
  }

  function setLocalCartTimestamp(ts) {
    try {
      localStorage.setItem('networth_cart_timestamp', String(ts || Date.now()));
    } catch (_) {}
  }

  let lastLocalCartMutationTime = 0;
  let isSyncingCartToCloud = false;
  let lastExplicitClearTime = 0;

  function saveCart(cart, skipCloud = false, customTimestamp = null) {
    const safeCart = Array.isArray(cart) ? cart : [];
    try {
      if (safeCart.length === 0) {
        localStorage.removeItem('networth_cart');
      } else {
        localStorage.setItem('networth_cart', JSON.stringify(safeCart));
      }
    } catch (e) {}
    state.cart = safeCart;
    updateCartBadges();

    const timestamp = customTimestamp || Date.now();
    setLocalCartTimestamp(timestamp);

    // Multi-device Cloud Cart Sync
    if (!skipCloud) {
      lastLocalCartMutationTime = Date.now();
      const activeUser = getActiveUser();
      if (activeUser && activeUser.id && window.SupabaseService?.syncUserCartToCloud) {
        isSyncingCartToCloud = true;
        window.SupabaseService.syncUserCartToCloud(activeUser.id, safeCart)
          .catch(err => console.warn('Cloud cart sync dispatch notice:', err))
          .finally(() => {
            isSyncingCartToCloud = false;
          });
      }
    }
  }

  // Multi-device Cart Cloud Sync engine
  async function syncCartWithCloud(isInitialLogin = false) {
    const activeUser = getActiveUser();
    if (!activeUser || !activeUser.id || !window.SupabaseService?.getUserCartFromCloud) return;

    // Guard against race conditions right after local mutations (wait 3s after local action)
    if (!isInitialLogin && (isSyncingCartToCloud || (Date.now() - lastLocalCartMutationTime < 3000))) {
      return;
    }

    try {
      const cloudRes = await window.SupabaseService.getUserCartFromCloud(activeUser.id);
      // If network failed, timed out, or returned null -> DO NOT TOUCH local cart
      if (!cloudRes) return;

      const cloudCart = Array.isArray(cloudRes) ? cloudRes : (cloudRes.cart || []);
      const cloudUpdatedAt = (cloudRes && cloudRes.updatedAt) ? Number(cloudRes.updatedAt) : 0;
      const localCart = getCart();
      const localTimestamp = getLocalCartTimestamp();

      // If user recently explicitly cleared or placed an order on this device, never resurrect old items from cloud
      if (Date.now() - lastExplicitClearTime < 120000) {
        if (cloudCart.length > 0) {
          window.SupabaseService.syncUserCartToCloud(activeUser.id, []).catch(() => {});
        }
        return;
      }

      // 1. Initial Login on fresh device
      if (isInitialLogin) {
        if (localCart.length === 0 && cloudCart.length > 0) {
          saveCart(cloudCart, true, cloudUpdatedAt || Date.now());
          if (state.currentTab === 'cart') renderCartView();
          return;
        }
        if (localCart.length > 0 && cloudCart.length === 0) {
          saveCart(localCart, false, Date.now());
          if (state.currentTab === 'cart') renderCartView();
          return;
        }
        if (localCart.length > 0 && cloudCart.length > 0) {
          // Merge guest cart with cloud cart
          const mergedMap = new Map();
          cloudCart.forEach(item => { if (item && item.id) mergedMap.set(item.id, { ...item }); });
          localCart.forEach(item => {
            if (item && item.id) {
              if (mergedMap.has(item.id)) {
                const existing = mergedMap.get(item.id);
                existing.quantity = Math.max(Number(existing.quantity) || 1, Number(item.quantity) || 1);
              } else {
                mergedMap.set(item.id, { ...item });
              }
            }
          });
          const mergedCart = Array.from(mergedMap.values());
          saveCart(mergedCart, false, Date.now());
          if (state.currentTab === 'cart') renderCartView();
          return;
        }
        return;
      }

      // 2. Active multi-device real-time sync (when already logged in on other devices)
      const isIdentical = localCart.length === cloudCart.length &&
        JSON.stringify(localCart.map(i => ({ id: i.id, q: i.quantity }))) ===
        JSON.stringify(cloudCart.map(i => ({ id: i.id, q: i.quantity })));

      if (isIdentical) {
        if (cloudUpdatedAt > localTimestamp) setLocalCartTimestamp(cloudUpdatedAt);
        return;
      }

      // Case A: Cloud has items and local is empty -> PULL CLOUD ITEMS TO LOCAL!
      if (localCart.length === 0 && cloudCart.length > 0) {
        saveCart(cloudCart, true, cloudUpdatedAt || Date.now());
        if (state.currentTab === 'cart') renderCartView();
        return;
      }

      // Case B: Local has items and cloud is empty
      if (localCart.length > 0 && cloudCart.length === 0) {
        if (cloudUpdatedAt > localTimestamp) {
          // Cloud was explicitly cleared on another device after local action
          saveCart([], true, cloudUpdatedAt);
          if (state.currentTab === 'cart') renderCartView();
        } else {
          // Local items were added on this device, push to cloud
          window.SupabaseService.syncUserCartToCloud(activeUser.id, localCart).catch(() => {});
        }
        return;
      }

      // Case C: Both have items but they differ
      if (cloudUpdatedAt > localTimestamp) {
        // Cloud has newer modifications made on another device
        saveCart(cloudCart, true, cloudUpdatedAt);
        if (state.currentTab === 'cart') renderCartView();
      } else if (localTimestamp > cloudUpdatedAt) {
        // Local has newer modifications made on this device
        window.SupabaseService.syncUserCartToCloud(activeUser.id, localCart).catch(() => {});
      } else {
        // Equal timestamps or unknown: merge by taking union with max quantity
        const mergedMap = new Map();
        cloudCart.forEach(item => { if (item && item.id) mergedMap.set(item.id, { ...item }); });
        localCart.forEach(item => {
          if (item && item.id) {
            if (mergedMap.has(item.id)) {
              const existing = mergedMap.get(item.id);
              existing.quantity = Math.max(Number(existing.quantity) || 1, Number(item.quantity) || 1);
            } else {
              mergedMap.set(item.id, { ...item });
            }
          }
        });
        const mergedCart = Array.from(mergedMap.values());
        saveCart(mergedCart, false, Date.now());
        if (state.currentTab === 'cart') renderCartView();
      }
    } catch (e) {
      console.warn('Sync cart notice:', e);
    }
  }

  function getCartCount() {
    const cart = getCart();
    return cart.reduce((sum, item) => sum + (Number(item.quantity) || 1), 0);
  }

  function getCartTotal() {
    const cart = getCart();
    return cart.reduce((sum, item) => sum + ((Number(item.price) || 0) * (Number(item.quantity) || 1)), 0);
  }

  function updateCartBadges() {
    const count = getCartCount();
    const bottomBadge = document.getElementById('bottomCartCount');
    const deskBadge = document.getElementById('deskCartBadge');

    [bottomBadge, deskBadge].forEach(b => {
      if (!b) return;
      if (count > 0) {
        b.textContent = count > 99 ? '99+' : count;
        b.style.display = 'flex';
      } else {
        b.style.display = 'none';
      }
    });
  }

  function addToCart(prod, quantity = 1) {
    if (!prod) return;
    const cart = getCart();
    const existing = cart.find(item => item.id === prod.id);
    const coverImg = Array.isArray(prod.images) && prod.images[0] ? prod.images[0] : 'assets/images/logo.png';

    if (existing) {
      existing.quantity += quantity;
    } else {
      cart.push({
        id: prod.id,
        title: prod.title,
        price: Number(prod.price) || 0,
        image: coverImg,
        category: prod.category || '',
        quantity: quantity
      });
    }

    saveCart(cart);

    window.CustomModal.toast({
      message: `Added "${prod.title}" to Cart!`,
      type: 'success'
    });

    if (state.currentTab === 'cart') {
      renderCartView();
    }
  }

  function removeFromCart(prodId) {
    let cart = getCart();
    cart = cart.filter(item => item.id !== prodId);
    saveCart(cart);
    renderCartView();
    window.CustomModal.toast({ message: 'Item removed from cart.', type: 'info' });
  }

  function updateCartQuantity(prodId, delta) {
    const cart = getCart();
    const item = cart.find(i => i.id === prodId);
    if (!item) return;

    item.quantity += delta;
    if (item.quantity <= 0) {
      removeFromCart(prodId);
      return;
    }
    saveCart(cart);
    renderCartView();
  }

  function clearCart() {
    lastExplicitClearTime = Date.now();
    lastLocalCartMutationTime = Date.now();
    saveCart([]);
    renderCartView();
    const activeUser = getActiveUser();
    if (activeUser && activeUser.id && window.SupabaseService?.syncUserCartToCloud) {
      window.SupabaseService.syncUserCartToCloud(activeUser.id, []).catch(() => {});
    }
    window.CustomModal.toast({ message: 'Cart cleared.', type: 'info' });
  }

  /* ==========================================================================
     2. SPA TAB NAVIGATION (Home, Shop, Requests, Cart, Account)
     ========================================================================== */
  window.switchAppTab = function(tabName, categoryToFilter = null) {
    if (!tabName) tabName = 'shop';
    state.currentTab = tabName;

    // Clean up fast tab preload style if present
    const fastStyle = document.getElementById('fastTabStyle');
    if (fastStyle) fastStyle.remove();

    // Update bottom navigation bar
    document.querySelectorAll('.bottom-nav-item').forEach(btn => {
      if (btn.getAttribute('data-tab') === tabName) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });

    // Update desktop navigation
    document.querySelectorAll('.desktop-nav-btn').forEach(btn => {
      if (btn.getAttribute('data-tab') === tabName) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });

    // Show active view container, hide others
    const views = {
      home: document.getElementById('viewHome'),
      shop: document.getElementById('viewShop'),
      requests: document.getElementById('viewRequests'),
      cart: document.getElementById('viewCart'),
      account: document.getElementById('viewAccount')
    };

    Object.keys(views).forEach(key => {
      const v = views[key];
      if (!v) return;
      if (key === tabName) {
        v.classList.add('active');
        v.style.display = 'block';
      } else {
        v.classList.remove('active');
        v.style.display = 'none';
      }
    });

    // Category filter override from Home Category Click
    if (categoryToFilter) {
      state.selectedCategory = categoryToFilter;
      state.homePromotedCategory = categoryToFilter;
    } else if (tabName === 'shop') {
      state.homePromotedCategory = null;
    }

    // Tab-specific rendering
    if (tabName === 'home') {
      renderHomeCategories();
    } else if (tabName === 'shop') {
      renderProductPageBanner();
      renderShopCategoryPills();
      applyFiltersAndSort();
    } else if (tabName === 'cart') {
      renderCartView();
      syncCartWithCloud();
    } else if (tabName === 'requests') {
      renderRequestsView();
    } else if (tabName === 'account') {
      renderAccountView();
    }

    window.scrollTo({ top: 0, behavior: 'smooth' });

    try {
      history.replaceState(null, '', '#' + tabName);
      sessionStorage.setItem('networth_current_tab', tabName);
    } catch (e) {}
  };

  function initTabListeners() {
    // Bottom nav bar tabs
    document.querySelectorAll('.bottom-nav-item').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const tab = btn.getAttribute('data-tab');
        window.switchAppTab(tab);
      });
    });

    // Desktop nav buttons
    document.querySelectorAll('.desktop-nav-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const tab = btn.getAttribute('data-tab');
        window.switchAppTab(tab);
      });
    });
  }

  /* ==========================================================================
     3. INITIAL DATA FETCHING (Supabase with Local Preload)
     ========================================================================== */
  function renderProductGridSkeleton() {
    if (!productGrid) return;
    productGrid.innerHTML = `
      <div style="grid-column: 1 / -1; display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 14px; width: 100%;">
        ${Array.from({ length: 8 }).map(() => `
          <div style="background: #ffffff; border-radius: 12px; border: 1.5px solid #e5e5e5; padding: 12px; display: flex; flex-direction: column; gap: 10px;">
            <div style="width: 100%; aspect-ratio: 1/1; background: #eef5fb; border-radius: 8px;"></div>
            <div style="height: 14px; width: 80%; background: #eef5fb; border-radius: 4px;"></div>
            <div style="height: 16px; width: 50%; background: #eef5fb; border-radius: 4px;"></div>
            <div style="height: 34px; width: 100%; background: #eef5fb; border-radius: 6px; margin-top: auto;"></div>
          </div>
        `).join('')}
      </div>
    `;
  }

  async function loadInitialData() {
    // 0ms INSTANT RENDER FROM LOCAL CACHE (if valid) OR CLEAN LOADING SKELETON
    try {
      const cachedCategories = window.SupabaseService.getLocalCategories ? window.SupabaseService.getLocalCategories() : [];
      const cachedProducts = window.SupabaseService.getLocalProducts ? window.SupabaseService.getLocalProducts(false) : [];

      if (cachedCategories.length > 0) state.categories = cachedCategories;
      renderProductPageBanner();
      renderHomeCategories();
      renderShopCategoryPills();
      initToolbars();
      initSeeMore();

      if (cachedProducts && cachedProducts.length > 0) {
        state.products = cachedProducts
          .filter(p => !window.SupabaseService?.isProductHidden?.(p))
          .sort(compareProductsNewest);
        applyFiltersAndSort();
      } else {
        renderProductGridSkeleton();
      }

      updateCartBadges();
      checkUnreadMessages();
      syncCartWithCloud();
    } catch (e) {
      console.warn('Preload notice:', e);
      renderProductGridSkeleton();
    }

    // Fresh fetch from Supabase
    try {
      const [categories, products] = await Promise.all([
        window.SupabaseService.getCategories(),
        window.SupabaseService.getProducts({
          limit: state.pageSize,
          offset: 0,
          categoryId: state.selectedCategory,
          sort: state.selectedSort,
          includeHidden: false
        })
      ]);

      if (Array.isArray(categories)) {
        state.categories = categories;
      }
      if (Array.isArray(products)) {
        state.products = products
          .filter(p => !window.SupabaseService?.isProductHidden?.(p))
          .sort(compareProductsNewest);
      }
      state.catalogLoaded = true;
      state.hasMoreProducts = Array.isArray(products) && products.length === state.pageSize;

      renderHomeCategories();
      renderShopCategoryPills();
      initToolbars();
      initSeeMore();
      applyFiltersAndSort();
      updateCartBadges();
      checkUnreadMessages();
      syncCartWithCloud();
    } catch (err) {
      console.warn('Supabase fetch notice (using cache):', err);
    }
  }

  /* ==========================================================================
     4. HOME VIEW: CATEGORY SEARCH & 3-COL GRID
     ========================================================================== */
  function initCategorySearch() {
    const input = document.getElementById('categorySearchInput');
    const clearBtn = document.getElementById('categorySearchClearBtn');
    if (!input) return;

    input.addEventListener('input', () => {
      const val = input.value.trim();
      if (clearBtn) clearBtn.style.display = input.value ? 'flex' : 'none';
      renderHomeCategories(val);
    });

    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        input.value = '';
        clearBtn.style.display = 'none';
        input.focus();
        renderHomeCategories('');
      });
    }
  }

  /* ==========================================================================
     16:9 PRODUCT CATALOG BANNER SLIDER (Unified Sliding Container 2.0s, Touch Swipe, Global Toggle)
     ========================================================================== */
  let productBannerInterval = null;
  let currentBannerIndex = 0; // Real active banner index: 0 .. N-1
  let currentTrackVirtualIndex = 2; // Track index with clones: start at 2 (real B0) when N >= 2
  let isBannerTransitioning = false;
  let activeBanners = [];
  let suppressBannerClickUntil = 0;
  let lastRenderedBannersJson = '';

  function preloadBannerImages(banners) {
    if (!Array.isArray(banners)) return;
    banners.forEach(b => {
      if (b && b.image_url) {
        const img = new Image();
        img.decoding = 'async';
        img.src = b.image_url;
      }
    });
  }

  function getTrackTransform(virtualIdx) {
    const isDesktop = window.innerWidth >= 769;
    if (!isDesktop) {
      return `translateX(-${virtualIdx * 100}%)`;
    } else {
      // 70% card width + 2% margin-right = 72% per slide.
      // To center active slide in 100% viewport: (100% - 70%) / 2 = 15% left offset.
      return `translateX(calc(15% - ${virtualIdx * 72}%))`;
    }
  }

  function updateActiveSlideClasses(virtualIdx) {
    const slides = document.querySelectorAll('#productBannerTrack .product-banner-slide');
    if (!slides || slides.length === 0) return;
    const N = activeBanners.length;

    slides.forEach((s, idx) => {
      // If slide is current virtual index OR its twin boundary clone/real counterpart, keep active state in sync
      const isCurrentVirtual = idx === virtualIdx;
      const isTwin = N >= 2 && (
        (virtualIdx === N + 2 && idx === 2) || // Clone 0 at end is identical twin to Real 0
        (virtualIdx === 2 && idx === N + 2) || // Real 0 is identical twin to Clone 0 at end
        (virtualIdx === 1 && idx === N + 1) || // Clone N-1 at start is identical twin to Real N-1
        (virtualIdx === N + 1 && idx === 1)    // Real N-1 is identical twin to Clone N-1 at start
      );

      if (isCurrentVirtual || isTwin) {
        s.classList.add('is-active-slide');
      } else {
        s.classList.remove('is-active-slide');
      }
    });
  }

  function buildSlideHtml(b, realIdx, isClone = false) {
    const img = b.image_url || 'assets/images/logo.png';
    const hasOverlay = (b.title && b.title.trim()) || (b.subtitle && b.subtitle.trim());
    const link = b.link_url || '';
    return `
      <div class="product-banner-slide" data-index="${realIdx}" data-link="${link ? (window.CustomModal?.escape ? window.CustomModal.escape(link) : link) : ''}" ${isClone ? 'data-clone="true"' : ''}>
        <img src="${img}" alt="${b.title ? (window.CustomModal?.escape ? window.CustomModal.escape(b.title) : b.title) : 'Networth Integreaterd services LTD'}" onerror="this.onerror=null;this.src='assets/images/logo.png';" loading="eager" decoding="async" fetchpriority="high" />
        ${hasOverlay ? `
          <div class="product-banner-caption-overlay">
            ${b.title ? `<div class="product-banner-caption-title">${window.CustomModal?.escape ? window.CustomModal.escape(b.title) : b.title}</div>` : ''}
            ${b.subtitle ? `<div class="product-banner-caption-sub">${window.CustomModal?.escape ? window.CustomModal.escape(b.subtitle) : b.subtitle}</div>` : ''}
          </div>
        ` : ''}
      </div>
    `;
  }

  async function renderProductPageBanner(forceRerender = false) {
    const bannerSection = document.getElementById('productBannerSection');
    const bannerTrack = document.getElementById('productBannerTrack');
    const bannerIndicators = document.getElementById('productBannerIndicators');
    const prevBtn = document.getElementById('bannerStagePrevBtn');
    const nextBtn = document.getElementById('bannerStageNextBtn');
    if (!bannerSection || !bannerTrack) return;

    try {
      activeBanners = await window.SupabaseService.getBanners(false);
      preloadBannerImages(activeBanners);

      const isEnabled = await window.SupabaseService.isBannerGloballyEnabled();
      if (!isEnabled || !Array.isArray(activeBanners) || activeBanners.length === 0) {
        if (productBannerInterval) {
          clearInterval(productBannerInterval);
          productBannerInterval = null;
        }
        bannerSection.style.display = 'none';
        bannerTrack.innerHTML = '';
        if (bannerIndicators) bannerIndicators.innerHTML = '';
        lastRenderedBannersJson = '';
        return;
      }

      const bannersJson = JSON.stringify(activeBanners) + '_' + isEnabled;
      // Prevent destroying already loaded DOM images if banners have not changed (stops tab-switch blinking)
      if (!forceRerender && bannersJson === lastRenderedBannersJson && bannerTrack.children.length > 0) {
        if (!productBannerInterval && activeBanners.length >= 2) {
          startBannerAutoSlide();
        }
        return;
      }
      lastRenderedBannersJson = bannersJson;

      // Clear any active auto-slide interval while setting up
      if (productBannerInterval) {
        clearInterval(productBannerInterval);
        productBannerInterval = null;
      }

      // Display 16:9 banner container
      bannerSection.style.display = 'block';

      if (activeBanners.length >= 2) {
        const N = activeBanners.length;
        // Infinite forward continuous loop buffer with 2 clones on each side:
        // [Clone(N-2), Clone(N-1), B0, B1, ... B(N-1), Clone(0), Clone(1)]
        const c1 = buildSlideHtml(activeBanners[(N - 2 + N) % N], (N - 2 + N) % N, true);
        const c2 = buildSlideHtml(activeBanners[N - 1], N - 1, true);
        const realSlides = activeBanners.map((b, idx) => buildSlideHtml(b, idx, false)).join('');
        const c3 = buildSlideHtml(activeBanners[0], 0, true);
        const c4 = buildSlideHtml(activeBanners[1 % N], 1 % N, true);

        bannerTrack.classList.add('is-snapping');
        bannerTrack.innerHTML = c1 + c2 + realSlides + c3 + c4;
        currentBannerIndex = 0;
        currentTrackVirtualIndex = 2; // Real B0 is at index 2
        bannerTrack.style.transition = 'none';
        bannerTrack.style.transform = getTrackTransform(2);

        void bannerTrack.offsetHeight;
        requestAnimationFrame(() => {
          bannerTrack.classList.remove('is-snapping');
        });

        if (prevBtn) prevBtn.style.display = '';
        if (nextBtn) nextBtn.style.display = '';
      } else {
        // N === 1: [Clone 0, Real 0, Clone 0] so peeking wings carry the same banner seamlessly
        const b0 = activeBanners[0];
        bannerTrack.classList.add('is-snapping');
        bannerTrack.innerHTML = buildSlideHtml(b0, 0, true) + buildSlideHtml(b0, 0, false) + buildSlideHtml(b0, 0, true);
        currentBannerIndex = 0;
        currentTrackVirtualIndex = 1; // Real B0 is at index 1
        bannerTrack.style.transition = 'none';
        bannerTrack.style.transform = getTrackTransform(1);

        void bannerTrack.offsetHeight;
        requestAnimationFrame(() => {
          bannerTrack.classList.remove('is-snapping');
        });

        if (prevBtn) prevBtn.style.display = 'none';
        if (nextBtn) nextBtn.style.display = 'none';
      }

      updateActiveSlideClasses(currentTrackVirtualIndex);

      // Render dots if 2 or more slides
      if (bannerIndicators) {
        if (activeBanners.length >= 2) {
          bannerIndicators.innerHTML = activeBanners.map((_, idx) => `
            <button type="button" class="product-banner-dot ${idx === 0 ? 'active' : ''}" data-index="${idx}" aria-label="Slide ${idx + 1}"></button>
          `).join('');

          bannerIndicators.querySelectorAll('.product-banner-dot').forEach(dot => {
            dot.addEventListener('click', (e) => {
              e.stopPropagation();
              const idx = parseInt(dot.getAttribute('data-index'), 10);
              goToBannerSlide(idx);
              restartBannerAutoSlide();
            });
          });
        } else {
          bannerIndicators.innerHTML = '';
        }
      }

      updateBannerDots(0);

      // Slide click navigation
      bannerTrack.querySelectorAll('.product-banner-slide').forEach((slide, slideIdx) => {
        slide.addEventListener('click', (e) => {
          // If a touch swipe just occurred on mobile, ignore the click
          if (Date.now() < suppressBannerClickUntil) {
            e.preventDefault();
            e.stopPropagation();
            return;
          }

          // If on desktop and user clicked a side peeking slide (not currently the center slide)
          if (window.innerWidth >= 769 && activeBanners.length >= 2) {
            if (slideIdx < currentTrackVirtualIndex) {
              slidePrev();
              restartBannerAutoSlide();
              return;
            } else if (slideIdx > currentTrackVirtualIndex) {
              slideNext();
              restartBannerAutoSlide();
              return;
            }
          }

          // Centered active slide clicked: follow banner link if configured
          const link = (slide.getAttribute('data-link') || '').trim();
          if (link) {
            if (link.startsWith('#')) {
              const targetTab = link.replace('#', '');
              if (targetTab.startsWith('category:')) {
                const catId = targetTab.replace('category:', '');
                window.switchAppTab('shop', catId);
              } else {
                window.switchAppTab(targetTab);
              }
            } else if (link.startsWith('http')) {
              window.open(link, '_blank', 'noopener,noreferrer');
            } else {
              window.location.href = link;
            }
          }

          // Always ensure auto-slide keeps running smoothly and never freezes on tap
          if (activeBanners.length >= 2 && !productBannerInterval) {
            startBannerAutoSlide();
          }
        });
      });

      setupBannerGesturesAndAutoSlide();
    } catch (err) {
      console.warn('Product banner initialization notice:', err);
      bannerSection.style.display = 'none';
    }
  }

  function updateBannerDots(index) {
    const bannerIndicators = document.getElementById('productBannerIndicators');
    if (!bannerIndicators) return;
    const dots = bannerIndicators.querySelectorAll('.product-banner-dot');
    dots.forEach((dot, idx) => {
      if (idx === index) {
        dot.classList.add('active');
      } else {
        dot.classList.remove('active');
      }
    });
  }

  // Continuous Seamless Forward Slide: 1 -> 2 -> 3 -> 4 -> 1 -> 2... (Entire container slides together)
  function slideNext() {
    if (!activeBanners || activeBanners.length < 2 || isBannerTransitioning) return;
    const bannerTrack = document.getElementById('productBannerTrack');
    if (!bannerTrack) return;

    isBannerTransitioning = true;
    const N = activeBanners.length;
    currentTrackVirtualIndex++;

    bannerTrack.classList.remove('is-snapping');
    bannerTrack.style.transition = 'transform 0.4s cubic-bezier(0.25, 1, 0.5, 1)';
    bannerTrack.style.transform = getTrackTransform(currentTrackVirtualIndex);

    currentBannerIndex = (currentTrackVirtualIndex - 2 + N) % N;
    updateBannerDots(currentBannerIndex);
    updateActiveSlideClasses(currentTrackVirtualIndex);

    setTimeout(() => {
      if (currentTrackVirtualIndex >= N + 2) {
        // Reached clone of slide 0 at end: snap silently without transition to real slide 0 at index 2
        bannerTrack.classList.add('is-snapping');
        bannerTrack.style.transition = 'none';
        currentTrackVirtualIndex = 2;
        bannerTrack.style.transform = getTrackTransform(2);
        updateActiveSlideClasses(2);
        void bannerTrack.offsetHeight; // Force reflow while is-snapping is active

        requestAnimationFrame(() => {
          bannerTrack.classList.remove('is-snapping');
          isBannerTransitioning = false;
        });
      } else {
        isBannerTransitioning = false;
      }
    }, 420);
  }

  // Continuous Seamless Backward Slide
  function slidePrev() {
    if (!activeBanners || activeBanners.length < 2 || isBannerTransitioning) return;
    const bannerTrack = document.getElementById('productBannerTrack');
    if (!bannerTrack) return;

    isBannerTransitioning = true;
    const N = activeBanners.length;
    currentTrackVirtualIndex--;

    bannerTrack.classList.remove('is-snapping');
    bannerTrack.style.transition = 'transform 0.4s cubic-bezier(0.25, 1, 0.5, 1)';
    bannerTrack.style.transform = getTrackTransform(currentTrackVirtualIndex);

    currentBannerIndex = (currentTrackVirtualIndex - 2 + N) % N;
    updateBannerDots(currentBannerIndex);
    updateActiveSlideClasses(currentTrackVirtualIndex);

    setTimeout(() => {
      if (currentTrackVirtualIndex <= 1) {
        // Reached clone of last slide at start: snap silently without transition to real last slide at N+1
        bannerTrack.classList.add('is-snapping');
        bannerTrack.style.transition = 'none';
        currentTrackVirtualIndex = N + 1;
        bannerTrack.style.transform = getTrackTransform(N + 1);
        updateActiveSlideClasses(N + 1);
        void bannerTrack.offsetHeight; // Force reflow while is-snapping is active

        requestAnimationFrame(() => {
          bannerTrack.classList.remove('is-snapping');
          isBannerTransitioning = false;
        });
      } else {
        isBannerTransitioning = false;
      }
    }, 420);
  }

  function goToBannerSlide(realIndex) {
    if (!activeBanners || activeBanners.length === 0) return;
    const bannerTrack = document.getElementById('productBannerTrack');
    if (!bannerTrack) return;

    const N = activeBanners.length;
    if (N < 2) {
      currentBannerIndex = 0;
      currentTrackVirtualIndex = 1;
      bannerTrack.style.transition = 'none';
      bannerTrack.style.transform = getTrackTransform(1);
      updateBannerDots(0);
      updateActiveSlideClasses(1);
      return;
    }

    currentBannerIndex = (realIndex + N) % N;
    currentTrackVirtualIndex = currentBannerIndex + 2;

    bannerTrack.style.transition = 'transform 0.4s cubic-bezier(0.25, 1, 0.5, 1)';
    bannerTrack.style.transform = getTrackTransform(currentTrackVirtualIndex);

    updateBannerDots(currentBannerIndex);
    updateActiveSlideClasses(currentTrackVirtualIndex);
  }

  function setupBannerGesturesAndAutoSlide() {
    const slider = document.getElementById('productBannerSlider');
    const stage = document.getElementById('productBannerStage');
    const prevBtn = document.getElementById('bannerStagePrevBtn');
    const nextBtn = document.getElementById('bannerStageNextBtn');

    // Desktop Nav Buttons
    if (prevBtn && !prevBtn._hasNavListener) {
      prevBtn._hasNavListener = true;
      prevBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (activeBanners.length >= 2) {
          slidePrev();
          restartBannerAutoSlide();
        }
      });
    }

    if (nextBtn && !nextBtn._hasNavListener) {
      nextBtn._hasNavListener = true;
      nextBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (activeBanners.length >= 2) {
          slideNext();
          restartBannerAutoSlide();
        }
      });
    }

    if (!slider || slider._hasGestureListeners) {
      if (activeBanners.length >= 2 && !productBannerInterval) startBannerAutoSlide();
      return;
    }
    slider._hasGestureListeners = true;

    if (activeBanners.length >= 2) {
      startBannerAutoSlide();
    }

    // Mobile Only Touch-Swipe Gestures (< 769px) - Desktop is strictly click-only
    let touchStartX = 0;
    let touchStartY = 0;
    let touchDeltaX = 0;
    let touchDeltaY = 0;
    let touchStartTime = 0;
    let isHorizontalSwipe = false;
    let isVerticalScroll = false;

    slider.addEventListener('touchstart', (e) => {
      // Desktop screens ignore swipe gestures completely (click only to change)
      if (window.innerWidth >= 769) return;
      if (!e.touches || e.touches.length === 0) return;
      touchStartX = e.touches[0].clientX;
      touchStartY = e.touches[0].clientY;
      touchDeltaX = 0;
      touchDeltaY = 0;
      touchStartTime = Date.now();
      isHorizontalSwipe = false;
      isVerticalScroll = false;
    }, { passive: true });

    slider.addEventListener('touchmove', (e) => {
      if (window.innerWidth >= 769) return;
      if (!e.touches || e.touches.length === 0 || isVerticalScroll) return;
      touchDeltaX = e.touches[0].clientX - touchStartX;
      touchDeltaY = e.touches[0].clientY - touchStartY;

      if (!isHorizontalSwipe && !isVerticalScroll) {
        const absX = Math.abs(touchDeltaX);
        const absY = Math.abs(touchDeltaY);
        // Only classify once movement exceeds 8px
        if (absX > 8 || absY > 8) {
          if (absX > absY) {
            isHorizontalSwipe = true;
          } else {
            // User is scrolling the page vertically: do not intercept or change the banner!
            isVerticalScroll = true;
          }
        }
      }
    }, { passive: true });

    slider.addEventListener('touchend', () => {
      if (window.innerWidth >= 769) return;
      const absX = Math.abs(touchDeltaX);

      // Trigger slide only if it was an intentional horizontal swipe of at least 35px on mobile
      if (activeBanners.length >= 2 && isHorizontalSwipe && !isVerticalScroll && absX > 35) {
        // Suppress any synthetic click event generated by touch release
        suppressBannerClickUntil = Date.now() + 450;
        if (touchDeltaX < 0) {
          slideNext();
        } else {
          slidePrev();
        }
      }

      isHorizontalSwipe = false;
      isVerticalScroll = false;
      restartBannerAutoSlide();
    });

    slider.addEventListener('touchcancel', () => {
      if (window.innerWidth >= 769) return;
      isHorizontalSwipe = false;
      isVerticalScroll = false;
      restartBannerAutoSlide();
    });
  }

  function startBannerAutoSlide() {
    stopBannerAutoSlide();
    // Continuous forward auto-slide every 2.0 seconds (2000ms)
    productBannerInterval = setInterval(() => {
      if (activeBanners.length >= 2) {
        slideNext();
      }
    }, 2000);
  }

  function stopBannerAutoSlide() {
    if (productBannerInterval) {
      clearInterval(productBannerInterval);
      productBannerInterval = null;
    }
  }

  function restartBannerAutoSlide() {
    stopBannerAutoSlide();
    if (activeBanners.length >= 2) {
      startBannerAutoSlide();
    }
  }

  // Smooth responsive repositioning on screen resize
  let bannerResizeTimer = null;
  window.addEventListener('resize', () => {
    if (bannerResizeTimer) clearTimeout(bannerResizeTimer);
    bannerResizeTimer = setTimeout(() => {
      const bannerTrack = document.getElementById('productBannerTrack');
      if (bannerTrack && activeBanners && activeBanners.length > 0) {
        bannerTrack.style.transition = 'none';
        bannerTrack.style.transform = getTrackTransform(currentTrackVirtualIndex);
        updateActiveSlideClasses(currentTrackVirtualIndex);
      }
    }, 120);
  });

  // Reactive listener for banner changes from Admin
  window.addEventListener('networth_banners_updated', () => {
    lastRenderedBannersJson = '';
    renderProductPageBanner(true);
  });
  window.addEventListener('storage', (e) => {
    if (e.key === 'networth_local_banners' || e.key === 'networth_banner_global_enabled') {
      lastRenderedBannersJson = '';
      renderProductPageBanner(true);
    }
    if (e.key === 'networth_local_products' || e.key === 'networth_hidden_product_ids') {
      if (typeof reloadAndApplySort === 'function') reloadAndApplySort();
    }
  });

  // Reactive listener for product visibility changes from Admin
  window.addEventListener('networth_products_updated', () => {
    if (typeof reloadAndApplySort === 'function') reloadAndApplySort();
  });

  function renderHomeCategories(queryOverride) {
    const grid = document.getElementById('homeCategoriesGrid');
    if (!grid) return;

    const categories = state.categories || [];
    if (categories.length === 0) {
      if (!state.catalogLoaded) {
        grid.innerHTML = '<div style="grid-column: 1 / -1; text-align: center; padding: 20px; color: #5a6e62;">Loading categories...</div>';
      } else {
        grid.innerHTML = `
          <div style="grid-column: 1 / -1; text-align: center; padding: 36px 16px; background: #ffffff; border-radius: 14px; border: 1.5px dashed #d4af37;">
            <div style="font-weight: 800; color: #111111; font-size: 1rem; margin-bottom: 4px;">No categories available</div>
            <div style="font-size: 0.84rem; color: #64748b;">Categories added in the Admin Portal will appear here.</div>
          </div>`;
      }
      return;
    }

    const input = document.getElementById('categorySearchInput');
    const filterQuery = typeof queryOverride === 'string' ? queryOverride : (input ? input.value : '');
    const q = (filterQuery || '').trim().toLowerCase();

    const filtered = q
      ? categories.filter(c => (c.name || '').toLowerCase().includes(q))
      : categories;

    const countBadge = document.getElementById('categoryCountBadge');
    if (countBadge) {
      countBadge.textContent = `${filtered.length} ${filtered.length === 1 ? 'Category' : 'Categories'}`;
    }

    if (filtered.length === 0) {
      grid.innerHTML = `
        <div style="grid-column: 1 / -1; text-align: center; padding: 36px 16px; background: #ffffff; border-radius: 14px; border: 1.5px dashed #d4af37;">
          <div style="width: 44px; height: 44px; margin: 0 auto 10px auto; border-radius: 50%; background: #fdf8ee; color: #b8860b; border: 1px solid #ebd8af; display: flex; align-items: center; justify-content: center;">
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="11" cy="11" r="8"/>
              <line x1="21" y1="21" x2="16.65" y2="16.65"/>
            </svg>
          </div>
          <div style="font-weight: 800; color: #111111; font-size: 1rem; margin-bottom: 4px;">No categories found</div>
          <div style="font-size: 0.84rem; color: #64748b; margin-bottom: 14px;">No category matches "${window.CustomModal.escape(filterQuery)}"</div>
          <button type="button" id="clearHomeCatSearchBtn" class="btn btn-secondary btn-sm" style="padding: 7px 18px; font-weight: 700; border-color: #d4af37; color: #b8860b; background: #ffffff;">Clear Search</button>
        </div>
      `;
      grid.querySelector('#clearHomeCatSearchBtn')?.addEventListener('click', () => {
        if (input) {
          input.value = '';
          input.focus();
        }
        const clearBtn = document.getElementById('categorySearchClearBtn');
        if (clearBtn) clearBtn.style.display = 'none';
        renderHomeCategories('');
      });
      return;
    }

    grid.innerHTML = filtered.map(c => {
      let img = c.image_url || 'assets/images/logo.png';
      if (img.startsWith('assets/categories/') && !img.includes('?v=')) {
        img += '?v=20261109_1';
      }
      return `
        <div class="home-category-card" data-cat-name="${window.CustomModal.escape(c.name)}" role="button" tabindex="0">
          <div class="home-category-img-wrap">
            <img class="home-category-img" src="${img}" alt="${window.CustomModal.escape(c.name)}" loading="lazy" onerror="this.onerror=null;this.src='assets/images/logo.png';" />
          </div>
          <span class="home-category-title">${window.CustomModal.escape(c.name)}</span>
        </div>
      `;
    }).join('');

    grid.querySelectorAll('.home-category-card').forEach(card => {
      const handleClick = () => {
        const catName = card.getAttribute('data-cat-name');
        window.switchAppTab('shop', catName);
      };
      card.addEventListener('click', handleClick);
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          handleClick();
        }
      });
    });
  }

  /* ==========================================================================
     5. SHOP VIEW: CATEGORY PILLS, TOOLBAR, CATALOG & ADD TO CART
     ========================================================================== */
  function renderShopCategoryPills() {
    const bar = document.getElementById('shopCategoryPills');
    if (!bar) return;

    const categories = state.categories || [];

    // Check if a category was clicked from the Home Screen and needs promotion to the first position
    let promotedCat = null;
    let otherCategories = [...categories];

    if (state.homePromotedCategory) {
      const targetStr = String(state.homePromotedCategory).toLowerCase().trim();
      const matchIdx = otherCategories.findIndex(c => 
        (c.name && c.name.toLowerCase().trim() === targetStr) ||
        (c.id && c.id.toLowerCase().trim() === targetStr)
      );
      if (matchIdx >= 0) {
        promotedCat = otherCategories[matchIdx];
        otherCategories.splice(matchIdx, 1);
      }
    }

    const isCatActive = (c) => {
      if (!c) return false;
      const cur = String(state.selectedCategory || '').toLowerCase().trim();
      return (c.name && c.name.toLowerCase().trim() === cur) || 
             (c.id && c.id.toLowerCase().trim() === cur);
    };

    const promotedPill = promotedCat ? `
      <button type="button" class="shop-cat-pill ${isCatActive(promotedCat) ? 'active' : ''}" data-cat="${window.CustomModal.escape(promotedCat.name)}" data-is-promoted="true">
        ${window.CustomModal.escape(promotedCat.name)}
      </button>
    ` : '';

    const allPill = `
      <button type="button" class="shop-cat-pill ${state.selectedCategory === 'all' ? 'active' : ''}" data-cat="all">
        All Products
      </button>
    `;

    const catPills = otherCategories.map(c => `
      <button type="button" class="shop-cat-pill ${isCatActive(c) ? 'active' : ''}" data-cat="${window.CustomModal.escape(c.name)}">
        ${window.CustomModal.escape(c.name)}
      </button>
    `).join('');

    bar.innerHTML = promotedPill + allPill + catPills;

    bar.querySelectorAll('.shop-cat-pill').forEach(btn => {
      btn.addEventListener('click', () => {
        const cat = btn.getAttribute('data-cat');
        
        // If clicking any other category or 'all', restore buttons to their original positions
        if (state.homePromotedCategory) {
          const isSamePromoted = promotedCat && (
            cat === promotedCat.name || cat === promotedCat.id ||
            String(cat).toLowerCase().trim() === String(promotedCat.name).toLowerCase().trim()
          );
          if (!isSamePromoted) {
            state.homePromotedCategory = null;
          }
        }

        state.selectedCategory = cat;

        // Re-render pills immediately so that if homePromotedCategory was cleared,
        // the promoted button returns to its original position
        renderShopCategoryPills();

        // Sync with modular dropdown picker if available
        if (categoryPickerInstance) {
          categoryPickerInstance.setValue(cat);
        }

        applyFiltersAndSort();
      });
    });

    // If promoted from home, scroll pill container to show the promoted button at the start
    if (promotedCat) {
      try {
        bar.scrollTo({ left: 0, behavior: 'smooth' });
      } catch (_) {
        bar.scrollLeft = 0;
      }
    }
  }

  let categoryPickerInstance = null;
  let sortPickerInstance = null;

  function initToolbars() {
    try {
      if (categoryPickerMount && window.CustomPicker) {
        const opts = [
          { value: 'all', label: 'All Categories' },
          ...(state.categories.map(c => ({ value: c.name, label: c.name })))
        ];

        if (!categoryPickerInstance) {
          categoryPickerInstance = window.CustomPicker.create({
            container: categoryPickerMount,
            title: 'Filter by Category',
            options: opts,
            value: state.selectedCategory,
            placeholder: 'All Categories',
            searchable: true,
            onChange: (val) => {
              if (state.homePromotedCategory) {
                const targetStr = String(state.homePromotedCategory).toLowerCase().trim();
                const isSame = (val && (
                  val.toLowerCase().trim() === targetStr ||
                  (state.categories || []).some(c => 
                    (c.name.toLowerCase().trim() === targetStr || c.id.toLowerCase().trim() === targetStr) &&
                    (c.name === val || c.id === val)
                  )
                ));
                if (!isSame) state.homePromotedCategory = null;
              }
              state.selectedCategory = val;
              renderShopCategoryPills();
              applyFiltersAndSort();
            }
          });
        } else if (categoryPickerInstance.setOptions) {
          categoryPickerInstance.setOptions(opts, true);
        }
      }
    } catch (e) {
      console.warn('Category picker init notice:', e);
    }

    try {
      if (sortPickerMount && window.CustomPicker && !sortPickerInstance) {
        const sortOpts = [
          { value: 'newest', label: 'Newest Arrivals' },
          { value: 'oldest', label: 'Oldest First' },
          { value: 'price_asc', label: 'Price: Low to High' },
          { value: 'price_desc', label: 'Price: High to Low' },
          { value: 'name_asc', label: 'Name: A to Z' }
        ];

        sortPickerInstance = window.CustomPicker.create({
          container: sortPickerMount,
          title: 'Sort Catalog By',
          options: sortOpts,
          value: state.selectedSort,
          placeholder: 'Sort By',
          searchable: false,
          onChange: async (val) => {
            state.selectedSort = val;
            await reloadProductsForSort();
          }
        });
      }
    } catch (e) {
      console.warn('Sort picker init notice:', e);
    }

    // Search input listener with Global Catalog Search & Clear button
    try {
      const searchInput = document.getElementById('shopSearchInput');
      const clearBtn = document.getElementById('shopSearchClearBtn');
      if (searchInput && !searchInput._hasListener) {
        searchInput._hasListener = true;

        const handleSearch = () => {
          const val = searchInput.value.trim();
          if (clearBtn) clearBtn.style.display = searchInput.value ? 'flex' : 'none';

          if (globalSearchDebounceTimer) clearTimeout(globalSearchDebounceTimer);

          if (!val) {
            applyFiltersAndSort();
          } else {
            // Instant local preview for ultra-responsiveness
            const localMatches = state.products.filter(p => {
              if (window.SupabaseService?.isProductHidden?.(p)) return false;
              const title = (p.title || '').toLowerCase();
              const desc = (p.description || '').toLowerCase();
              const cat = (p.category_name || p.category_id || '').toLowerCase();
              const q = val.toLowerCase();
              return title.includes(q) || desc.includes(q) || cat.includes(q);
            });
            if (localMatches.length > 0) {
              state.filteredProducts = localMatches;
              renderProductGrid();
              updateSeeMoreButton();
            }

            // Global search against all products in Supabase
            globalSearchDebounceTimer = setTimeout(() => {
              performGlobalSearch(val);
            }, 250);
          }
        };

        searchInput.addEventListener('input', handleSearch);
        searchInput.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            if (globalSearchDebounceTimer) clearTimeout(globalSearchDebounceTimer);
            performGlobalSearch(searchInput.value.trim());
          }
        });

        if (clearBtn) {
          clearBtn.addEventListener('click', () => {
            searchInput.value = '';
            clearBtn.style.display = 'none';
            searchInput.focus();
            applyFiltersAndSort();
          });
        }
      }
    } catch (e) {}

    initViewToggle();
  }

  function applyProductView(view) {
    state.currentView = view || 'grid';
    try {
      localStorage.setItem('networth_product_view', state.currentView);
    } catch (e) {}

    const pGrid = document.getElementById('productGrid');
    const gridBtn = document.getElementById('viewGridBtn');
    const listBtn = document.getElementById('viewListBtn');

    if (pGrid) {
      if (state.currentView === 'list') {
        pGrid.classList.add('list-view');
      } else {
        pGrid.classList.remove('list-view');
      }
    }

    if (gridBtn && listBtn) {
      if (state.currentView === 'list') {
        gridBtn.classList.remove('active');
        listBtn.classList.add('active');
      } else {
        listBtn.classList.remove('active');
        gridBtn.classList.add('active');
      }
    }
  }
  window.switchProductView = applyProductView;

  function initViewToggle() {
    const gridBtn = document.getElementById('viewGridBtn');
    const listBtn = document.getElementById('viewListBtn');

    if (gridBtn) {
      gridBtn.onclick = (e) => {
        if (e && e.preventDefault) e.preventDefault();
        applyProductView('grid');
      };
      gridBtn.addEventListener('click', (e) => {
        e.preventDefault();
        applyProductView('grid');
      });
    }
    if (listBtn) {
      listBtn.onclick = (e) => {
        if (e && e.preventDefault) e.preventDefault();
        applyProductView('list');
      };
      listBtn.addEventListener('click', (e) => {
        e.preventDefault();
        applyProductView('list');
      });
    }
    applyProductView(state.currentView);
  }

  function getProductTimestamp(p) {
    if (!p) return 0;
    if (p.created_at) {
      const t = new Date(p.created_at).getTime();
      if (!isNaN(t) && t > 0) return t;
    }
    if (p.updated_at) {
      const t = new Date(p.updated_at).getTime();
      if (!isNaN(t) && t > 0) return t;
    }
    if (typeof p.id === 'string' && p.id.startsWith('prod-')) {
      const num = parseInt(p.id.replace('prod-', ''), 10);
      if (!isNaN(num) && num > 1000000000) return num;
    }
    return 0;
  }

  function compareProductsNewest(a, b) {
    const tA = getProductTimestamp(a);
    const tB = getProductTimestamp(b);
    if (tB !== tA) return tB - tA;

    const sA = (typeof a.sort_order === 'number') ? a.sort_order : 0;
    const sB = (typeof b.sort_order === 'number') ? b.sort_order : 0;
    if (sB !== sA) return sB - sA;

    return String(b.id || '').localeCompare(String(a.id || ''));
  }

  function compareProductsOldest(a, b) {
    const tA = getProductTimestamp(a);
    const tB = getProductTimestamp(b);
    if (tA !== tB) return tA - tB;

    const sA = (typeof a.sort_order === 'number') ? a.sort_order : 0;
    const sB = (typeof b.sort_order === 'number') ? b.sort_order : 0;
    if (sA !== sB) return sA - sB;

    return String(a.id || '').localeCompare(String(b.id || ''));
  }

  async function reloadProductsForSort() {
    if (productGrid) {
      productGrid.innerHTML = `
        <div class="sorting-loading-state" style="grid-column: 1 / -1; text-align: center; padding: 48px 20px; background: #ffffff; border-radius: 14px; border: 1px solid #e5e5e5;">
          <span class="spinner" style="display:inline-block; width:28px; height:28px; border:3px solid #d4af37; border-top-color:transparent; border-radius:50%; animation:spin 0.6s linear infinite; margin-bottom:12px;"></span>
          <h4 style="color: #111111; font-size: 1.05rem; font-weight: 700; margin-bottom: 4px;">Sorting products...</h4>
          <p style="color: #5a6e62; font-size: 0.85rem; margin: 0;">Applying sort across catalog...</p>
        </div>
      `;
    }
    try {
      const targetCat = (state.selectedCategory && state.selectedCategory !== 'all') ? resolveCategory(state.selectedCategory) : null;
      const sortedProducts = await window.SupabaseService.getProducts({
        limit: state.pageSize,
        offset: 0,
        categoryId: targetCat ? targetCat.id : 'all',
        sort: state.selectedSort,
        includeHidden: false
      });

      if (Array.isArray(sortedProducts)) {
        const suitFallbackDesc = 'These particular suits are authentic Italian bespoke cuts, crafted with premium high-twist wool blend fabric for exceptional drape, comfort, and structure. Designed with classic notch lapels, flap pockets, soft interior lining, and dual side vents. Meticulously finished for modern executives and high-profile occasions.';
        state.products = sortedProducts.filter(p => !window.SupabaseService?.isProductHidden?.(p)).map(p => {
          const raw = p.description || p.desc || p.details || p.product_description || '';
          if (!raw || typeof raw !== 'string' || !raw.trim()) {
            return { ...p, description: suitFallbackDesc };
          }
          return p;
        });
        state.hasMoreProducts = sortedProducts.length === state.pageSize;
      }
    } catch (err) {
      console.warn('Sort reload notice:', err);
    }
    applyFiltersAndSort();
  }

  function resolveCategory(catInput) {
    if (!catInput || catInput === 'all') return { id: 'all', name: 'All Products' };
    const raw = String(catInput).toLowerCase().trim();
    const found = (state.categories || []).find(c => 
      c && ((c.id && c.id.toLowerCase() === raw) || (c.name && c.name.toLowerCase() === raw))
    );
    if (found) {
      return { id: found.id, name: found.name };
    }
    return { id: catInput, name: catInput };
  }

  function matchesCategory(p, targetId, targetName) {
    if (!p) return false;
    const prodCatId = String(p.category_id || '').toLowerCase().trim();
    const prodCatField = String(p.category || '').toLowerCase().trim();
    const prodCatNameField = String(p.category_name || '').toLowerCase().trim();

    let resolvedCatName = '';
    if (prodCatId) {
      const match = (state.categories || []).find(c => c && c.id && c.id.toLowerCase() === prodCatId);
      if (match) resolvedCatName = (match.name || '').toLowerCase();
    }

    const candidateValues = [prodCatId, prodCatField, prodCatNameField, resolvedCatName].filter(Boolean);
    if (candidateValues.length === 0) return false;

    const tId = String(targetId || '').toLowerCase().trim();
    const tName = String(targetName || '').toLowerCase().trim();

    return candidateValues.some(val => 
      val === tId || 
      val === tName ||
      (tName && val.length >= 4 && tName.includes(val)) ||
      (tName && tName.length >= 4 && val.includes(tName))
    );
  }

  let isDefensiveFetching = false;
  let globalSearchDebounceTimer = null;
  let isGlobalSearching = false;
  let activeGlobalQuery = '';

  async function performGlobalSearch(query) {
    const trimmed = (query || '').trim();
    if (!trimmed) {
      activeGlobalQuery = '';
      applyFiltersAndSort();
      return;
    }

    activeGlobalQuery = trimmed;
    isGlobalSearching = true;

    // Show clean SVG loading state (NO EMOJIS!)
    if (productGrid) {
      productGrid.innerHTML = `
        <div class="search-cloud-loading" style="grid-column: 1 / -1; text-align: center; padding: 48px 20px; background: #ffffff; border-radius: 14px; border: 1px solid #e5e5e5;">
          <span class="spinner" style="display:inline-block; width:28px; height:28px; border:3px solid #d4af37; border-top-color:transparent; border-radius:50%; animation:spin 0.6s linear infinite; margin-bottom:12px;"></span>
          <h4 style="color: #111111; font-size: 1.05rem; font-weight: 700; margin-bottom: 4px;">Searching catalog for "${window.CustomModal.escape(trimmed)}"...</h4>
          <p style="color: #5a6e62; font-size: 0.85rem; margin: 0;">Searching across all products in the database...</p>
        </div>
      `;
    }

    try {
      const searchResults = await window.SupabaseService.searchProducts(trimmed, {
        sort: state.selectedSort,
        limit: 150
      });

      // Verify the input has not changed while network request was in-flight
      const currentInput = (document.getElementById('shopSearchInput')?.value || '').trim();
      if (currentInput !== trimmed) {
        return;
      }

      const suitFallbackDesc = 'These particular suits are authentic Italian bespoke cuts, crafted with premium high-twist wool blend fabric for exceptional drape, comfort, and structure. Designed with classic notch lapels, flap pockets, soft interior lining, and dual side vents. Meticulously finished for modern executives and high-profile occasions.';
      const processedResults = (searchResults || [])
        .filter(p => !window.SupabaseService?.isProductHidden?.(p))
        .map(p => {
          const raw = p.description || p.desc || p.details || p.product_description || '';
          if (!raw || typeof raw !== 'string' || !raw.trim()) {
            return { ...p, description: suitFallbackDesc };
          }
          return p;
        });

      // Merge into state.products so modal & cart access works
      const existingIds = new Set(state.products.map(p => p.id));
      const newItems = processedResults.filter(p => !existingIds.has(p.id));
      if (newItems.length > 0) {
        state.products = [...state.products, ...newItems];
      }

      // Sort search results based on user's current sort selection
      const sortChoice = String(state.selectedSort || 'newest').toLowerCase().trim();
      if (sortChoice === 'price_asc' || sortChoice === 'price-asc') {
        processedResults.sort((a, b) => (Number(a.price) || 0) - (Number(b.price) || 0));
      } else if (sortChoice === 'price_desc' || sortChoice === 'price-desc') {
        processedResults.sort((a, b) => (Number(b.price) || 0) - (Number(a.price) || 0));
      } else if (sortChoice === 'oldest') {
        processedResults.sort(compareProductsOldest);
      } else if (sortChoice === 'name_asc' || sortChoice === 'title_asc' || sortChoice === 'title-asc') {
        processedResults.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
      } else {
        processedResults.sort(compareProductsNewest);
      }

      state.filteredProducts = processedResults;
      renderProductGrid();
      updateSeeMoreButton();
    } catch (err) {
      console.warn('Global search notice:', err);
    } finally {
      isGlobalSearching = false;
    }
  }

  async function applyFiltersAndSort(isRetry = false) {
    const searchInput = document.getElementById('shopSearchInput');
    const query = searchInput ? searchInput.value.trim() : '';
    if (query) {
      performGlobalSearch(query);
      return;
    }

    let prods = [...state.products].filter(p => !window.SupabaseService?.isProductHidden?.(p));

    // Filter by Category
    let targetCat = null;
    if (state.selectedCategory && state.selectedCategory !== 'all') {
      targetCat = resolveCategory(state.selectedCategory);
      prods = prods.filter(p => matchesCategory(p, targetCat.id, targetCat.name));

      // Defensive Cloud Query Fallback: If in-memory filter returns 0 products, fetch directly from Supabase
      if (prods.length === 0 && !isRetry && !isDefensiveFetching) {
        if (productGrid) {
          productGrid.innerHTML = `
            <div class="category-cloud-loading" style="grid-column: 1 / -1; text-align: center; padding: 48px 20px; background: #ffffff; border-radius: 14px; border: 1px solid #e5e5e5;">
              <span class="spinner" style="display:inline-block; width:28px; height:28px; border:3px solid #d4af37; border-top-color:transparent; border-radius:50%; animation:spin 0.6s linear infinite; margin-bottom:12px;"></span>
              <h4 style="color: #111111; font-size: 1.05rem; font-weight: 700; margin-bottom: 4px;">Loading ${window.CustomModal.escape(targetCat.name)}...</h4>
              <p style="color: #5a6e62; font-size: 0.85rem; margin: 0;">Checking cloud catalog for latest products...</p>
            </div>
          `;
        }
        isDefensiveFetching = true;
        try {
          const cloudProds = await window.SupabaseService.getProducts({
            categoryId: targetCat.id,
            limit: state.pageSize,
            offset: 0,
            sort: state.selectedSort,
            includeHidden: false
          });

          if (Array.isArray(cloudProds) && cloudProds.length > 0) {
            const suitFallbackDesc = 'These particular suits are authentic Italian bespoke cuts, crafted with premium high-twist wool blend fabric for exceptional drape, comfort, and structure. Designed with classic notch lapels, flap pockets, soft interior lining, and dual side vents. Meticulously finished for modern executives and high-profile occasions.';
            const validCloud = cloudProds
              .filter(p => !window.SupabaseService?.isProductHidden?.(p))
              .map(p => {
                const raw = p.description || p.desc || p.details || p.product_description || '';
                if (!raw || typeof raw !== 'string' || !raw.trim()) {
                  return { ...p, description: suitFallbackDesc };
                }
                return p;
              });

            const existingIds = new Set(state.products.map(p => p.id));
            const newItems = validCloud.filter(p => !existingIds.has(p.id));
            if (newItems.length > 0) {
              state.products = [...state.products, ...newItems];
            }
            state.hasMoreProducts = cloudProds.length === state.pageSize;
          } else {
            state.hasMoreProducts = false;
          }
        } catch (err) {
          console.warn('Defensive cloud query error:', err);
        } finally {
          isDefensiveFetching = false;
        }

        return applyFiltersAndSort(true);
      }
    }

    // Sort
    const sortChoice = String(state.selectedSort || 'newest').toLowerCase().trim();
    if (sortChoice === 'price_asc' || sortChoice === 'price-asc') {
      prods.sort((a, b) => (Number(a.price) || 0) - (Number(b.price) || 0));
    } else if (sortChoice === 'price_desc' || sortChoice === 'price-desc') {
      prods.sort((a, b) => (Number(b.price) || 0) - (Number(a.price) || 0));
    } else if (sortChoice === 'oldest') {
      prods.sort(compareProductsOldest);
    } else if (sortChoice === 'name_asc' || sortChoice === 'title_asc' || sortChoice === 'title-asc') {
      prods.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
    } else {
      // Default: 'newest' -> Strictly newest arrivals first!
      prods.sort(compareProductsNewest);
    }

    state.filteredProducts = prods;
    renderProductGrid();
    updateSeeMoreButton();
  }

  function renderProductGrid() {
    if (!productGrid) return;

    // Ensure list-view class reflects state.currentView
    if (state.currentView === 'list') {
      productGrid.classList.add('list-view');
    } else {
      productGrid.classList.remove('list-view');
    }

    // Clear card image timers
    Object.values(state.productCardTimers).forEach(timer => clearInterval(timer));
    state.productCardTimers = {};

    if (state.filteredProducts.length === 0) {
      const searchInput = document.getElementById('shopSearchInput');
      const searchVal = searchInput ? searchInput.value.trim() : '';

      productGrid.innerHTML = `
        <div class="empty-state-card" style="grid-column: 1 / -1; text-align: center; padding: 44px 20px; background: #ffffff; border-radius: 14px; border: 1.5px dashed #d4af37;">
          <div style="width: 48px; height: 48px; margin: 0 auto 12px auto; border-radius: 50%; background: #fdf8ee; color: #b8860b; border: 1px solid #ebd8af; display: flex; align-items: center; justify-content: center;">
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="11" cy="11" r="8"/>
              <line x1="21" y1="21" x2="16.65" y2="16.65"/>
            </svg>
          </div>
          <h4 style="color: #111111; font-size: 1.15rem; font-weight: 800; margin-bottom: 6px;">
            ${searchVal ? 'No products found' : 'No matching products found'}
          </h4>
          <p style="color: #5a6e62; font-size: 0.88rem; margin-bottom: 16px;">
            ${searchVal ? `No products match "${window.CustomModal.escape(searchVal)}" across our catalog.` : 'Try selecting another category or typing another search keyword.'}
          </p>
          <button class="btn btn-primary" type="button" id="resetFiltersBtn" style="padding: 10px 22px; font-weight: 700; background-color: #d4af37; border-color: #c59b27; color: #000000 !important;">
            <span>${searchVal ? 'Clear Search &amp; View All' : 'View All Products'}</span>
          </button>
        </div>
      `;

      productGrid.querySelector('#resetFiltersBtn')?.addEventListener('click', () => {
        state.homePromotedCategory = null;
        state.selectedCategory = 'all';
        if (searchInput) searchInput.value = '';
        const clearBtn = document.getElementById('shopSearchClearBtn');
        if (clearBtn) clearBtn.style.display = 'none';
        renderShopCategoryPills();
        if (categoryPickerInstance) categoryPickerInstance.setValue('all');
        applyFiltersAndSort();
      });
      return;
    }

    productGrid.innerHTML = state.filteredProducts.map(prod => {
      const images = Array.isArray(prod.images) && prod.images.length > 0 
        ? prod.images 
        : ['assets/images/logo.png'];
      const hasMultipleImages = images.length > 1;

      const suitFallbackDesc = 'These particular suits are authentic Italian bespoke cuts, crafted with premium high-twist wool blend fabric for exceptional drape, comfort, and structure. Designed with classic notch lapels, flap pockets, soft interior lining, and dual side vents. Meticulously finished for modern executives and high-profile occasions.';
      const rawDesc = prod.description || prod.desc || prod.details || prod.product_description || '';
      const prodDesc = (typeof rawDesc === 'string' && rawDesc.trim().length > 0)
        ? rawDesc.trim()
        : ((prod.title && /suit/i.test(prod.title))
            ? suitFallbackDesc
            : 'Authentic premium quality product curated and verified by Networth Integreaterd services LTD.');

      return `
        <article class="product-card" data-prod-id="${prod.id}" tabindex="0">
          <div class="product-card-img-wrap" data-prod-id="${prod.id}">
            ${images.map((img, i) => `
              <img class="product-card-img-slide ${i === 0 ? 'active' : ''}" 
                   src="${img}" 
                   alt="${window.CustomModal.escape(prod.title)} View ${i + 1}" 
                   data-slide-idx="${i}" 
                   loading="lazy"
                   onerror="this.onerror=null;this.src='assets/images/logo.png';" />
            `).join('')}

            <span class="product-card-badge ${prod.in_stock ? 'in-stock' : 'out-of-stock'}">
              ${prod.in_stock ? 'In Stock' : 'Out of Stock'}
            </span>

            ${hasMultipleImages ? `
              <div class="product-card-dots">
                ${images.map((_, i) => `<span class="product-card-dot ${i === 0 ? 'active' : ''}"></span>`).join('')}
              </div>
            ` : ''}
          </div>

          <div class="product-card-content">
            <h3 class="product-card-title">${window.CustomModal.escape(prod.title)}</h3>
            <p class="product-card-desc">${window.CustomModal.escape(prodDesc)}</p>
            <div class="product-card-list-price">
              <span class="product-card-price">${window.formatNaira(prod.price)}</span>
            </div>
            <div class="product-card-divider"></div>
            <div class="product-card-grid-price">
              <span class="product-card-price">${window.formatNaira(prod.price)}</span>
            </div>
            <div class="product-card-footer">
              <button class="btn btn-add-to-cart" type="button" data-id="${prod.id}" title="Add to Cart">
                ${window.renderIcon('cart')}
                <span>Add to Cart</span>
              </button>
              <a href="https://wa.me/2349164504134?text=${encodeURIComponent(`Hello Networth Integreaterd services LTD, I would like to order: ${prod.title} (${window.formatNaira(prod.price)}). Is this available?`)}" target="_blank" rel="noopener" class="btn btn-whatsapp-order" title="Order on WhatsApp" onclick="event.stopPropagation();">
                ${window.renderIcon('whatsapp')}
                <span>Order on WhatsApp</span>
              </a>
            </div>
          </div>
        </article>
      `;
    }).join('');

    // Setup 2s auto-slide for each product card with multiple images
    state.filteredProducts.forEach(prod => {
      const images = Array.isArray(prod.images) ? prod.images : [];
      if (images.length > 1) {
        let currentIdx = 0;
        const wrap = productGrid.querySelector(`.product-card-img-wrap[data-prod-id="${prod.id}"]`);
        if (wrap) {
          const slides = wrap.querySelectorAll('.product-card-img-slide');
          const dots = wrap.querySelectorAll('.product-card-dot');

          state.productCardTimers[prod.id] = setInterval(() => {
            slides[currentIdx].classList.remove('active');
            if (dots[currentIdx]) dots[currentIdx].classList.remove('active');

            currentIdx = (currentIdx + 1) % slides.length;

            slides[currentIdx].classList.add('active');
            if (dots[currentIdx]) dots[currentIdx].classList.add('active');
          }, 2000);
        }
      }
    });

    // "Add to Cart" Button Clicks
    productGrid.querySelectorAll('.btn-add-to-cart').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const prodId = btn.getAttribute('data-id');
        const prod = state.filteredProducts.find(p => p.id === prodId) || state.products.find(p => p.id === prodId);
        if (prod) {
          addToCart(prod, 1);

          // Animate button state
          const originalHtml = btn.innerHTML;
          btn.innerHTML = `
            ${window.renderIcon('check')}
            <span>Added!</span>
          `;
          btn.style.backgroundColor = '#055c2a';

          setTimeout(() => {
            btn.innerHTML = originalHtml;
            btn.style.backgroundColor = '';
          }, 1200);
        }
      });
    });

    // Card click opens details modal
    productGrid.querySelectorAll('.product-card').forEach(card => {
      card.addEventListener('click', (e) => {
        if (e.target.closest('.btn-add-to-cart') || e.target.closest('.btn-whatsapp-order')) return;
        const prodId = card.getAttribute('data-prod-id');
        openProductDetailsModal(prodId);
      });
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          const prodId = card.getAttribute('data-prod-id');
          openProductDetailsModal(prodId);
        }
      });
    });

    // Ensure list-view/grid-view class is accurately synced
    applyProductView(state.currentView);
  }

  function updateSeeMoreButton() {
    if (!seeMoreContainer) return;
    const searchInput = document.getElementById('shopSearchInput');
    const isSearching = !!(searchInput && searchInput.value.trim());
    if (isSearching) {
      seeMoreContainer.style.display = 'none';
      return;
    }
    if (state.hasMoreProducts) {
      seeMoreContainer.style.display = 'block';
    } else {
      seeMoreContainer.style.display = 'none';
    }
  }

  function initSeeMore() {
    if (!seeMoreBtn) return;
    seeMoreBtn.addEventListener('click', async () => {
      if (state.isLoadingMore) return;
      state.isLoadingMore = true;
      seeMoreBtn.disabled = true;
      seeMoreBtn.innerHTML = `
        <span class="spinner" style="display:inline-block; width:16px; height:16px; border:2px solid #d4af37; border-top-color:transparent; border-radius:50%; animation:spin 0.6s linear infinite; margin-right:6px;"></span>
        <span>Loading More Products...</span>
      `;

      try {
        const targetCat = (state.selectedCategory && state.selectedCategory !== 'all') ? resolveCategory(state.selectedCategory) : null;
        const currentCategoryCount = targetCat
          ? state.products.filter(p => matchesCategory(p, targetCat.id, targetCat.name)).length
          : state.products.length;

        const nextProducts = await window.SupabaseService.getProducts({
          limit: state.pageSize,
          offset: currentCategoryCount,
          categoryId: targetCat ? targetCat.id : 'all',
          sort: state.selectedSort,
          includeHidden: false
        });

        if (Array.isArray(nextProducts) && nextProducts.length > 0) {
          const visibleBatch = nextProducts.filter(p => !window.SupabaseService?.isProductHidden?.(p));
          const existingIds = new Set(state.products.map(p => p.id));
          const newItems = visibleBatch.filter(p => !existingIds.has(p.id));
          if (newItems.length > 0) {
            state.products = [...state.products, ...newItems];
            state.hasMoreProducts = nextProducts.length === state.pageSize;
            applyFiltersAndSort();
          } else {
            state.hasMoreProducts = false;
            updateSeeMoreButton();
          }
        } else {
          state.hasMoreProducts = false;
          updateSeeMoreButton();
        }
      } catch (err) {
        console.error('See More notice:', err);
      } finally {
        state.isLoadingMore = false;
        seeMoreBtn.disabled = false;
        seeMoreBtn.innerHTML = `<span>See More Products</span>`;
      }
    });
  }

  /* ==========================================================================
     6. PRODUCT DETAILS MODAL & FULL VIEW LIGHTBOX
     ========================================================================== */
  let currentModalSelectedImage = '';

  function openProductDetailsModal(prodId) {
    let prod = state.products.find(p => p.id === prodId) || state.filteredProducts.find(p => p.id === prodId);
    if (!prod && window.SupabaseService?.getLocalProducts) {
      try {
        const localProds = window.SupabaseService.getLocalProducts(true) || [];
        prod = localProds.find(p => p.id === prodId);
      } catch (_) {}
    }
    if (!prod) {
      const cartItem = getCart().find(i => i.id === prodId || i.product_id === prodId);
      if (cartItem && window.SupabaseService?.getLocalProducts) {
        try {
          const localProds = window.SupabaseService.getLocalProducts(true) || [];
          prod = localProds.find(p => p.title && cartItem.title && p.title.toLowerCase().trim() === cartItem.title.toLowerCase().trim());
        } catch (_) {}
      }
      if (!prod && cartItem) {
        prod = {
          id: cartItem.id || prodId,
          title: cartItem.title,
          price: cartItem.price,
          description: cartItem.description || 'Authentic quality product available for nationwide delivery from Networth Integreaterd services LTD.',
          images: cartItem.images || (cartItem.image ? [cartItem.image] : ['assets/images/logo.png']),
          category: cartItem.category || 'General',
          in_stock: true
        };
      }
    }
    if (!prod || !detailsModalOverlay) return;

    state.activeProductForOrder = prod;
    const images = Array.isArray(prod.images) && prod.images.length > 0 
      ? prod.images 
      : ['assets/images/logo.png'];
    currentModalSelectedImage = images[0];

    const modalContent = detailsModalOverlay.querySelector('.product-details-modal-box');
    modalContent.innerHTML = `
      <div class="c-modal-header">
        <h3 class="c-modal-title">Product Details</h3>
        <button class="c-modal-close-btn" type="button" id="closeDetailsModalBtn" aria-label="Close Product Details">
          ${window.renderIcon('close')}
        </button>
      </div>

      <div class="details-modal-content">
        <div class="details-gallery-wrap">
          <div class="details-main-img-box" id="detailsMainImgBox" title="Click to view full image">
            <img class="details-main-img" id="detailsMainImg" src="${currentModalSelectedImage}" alt="${window.CustomModal.escape(prod.title)}" onerror="this.onerror=null;this.src='assets/images/logo.png';" />
            <div class="details-img-zoom-hint">
              ${window.renderIcon('search')}
              <span>Tap for Full View</span>
            </div>
          </div>

          <!-- Slideable Sub Images Under Preview -->
          ${images.length > 1 ? `
            <div class="details-sub-images-wrap">
              <button class="details-thumb-nav-btn prev" type="button" id="thumbNavPrevBtn" aria-label="Previous image">
                ${window.renderIcon('chevronLeft')}
              </button>
              <div class="details-sub-images-track" id="detailsSubImagesTrack">
                ${images.map((src, idx) => `
                  <div class="details-sub-thumb ${idx === 0 ? 'active' : ''}" data-src="${src}" role="button" tabindex="0" aria-label="Thumbnail ${idx + 1}">
                    <img src="${src}" alt="Thumb ${idx + 1}" onerror="this.onerror=null;this.src='assets/images/logo.png';" />
                  </div>
                `).join('')}
              </div>
              <button class="details-thumb-nav-btn next" type="button" id="thumbNavNextBtn" aria-label="Next image">
                ${window.renderIcon('chevronRight')}
              </button>
            </div>
          ` : ''}
        </div>

        <div class="details-info-wrap">
          <h2 class="details-product-title">${window.CustomModal.escape(prod.title)}</h2>

          <div class="details-badge-row">
            <span class="product-card-badge ${prod.in_stock ? 'in-stock' : 'out-of-stock'}">
              ${prod.in_stock ? 'In Stock' : 'Out of Stock'}
            </span>
          </div>

          <div class="details-product-price">${window.formatNaira(prod.price)}</div>

          <div class="details-desc-box">
            <span class="details-desc-heading">Product Description</span>
            <p class="details-desc-body">${window.CustomModal.escape(prod.description || 'No detailed description available.')}</p>
          </div>
        </div>
      </div>

      <!-- Floating Docked Action Bar with Solid Boundary Separator -->
      <div class="details-modal-footer">
        <button class="btn btn-primary" type="button" id="detailsAddToCartBtn" ${!prod.in_stock ? 'disabled' : ''}>
          ${window.renderIcon('cart')}
          <span>Add to Cart - ${window.formatNaira(prod.price)}</span>
        </button>

        <a href="https://wa.me/2349164504134?text=${encodeURIComponent(`Hello Networth Integreaterd services LTD, I would like to order: ${prod.title} (${window.formatNaira(prod.price)}). Is this available?`)}" target="_blank" rel="noopener" class="btn btn-secondary details-whatsapp-btn">
          <span style="color: #25D366; display: inline-flex; align-items: center; font-size: 16px; line-height: 1;">${window.renderIcon('whatsapp')}</span>
          <span>Order on WhatsApp</span>
        </a>
      </div>
    `;

    // Click sub-image to change main image
    const mainImg = modalContent.querySelector('#detailsMainImg');
    const thumbs = modalContent.querySelectorAll('.details-sub-thumb');
    const track = modalContent.querySelector('#detailsSubImagesTrack');
    const thumbPrevBtn = modalContent.querySelector('#thumbNavPrevBtn');
    const thumbNextBtn = modalContent.querySelector('#thumbNavNextBtn');

    thumbs.forEach(thumb => {
      const selectThumb = () => {
        thumbs.forEach(t => t.classList.remove('active'));
        thumb.classList.add('active');
        const src = thumb.getAttribute('data-src');
        currentModalSelectedImage = src;
        mainImg.src = src;
        thumb.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
      };
      thumb.addEventListener('click', selectThumb);
      thumb.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          selectThumb();
        }
      });
    });

    // Arrow navigation for thumbnails
    if (track && thumbPrevBtn && thumbNextBtn) {
      thumbPrevBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        track.scrollBy({ left: -140, behavior: 'smooth' });
      });
      thumbNextBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        track.scrollBy({ left: 140, behavior: 'smooth' });
      });
    }

    // Click main image -> Full View Lightbox (Only image & X under)
    modalContent.querySelector('#detailsMainImgBox')?.addEventListener('click', () => {
      openFullViewLightbox(currentModalSelectedImage);
    });

    // Add to Cart
    modalContent.querySelector('#detailsAddToCartBtn')?.addEventListener('click', () => {
      addToCart(prod, 1);
      detailsModalOverlay.classList.remove('active');
    });

    // Close Modal
    const closeModal = () => detailsModalOverlay.classList.remove('active');
    modalContent.querySelector('#closeDetailsModalBtn')?.addEventListener('click', closeModal);

    // Backdrop click close
    if (!detailsModalOverlay._hasBackdropListener) {
      detailsModalOverlay._hasBackdropListener = true;
      detailsModalOverlay.addEventListener('click', (e) => {
        if (e.target === detailsModalOverlay) {
          detailsModalOverlay.classList.remove('active');
        }
      });
    }

    detailsModalOverlay.classList.add('active');
  }

  /* ==========================================================================
     6. FULL VIEW LIGHTBOX (Strict Requirement: Only Image & X Under to Close, No Text)
     ========================================================================== */
  function openFullViewLightbox(imgSrc) {
    if (!fullViewLightbox || !imgSrc) return;

    // Move to end of body to ensure it overlays on top of ANY open modal
    document.body.appendChild(fullViewLightbox);

    fullViewLightbox.innerHTML = `
      <div class="full-view-img-container">
        <img class="full-view-img" src="${imgSrc}" alt="" />
      </div>
      <button class="full-view-close-under" type="button" id="fullViewCloseUnderBtn" aria-label="Close View">
        ${window.renderIcon ? window.renderIcon('close') : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="width: 22px; height: 22px;"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>'}
      </button>
    `;

    const closeBtn = fullViewLightbox.querySelector('#fullViewCloseUnderBtn');
    const closeLightbox = () => {
      fullViewLightbox.classList.remove('active');
      document.removeEventListener('keydown', onEsc);
    };

    const onEsc = (e) => {
      if (e.key === 'Escape') closeLightbox();
    };
    document.addEventListener('keydown', onEsc);

    if (closeBtn) {
      closeBtn.onclick = (e) => {
        e.stopPropagation();
        closeLightbox();
      };
    }

    fullViewLightbox.onclick = (e) => {
      if (e.target === fullViewLightbox || e.target.classList.contains('full-view-img-container')) {
        closeLightbox();
      }
    };

    fullViewLightbox.classList.add('active');
  }

  window.openFullViewLightbox = openFullViewLightbox;
  window.openLightbox = openFullViewLightbox;

  /* ==========================================================================
     7. CART VIEW (Items, Totals, Delivery Info & Protected Checkout)
     ========================================================================== */
  function renderCartView() {
    const container = document.getElementById('cartContentContainer');
    const clearBtn = document.getElementById('cartClearBtn');
    if (!container) return;

    const cart = getCart();
    if (cart.length === 0) {
      if (clearBtn) clearBtn.style.display = 'none';
      container.innerHTML = `
        <div class="cart-empty-state">
          <div class="cart-empty-icon">${window.renderIcon('cart')}</div>
          <h3 class="cart-empty-title">Your Shopping Cart is Empty</h3>
          <p class="cart-empty-sub">Explore our catalog and add the items you need to your cart.</p>
          <button class="btn btn-primary" type="button" id="cartStartShoppingBtn" style="padding: 12px 28px; font-weight: 800; background-color: #d4af37; border-color: #c59b27; color: #000000 !important;">
            ${window.renderIcon('shop')}
            <span>Start Shopping Now</span>
          </button>
        </div>
      `;
      container.querySelector('#cartStartShoppingBtn')?.addEventListener('click', () => {
        window.switchAppTab('shop');
      });
      return;
    }

    if (clearBtn) clearBtn.style.display = 'block';

    const subtotal = getCartTotal();
    const activeUser = getActiveUser() || {};
    const isLoggedIn = !!(activeUser && (activeUser.id || activeUser.whatsapp_number));

    container.innerHTML = `
      <div class="cart-items-list" id="cartItemsList">
        ${cart.map(item => `
          <div class="cart-item-card" data-item-id="${item.id}">
            <img src="${item.image || 'assets/images/logo.png'}" alt="${window.CustomModal.escape(item.title)}" class="cart-item-thumb" onerror="this.onerror=null;this.src='assets/images/logo.png';" />
            <div class="cart-item-info">
              <h4 class="cart-item-title">${window.CustomModal.escape(item.title)}</h4>
              <div class="cart-item-unit-price">${window.formatNaira(item.price)} each</div>
              <div style="font-size: 0.78rem; color: #5a6e62; margin-top: 2px;">Total: <strong style="color: #c59b27;">${window.formatNaira(item.price * item.quantity)}</strong></div>
            </div>
            <div class="cart-item-actions">
              <div class="cart-qty-group">
                <button type="button" class="cart-qty-btn cart-qty-minus" data-id="${item.id}" aria-label="Decrease quantity">&minus;</button>
                <span class="cart-qty-value">${item.quantity}</span>
                <button type="button" class="cart-qty-btn cart-qty-plus" data-id="${item.id}" aria-label="Increase quantity">&plus;</button>
              </div>
              <button type="button" class="cart-item-remove-btn" data-id="${item.id}" title="Remove item" aria-label="Remove item">
                ${window.renderIcon('trash')}
              </button>
            </div>
          </div>
        `).join('')}
      </div>

      <div class="cart-checkout-card">
        ${!isLoggedIn ? `
          <!-- Price Summary Breakdown (Pre-Auth) -->
          <div style="background: #ffffff; border: 1.5px solid #e5e5e5; border-radius: 12px; padding: 14px 16px; margin-bottom: 16px; box-shadow: 0 2px 10px rgba(10, 37, 64, 0.04);">
            <div class="cart-summary-line cart-total-line" style="display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; border: none; padding: 0; margin: 0;">
              <div style="display: inline-flex; align-items: baseline; gap: 6px; flex-wrap: wrap;">
                <span style="font-size: 1.02rem; font-weight: 900; color: #b8860b;">Items Total</span>
                <span style="font-size: 0.82rem; font-weight: 700; color: #5a6e62;">(${getCartCount()} ${getCartCount() === 1 ? 'item' : 'items'}):</span>
              </div>
              <strong id="cartGrandTotalText" style="color: #c59b27; font-size: 1.22rem; font-weight: 900; white-space: nowrap; margin-left: auto;">${window.formatNaira(subtotal)}</strong>
            </div>
          </div>

          <!-- Account Required Gate (No Unnecessary Forms) -->
          <div class="cart-auth-gate" style="background: #f0fbf4; border: 1.5px solid #d4af37; border-radius: 12px; padding: clamp(16px, 4vw, 22px) clamp(12px, 3.5vw, 18px); text-align: center;">
            <div class="cart-auth-gate-badge" style="width: 44px; height: 44px; border-radius: 50%; background: #fdf8ee; color: #c59b27; display: flex; align-items: center; justify-content: center; margin: 0 auto 10px auto; font-size: 22px;">
              <span style="display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; color: #c59b27;">
                ${window.renderIcon ? (window.renderIcon('user') || window.renderIcon('account')) : ''}
              </span>
            </div>
            <h4 style="font-size: 1.08rem; font-weight: 900; color: #111111; margin-bottom: 6px;">Sign In or Register to Checkout</h4>
            <p style="font-size: 0.84rem; color: #5a6e62; margin-bottom: 18px; line-height: 1.5; max-width: 440px; margin-left: auto; margin-right: auto;">
              An account is required to place your order, confirm delivery to your location, and generate your official receipt with instant tracking.
            </p>
            <div style="display: flex; gap: 10px; justify-content: center; flex-wrap: wrap;">
              <button type="button" class="btn btn-primary" id="cartPromptSignInBtn" style="padding: 11px 24px; font-size: 0.88rem; font-weight: 800; background-color: #d4af37; border-color: #c59b27; color: #000000 !important; display: inline-flex; align-items: center; gap: 6px;">
                ${window.renderIcon('login')}
                <span>Sign In to Continue</span>
              </button>
              <button type="button" class="btn btn-secondary" id="cartPromptSignUpBtn" style="padding: 11px 24px; font-size: 0.88rem; font-weight: 800; border-color: #d4af37; color: #b8860b; background: #ffffff; display: inline-flex; align-items: center; gap: 6px;">
                ${window.renderIcon('user')}
                <span>Create Free Account</span>
              </button>
            </div>

            <div style="margin-top: 14px; padding-top: 12px; border-top: 1px dashed #e5e5e5; width: 100%;">
              <button type="button" class="btn btn-cart-whatsapp" id="cartGuestWhatsAppCheckoutBtn" style="display: flex !important; flex-direction: row; align-items: center; justify-content: center; gap: 8px; width: 100% !important; max-width: 100% !important; box-sizing: border-box !important; white-space: normal !important; min-height: 48px; padding: 10px 14px;">
                ${window.renderIcon('whatsapp')}
                <span class="btn-cart-whatsapp-content">
                  <span class="btn-cart-whatsapp-action">Order on WhatsApp</span>
                  <span class="btn-cart-whatsapp-price">(${window.formatNaira(subtotal)})</span>
                </span>
              </button>
            </div>
          </div>
        ` : `
          <!-- Verified Account Delivery Details (No Forms To Fill) -->
          <div class="cart-delivery-card" style="background: #ffffff; border: 1.5px solid #e5e5e5; border-radius: 12px; padding: 16px; margin-bottom: 16px;">
            <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; border-bottom: 1px solid #e5e5e5; padding-bottom: 10px;">
              <div style="display: flex; align-items: center; gap: 8px; color: #111111; font-weight: 900; font-size: 0.96rem;">
                ${window.renderIcon('truck')}
                <span>Delivery Details & Contact</span>
              </div>
              <button type="button" class="btn btn-secondary btn-sm" id="cartEditProfileBtn" style="padding: 5px 12px; font-size: 0.78rem; font-weight: 700; border-color: #d4af37; color: #b8860b; background: #ffffff; display: inline-flex; align-items: center; gap: 5px;">
                ${window.renderIcon('edit')}
                <span>Change Address</span>
              </button>
            </div>

            ${(activeUser.address && activeUser.state && activeUser.lga) ? `
              <div style="font-size: 0.85rem; color: #1f2937; line-height: 1.6;">
                <div><strong style="color: #111111;">Deliver To:</strong> ${window.CustomModal.escape((activeUser.first_name || activeUser.name || 'Valued Customer') + (activeUser.last_name ? ' ' + activeUser.last_name : ''))}</div>
                <div style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap;">
                  <span style="color: #25D366; display: inline-flex; align-items: center; font-size: 14px; line-height: 1; flex-shrink: 0;">${window.renderIcon('whatsapp')}</span>
                  <strong style="color: #111111;">WhatsApp:</strong>
                  <span>${window.CustomModal.escape(activeUser.whatsapp_number || activeUser.phone || '')}</span>
                </div>
                ${activeUser.email ? `
                  <div style="display: flex; align-items: center; gap: 6px; color: #5a6e62; font-size: 0.82rem; word-break: break-all; overflow-wrap: anywhere; margin-top: 3px;">
                    <svg class="svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width: 13px; height: 13px; flex-shrink: 0; color: #c59b27;"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>
                    <span style="word-break: break-all; overflow-wrap: anywhere;">${window.CustomModal.escape(activeUser.email)}</span>
                  </div>
                ` : ''}
                <div style="margin-top: 6px; padding-top: 6px; border-top: 1px dashed #e5e5e5;">
                  <strong style="color: #111111;">Destination Address:</strong><br />
                  ${window.CustomModal.escape(activeUser.address)}, ${window.CustomModal.escape(activeUser.lga)}, <strong>${window.CustomModal.escape(activeUser.state)} State</strong>
                </div>
              </div>
            ` : `
              <div style="background: #fff8f5; border: 1px solid #fed7aa; border-radius: 8px; padding: 12px; font-size: 0.84rem; color: #9a3412;">
                <strong>Delivery address incomplete on your account.</strong><br />
                Please set your delivery address, state, and LGA to proceed with this order.
                <div style="margin-top: 8px;">
                  <button type="button" class="btn btn-primary btn-sm" id="cartSetAddressBtn" style="padding: 6px 14px; font-size: 0.8rem; background-color: #d4af37; border-color: #c59b27; color: #000000 !important;">
                    Set Delivery Address
                  </button>
                </div>
              </div>
            `}
          </div>

          <!-- Price Summary Breakdown -->
          <div style="background: #ffffff; border: 1.5px solid #e5e5e5; border-radius: 12px; padding: 14px 16px; margin-bottom: 16px; box-shadow: 0 2px 10px rgba(10, 37, 64, 0.04);">
            <div class="cart-summary-line cart-total-line" style="display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; border: none; padding: 0; margin: 0;">
              <div style="display: inline-flex; align-items: baseline; gap: 6px; flex-wrap: wrap;">
                <span style="font-size: 1.02rem; font-weight: 900; color: #b8860b;">Grand Total</span>
                <span style="font-size: 0.82rem; font-weight: 700; color: #5a6e62;">(${getCartCount()} ${getCartCount() === 1 ? 'item' : 'items'}):</span>
              </div>
              <strong id="cartGrandTotalText" style="color: #c59b27; font-size: 1.22rem; font-weight: 900; white-space: nowrap; margin-left: auto;">${window.formatNaira(subtotal)}</strong>
            </div>
          </div>

          <!-- Direct One-Click Checkout Button -->
          <button type="button" class="btn btn-primary btn-cart-checkout" id="cartDirectCheckoutBtn" style="display: flex !important; flex-direction: row; align-items: center; justify-content: center; gap: 8px; width: 100% !important; max-width: 100% !important; box-sizing: border-box !important; white-space: normal !important; min-height: 48px; padding: 11px 14px;">
            ${window.renderIcon('orderNow')}
            <span class="btn-cart-checkout-content">
              <span class="btn-cart-checkout-action">Confirm & Place Order</span>
              <span class="btn-cart-checkout-price">(${window.formatNaira(subtotal)})</span>
            </span>
          </button>

          <!-- Order on WhatsApp Underneath -->
          <button type="button" class="btn btn-cart-whatsapp" id="cartWhatsAppCheckoutBtn" style="display: flex !important; flex-direction: row; align-items: center; justify-content: center; gap: 8px; width: 100% !important; max-width: 100% !important; box-sizing: border-box !important; white-space: normal !important; min-height: 48px; padding: 10px 14px;">
            ${window.renderIcon('whatsapp')}
            <span class="btn-cart-whatsapp-content">
              <span class="btn-cart-whatsapp-action">Order on WhatsApp</span>
              <span class="btn-cart-whatsapp-price">(${window.formatNaira(subtotal)})</span>
            </span>
          </button>
        `}
      </div>
    `;

    // Handler to compile cart items and open WhatsApp templated chat
    const handleWhatsAppCartOrder = () => {
      const currentCart = getCart();
      if (!currentCart || currentCart.length === 0) {
        if (window.showToast) window.showToast('Your cart is empty', 'warning');
        return;
      }

      let grandTotal = 0;
      let totalQty = 0;
      const itemLines = currentCart.map((item, idx) => {
        const qty = Number(item.quantity) || 1;
        const price = Number(item.price) || 0;
        const lineTotal = price * qty;
        grandTotal += lineTotal;
        totalQty += qty;
        return `${idx + 1}. *${item.title}* (Qty: ${qty}) - ${window.formatNaira(lineTotal)}`;
      });

      let customerDetailsText = '';
      if (activeUser && (activeUser.first_name || activeUser.name || activeUser.address)) {
        const fullName = `${activeUser.first_name || activeUser.name || ''} ${activeUser.last_name || ''}`.trim() || 'Valued Customer';
        const phone = (activeUser.whatsapp_number || activeUser.phone || '').trim();
        const address = (activeUser.address || '').trim();
        const stateName = (activeUser.state || '').trim();
        const lgaName = (activeUser.lga || '').trim();

        customerDetailsText = `\n\n*Customer Delivery Information:*\n- Name: ${fullName}`;
        if (phone) customerDetailsText += `\n- WhatsApp / Phone: ${phone}`;
        if (address) {
          customerDetailsText += `\n- Destination: ${address}${lgaName ? ', ' + lgaName : ''}${stateName ? ', ' + stateName + ' State' : ''}`;
        }
      } else {
        customerDetailsText = `\n\n*Customer Information:*\n- Guest Order (I will provide delivery address via this chat)`;
      }

      const orderMessage = `Hello Networth Integreaterd services LTD, I would like to order the following items from my cart:\n\n${itemLines.join('\n')}\n\n*Total Items:* ${totalQty}\n*Grand Total:* *${window.formatNaira(grandTotal)}*${customerDetailsText}\n\nPlease confirm availability and payment details. Thank you!`;

      const whatsappUrl = `https://wa.me/2349164504134?text=${encodeURIComponent(orderMessage)}`;
      window.open(whatsappUrl, '_blank');
    };

    // Quantity controls
    container.querySelectorAll('.cart-qty-minus').forEach(btn => {
      btn.addEventListener('click', () => updateCartQuantity(btn.getAttribute('data-id'), -1));
    });
    container.querySelectorAll('.cart-qty-plus').forEach(btn => {
      btn.addEventListener('click', () => updateCartQuantity(btn.getAttribute('data-id'), 1));
    });
    container.querySelectorAll('.cart-item-remove-btn').forEach(btn => {
      btn.addEventListener('click', () => removeFromCart(btn.getAttribute('data-id')));
    });

    // Clicking on cart product image, title, or card opens the Product Details modal!
    container.querySelectorAll('.cart-item-card').forEach(card => {
      const itemId = card.getAttribute('data-item-id');
      card.querySelectorAll('.cart-item-thumb, .cart-item-title, .cart-item-info').forEach(clickable => {
        clickable.addEventListener('click', (e) => {
          if (e.target.closest('.cart-item-actions') || e.target.closest('.cart-qty-group') || e.target.closest('.cart-item-remove-btn')) return;
          openProductDetailsModal(itemId);
        });
      });
    });

    // Unauthenticated: Direct triggers to Login / Sign Up / WhatsApp
    if (!isLoggedIn) {
      container.querySelector('#cartPromptSignInBtn')?.addEventListener('click', () => {
        if (window.AuthModal) window.AuthModal.showSignIn(() => renderCartView());
      });
      container.querySelector('#cartPromptSignUpBtn')?.addEventListener('click', () => {
        if (window.AuthModal) window.AuthModal.showSignUp(() => renderCartView());
      });
      container.querySelector('#cartGuestWhatsAppCheckoutBtn')?.addEventListener('click', handleWhatsAppCartOrder);
      return;
    }

    // Authenticated WhatsApp Order Button
    container.querySelector('#cartWhatsAppCheckoutBtn')?.addEventListener('click', handleWhatsAppCartOrder);

    // Authenticated: Address Management
    const openAddressEditor = () => {
      if (window.AuthModal) {
        window.AuthModal.showProfile('profile', () => renderCartView());
      }
    };
    container.querySelector('#cartEditProfileBtn')?.addEventListener('click', openAddressEditor);
    container.querySelector('#cartSetAddressBtn')?.addEventListener('click', openAddressEditor);

    // Authenticated Direct Order Placement
    let isSubmittingCartOrder = false;
    const directCheckoutBtn = container.querySelector('#cartDirectCheckoutBtn');
    if (directCheckoutBtn) {
      directCheckoutBtn.addEventListener('click', async () => {
        if (isSubmittingCartOrder) return;

        const hasCompleteAddress = !!(activeUser.address && activeUser.state && activeUser.lga);
        if (!hasCompleteAddress) {
          window.CustomModal.confirm({
            title: 'Delivery Address Required',
            message: 'Please complete your delivery address and state in your profile so we can deliver your order.',
            confirmText: 'Set Address Now',
            cancelText: 'Cancel',
            onConfirm: openAddressEditor
          });
          return;
        }

        isSubmittingCartOrder = true;
        directCheckoutBtn.disabled = true;
        directCheckoutBtn.style.cursor = 'not-allowed';
        directCheckoutBtn.innerHTML = `
          <span class="spinner" style="display:inline-block; width:16px; height:16px; border:2px solid #ffffff; border-top-color:transparent; border-radius:50%; animation:spin 0.6s linear infinite; margin-right:6px;"></span>
          <span>Processing Order...</span>
        `;

        const currentCart = getCart();
        if (currentCart.length === 0) return;

        const firstName = activeUser.first_name || (activeUser.name ? activeUser.name.split(' ')[0] : 'Valued');
        const lastName = activeUser.last_name || (activeUser.name ? activeUser.name.split(' ').slice(1).join(' ') : 'Customer');
        const whatsapp = (activeUser.whatsapp_number || activeUser.phone || '').trim();
        const email = (activeUser.email || '').trim() || null;
        const stateName = (activeUser.state || '').trim();
        const lgaName = (activeUser.lga || '').trim();
        const address = (activeUser.address || '').trim();
        const baseTimestamp = Date.now();

        const orderTasks = currentCart.map(async (item, idx) => {
          const qty = Number(item.quantity) || 1;
          const unitPrice = Number(item.price) || 0;
          const itemTotal = unitPrice * qty;
          const orderId = `ord-${baseTimestamp}-${idx + 1}`;
          const retCode = `KL-${baseTimestamp.toString().slice(-6)}${idx + 1}`;
          const itemImg = item.image || (item.images && item.images[0]) || 'assets/images/logo.png';
          const titleWithQty = qty > 1 ? `${item.title} (Qty: ${qty})` : item.title;

          const orderData = {
            id: orderId,
            retrieval_code: retCode,
            user_id: activeUser.id,
            product_id: item.id || `cart-${idx + 1}`,
            product_title: titleWithQty,
            product_price: itemTotal,
            product_image: itemImg,
            first_name: firstName,
            last_name: lastName,
            whatsapp_number: whatsapp,
            email: email,
            state: stateName,
            lga: lgaName,
            address: address,
            status: 'pending',
            created_at: new Date(baseTimestamp + idx * 1000).toISOString()
          };

          try {
            await window.SupabaseService.createOrder(orderData);

            // Send individual rich Order Card into chat
            if (activeUser.id) {
              const orderChatMessage = {
                id: `msg-ord-${orderData.id}`,
                order_code: orderData.id,
                user_id: activeUser.id,
                user_name: `${firstName} ${lastName}`.trim(),
                user_whatsapp: whatsapp,
                sender: 'user',
                message_type: 'order_card',
                order_data: {
                  ...orderData,
                  id: orderData.id,
                  order_id: orderData.id,
                  first_name: firstName,
                  last_name: lastName,
                  whatsapp_number: whatsapp,
                  email: email,
                  state: stateName,
                  lga: lgaName,
                  address: address,
                  delivery_address: `${address}, ${lgaName}, ${stateName}`,
                  status: 'pending',
                  created_at: orderData.created_at
                },
                message: `Order Placed: ${orderData.product_title} (${window.formatNaira(itemTotal)}) - Status: Pending`,
                image_url: null,
                is_read_by_admin: false,
                is_read_by_user: true,
                deleted_for_everyone: false,
                deleted_for_user: false,
                deleted_for_admin: false,
                created_at: new Date(baseTimestamp + idx * 1000).toISOString()
              };
              await window.SupabaseService.sendUserChatMessage(orderChatMessage).catch(() => {});
            }
          } catch (itemErr) {
            console.error('Error placing individual item order:', itemErr);
          }
          return orderData;
        });

        const createdOrders = await Promise.all(orderTasks);

        // Immediate Cart Clear (Memory, LocalStorage, Cloud, Badges & UI View)
        lastExplicitClearTime = Date.now();
        lastLocalCartMutationTime = Date.now();
        saveCart([], false);
        renderCartView();

        if (activeUser && activeUser.id && window.SupabaseService?.syncUserCartToCloud) {
          await window.SupabaseService.syncUserCartToCloud(activeUser.id, []).catch(() => {});
        }

        isSubmittingCartOrder = false;

        // Open Order Success Modal & Receipt Download
        openOrderSuccessModal(createdOrders);
      });
    }
  }

  /* ==========================================================================
     8. REQUESTS VIEW (Orders & Sourcing Requests Tracking)
     ========================================================================== */
  let requestsFilterStatus = 'all';
  let requestsSortBy = 'newest';
  let requestsFilterPickerInstance = null;
  let requestsSortPickerInstance = null;
  let cachedUserOrders = [];

  function initRequestsPickers() {
    const filterMount = document.getElementById('requestsFilterPickerMount');
    const sortMount = document.getElementById('requestsSortPickerMount');

    if (filterMount && window.CustomPicker && !requestsFilterPickerInstance) {
      requestsFilterPickerInstance = window.CustomPicker.create({
        container: filterMount,
        id: 'requestsStatusFilterPicker',
        title: 'Filter by Status',
        placeholder: 'Filter: All Requests',
        options: [
          { value: 'all', label: 'All Requests' },
          { value: 'pending', label: 'Pending Review' },
          { value: 'approved', label: 'Approved (Confirmed)' },
          { value: 'shipping', label: 'In Transit / Shipping' },
          { value: 'delivered', label: 'Delivered' },
          { value: 'declined', label: 'Declined / Cancelled' }
        ],
        value: requestsFilterStatus,
        searchable: false,
        onChange: (val) => {
          requestsFilterStatus = val;
          renderRequestsView();
        }
      });
    }

    if (sortMount && window.CustomPicker && !requestsSortPickerInstance) {
      requestsSortPickerInstance = window.CustomPicker.create({
        container: sortMount,
        id: 'requestsSortPicker',
        title: 'Sort Requests By',
        placeholder: 'Sort: Newest First',
        options: [
          { value: 'newest', label: 'Newest First' },
          { value: 'oldest', label: 'Oldest First' },
          { value: 'price_desc', label: 'Price: High to Low' },
          { value: 'price_asc', label: 'Price: Low to High' },
          { value: 'title_asc', label: 'Item Name (A-Z)' }
        ],
        value: requestsSortBy,
        searchable: false,
        onChange: (val) => {
          requestsSortBy = val;
          renderRequestsView();
        }
      });
    }
  }

  async function renderRequestsView() {
    const container = document.getElementById('requestsListContainer');
    if (!container) return;

    initRequestsPickers();

    const activeUser = getActiveUser() || {};
    let userPhone = (activeUser.whatsapp_number || activeUser.phone || '').trim();
    let userEmail = (activeUser.email || '').trim();
    let userId = activeUser.id || null;

    let orders = cachedUserOrders.length > 0 ? cachedUserOrders : [];
    if (orders.length === 0 && window.SupabaseService?.getUserOrdersSync) {
      try {
        orders = window.SupabaseService.getUserOrdersSync(userId, userPhone, userEmail) || [];
        if (orders.length > 0) cachedUserOrders = orders;
      } catch (e) {}
    }

    const renderList = (orderItems, isStillLoading = false) => {
      const searchInput = document.getElementById('requestsSearchInput');
      const query = searchInput ? searchInput.value.toLowerCase().trim() : '';

      let filtered = (orderItems || []).filter(o => !window.SupabaseService?.isSourcingOrder || !window.SupabaseService.isSourcingOrder(o)).slice();

      // 1. Text Search Filter
      if (query) {
        filtered = filtered.filter(o => {
          const title = (o.product_title || '').toLowerCase();
          const code = (o.retrieval_code || o.id || '').toLowerCase();
          const dest = (o.address || o.lga || o.state || '').toLowerCase();
          return title.includes(query) || code.includes(query) || dest.includes(query);
        });
      }

      // 2. Status Filter
      if (requestsFilterStatus !== 'all') {
        filtered = filtered.filter(o => {
          const s = (o.status || 'pending').toLowerCase();
          if (requestsFilterStatus === 'shipping') return s === 'shipping' || s === 'shipped';
          if (requestsFilterStatus === 'declined') return s === 'declined' || s === 'cancelled';
          return s === requestsFilterStatus;
        });
      }

      // 3. Sorting
      filtered.sort((a, b) => {
        if (requestsSortBy === 'newest') {
          return (new Date(b.created_at || 0).getTime() || 0) - (new Date(a.created_at || 0).getTime() || 0);
        }
        if (requestsSortBy === 'oldest') {
          return (new Date(a.created_at || 0).getTime() || 0) - (new Date(b.created_at || 0).getTime() || 0);
        }
        if (requestsSortBy === 'price_desc') {
          return (Number(b.product_price) || 0) - (Number(a.product_price) || 0);
        }
        if (requestsSortBy === 'price_asc') {
          return (Number(a.product_price) || 0) - (Number(b.product_price) || 0);
        }
        if (requestsSortBy === 'title_asc') {
          return String(a.product_title || '').localeCompare(String(b.product_title || ''));
        }
        return 0;
      });

      if (filtered.length === 0) {
        if (isStillLoading) {
          container.innerHTML = `
            <div style="text-align: center; padding: 40px 20px; color: #5a6e62;">
              <span class="spinner" style="display:inline-block; width:26px; height:26px; border:2.5px solid #d4af37; border-top-color:transparent; border-radius:50%; animation:spin 0.6s linear infinite; margin-bottom:10px;"></span>
              <div style="font-size: 0.92rem; font-weight: 600;">Loading your orders and sourcing requests...</div>
            </div>
          `;
          return;
        }

        const isFiltered = !!(query || requestsFilterStatus !== 'all');
        container.innerHTML = `
          <div class="cart-empty-state">
            <div class="cart-empty-icon">${window.renderIcon('requests')}</div>
            <h3 class="cart-empty-title">${isFiltered ? 'No Matching Requests Found' : 'No Orders or Requests Found'}</h3>
            <p class="cart-empty-sub">${isFiltered ? 'No orders match your search query or selected status filter.' : 'When you place orders, they will appear here with live tracking.'}</p>
            ${isFiltered ? `
              <button class="btn btn-secondary" type="button" id="reqResetFilterBtn" style="padding: 10px 22px; font-weight: 700; border-color: #d4af37; color: #b8860b;">
                Reset Filter & Search
              </button>
            ` : `
              <button class="btn btn-primary" type="button" id="reqStartShoppingBtn" style="padding: 12px 28px; font-weight: 800; background-color: #d4af37; border-color: #c59b27; color: #000000 !important;">
                ${window.renderIcon('shop')}
                <span>Start Shopping Now</span>
              </button>
            `}
          </div>
        `;
        if (isFiltered) {
          container.querySelector('#reqResetFilterBtn')?.addEventListener('click', () => {
            if (searchInput) searchInput.value = '';
            requestsFilterStatus = 'all';
            requestsSortBy = 'newest';
            if (requestsFilterPickerInstance?.setValue) requestsFilterPickerInstance.setValue('all');
            if (requestsSortPickerInstance?.setValue) requestsSortPickerInstance.setValue('newest');
            renderRequestsView();
          });
        } else {
          container.querySelector('#reqStartShoppingBtn')?.addEventListener('click', () => {
            window.switchAppTab('shop');
          });
        }
        return;
      }

      container.innerHTML = filtered.map(o => {
        const status = (o.status || 'pending').toLowerCase();
        const code = o.retrieval_code || o.id || '';
        const dateStr = o.created_at ? new Date(o.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : 'Recent';
        const prodImg = window.resolveProductImage ? window.resolveProductImage(o) : (o.product_image || 'assets/images/logo.png');
        const productTitle = o.product_title || 'Custom Order';

        return `
          <div class="requests-card">
            <div class="request-card-top">
              <div style="flex: 1; min-width: 0; padding-right: 8px;">
                <h4 class="request-card-title">${window.CustomModal.escape(productTitle)}</h4>
                <div style="font-size: 0.78rem; color: #5a6e62; margin-top: 2px;">Placed on ${dateStr}</div>
              </div>
              <span class="request-status-pill ${status}">${status}</span>
            </div>

            <div style="display: flex; gap: 14px; align-items: flex-start; margin: 10px 0;">
              <img src="${prodImg}" alt="${window.CustomModal.escape(productTitle)}" class="request-card-thumb" onerror="this.src='assets/images/logo.png';" />
              <div style="flex: 1; min-width: 0;">
                <div class="request-card-info" style="margin-bottom: 0;">
                  <div><strong>Code:</strong> <span class="request-code-badge">${code}</span></div>
                  <div><strong>Amount:</strong> <span style="color: #c59b27; font-weight: 800;">${Number(o.product_price) > 0 ? window.formatNaira(o.product_price) : 'Quote Pending'}</span></div>
                  ${(o.state || o.address) ? `<div><strong>Destination:</strong> ${window.CustomModal.escape([o.address, o.lga, o.state ? o.state + ' State' : ''].filter(Boolean).join(', '))}</div>` : ''}
                </div>
              </div>
            </div>

            <div class="request-card-actions">
              ${Number(o.product_price) > 0 ? `
                <button type="button" class="btn btn-secondary btn-sm req-download-btn" data-id="${o.id}" style="padding: 6px 12px; font-size: 0.78rem;">
                  ${window.renderIcon('download')}
                  <span>Download Receipt</span>
                </button>
              ` : ''}
              <a href="https://wa.me/2349164504134?text=${encodeURIComponent(`Hello Networth Integreaterd services LTD, I am inquiring about my request (${code}): ${productTitle}`)}" target="_blank" rel="noopener" class="btn btn-secondary btn-sm" style="padding: 6px 12px; font-size: 0.78rem; color: #b8860b; border-color: #25D366; text-decoration: none;">
                ${window.renderIcon('whatsapp')}
                <span>WhatsApp Support</span>
              </a>
              <button type="button" class="btn btn-secondary btn-sm req-copy-btn" data-code="${code}" style="padding: 6px 12px; font-size: 0.78rem;">
                ${window.renderIcon('copy')}
                <span>Copy Code</span>
              </button>
            </div>
          </div>
        `;
      }).join('');

      // Attach listeners
      container.querySelectorAll('.req-download-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          const orderId = btn.getAttribute('data-id');
          const order = filtered.find(o => o.id === orderId);
          if (order) {
            window.CustomModal.toast({ message: 'Generating official receipt...', type: 'info' });
            await window.ReceiptGenerator.downloadReceiptImage(order);
            window.CustomModal.toast({ message: 'Receipt downloaded!', type: 'success' });
          }
        });
      });

      container.querySelectorAll('.req-copy-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const code = btn.getAttribute('data-code');
          navigator.clipboard?.writeText(code);
          window.CustomModal.toast({ message: `Copied code: ${code}`, type: 'success' });
        });
      });
    };

    // Initial render with sync cached data
    if (orders.length > 0) {
      renderList(orders, false);
    } else {
      renderList([], true); // Shows loading spinner
    }

    // Always fetch fresh orders from Supabase cloud database
    try {
      if (window.SupabaseService?.getUserOrders) {
        const fresh = await window.SupabaseService.getUserOrders(userId, userPhone, userEmail, 3000);
        if (fresh && Array.isArray(fresh)) {
          cachedUserOrders = fresh;
          renderList(fresh, false);
        }
      }
    } catch (e) {
      renderList(orders, false);
    }
  }

  /* ==========================================================================
     9. ACCOUNT VIEW (Profile, Live Chat, WhatsApp & Support)
     ========================================================================== */
  function renderAccountView() {
    const container = document.getElementById('accountContentContainer');
    if (!container) return;

    const activeUser = getActiveUser();
    const isLoggedIn = !!(activeUser && (activeUser.id || activeUser.whatsapp_number));
    const fullName = isLoggedIn ? [activeUser.first_name, activeUser.last_name].filter(Boolean).join(' ') || activeUser.name || 'Valued Customer' : 'Welcome to Networth Integrated';
    const avatarInitial = isLoggedIn ? (activeUser.first_name ? activeUser.first_name.charAt(0).toUpperCase() : (activeUser.name ? activeUser.name.charAt(0).toUpperCase() : 'U')) : '';
    const phone = isLoggedIn ? (activeUser.whatsapp_number || activeUser.phone || '') : '';
    const email = isLoggedIn ? (activeUser.email || '') : '';
    const state = isLoggedIn ? (activeUser.state || '') : '';
    const lga = isLoggedIn ? (activeUser.lga || '') : '';
    const address = isLoggedIn ? (activeUser.address || '') : '';
    const orders = window.SupabaseService.getLocalOrders ? window.SupabaseService.getLocalOrders() : [];

    container.innerHTML = `
      <div class="account-card-box">
        <div class="account-profile-header">
          <div class="account-avatar-circle" style="background: #d4af37; color: #000000; font-weight: 800; font-size: 1.4rem; display: flex; align-items: center; justify-content: center; width: 56px; height: 56px; border-radius: 50%; border: 2px solid #c59b27;">
            ${isLoggedIn ? avatarInitial : window.renderIcon('account')}
          </div>
          <div style="flex: 1; min-width: 0; overflow: hidden;">
            <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
              <h3 class="account-user-name" style="margin: 0; font-size: 1.15rem; font-weight: 800; color: #111111; word-break: break-word;">
                ${window.CustomModal.escape(fullName)}
              </h3>
              ${isLoggedIn ? `<span style="display: inline-flex; align-items: center; gap: 4px; font-size: 0.72rem; font-weight: 700; color: #c59b27; background: #fdf8ee; padding: 2px 8px; border-radius: 999px; border: 1px solid #c2e8d0; flex-shrink: 0;">Verified Customer</span>` : ''}
            </div>
            <div class="account-user-phone" style="margin-top: 6px; display: flex; flex-direction: column; gap: 4px; font-size: 0.82rem;">
              ${isLoggedIn ? `
                <div style="display: flex; align-items: center; gap: 6px; color: #b8860b; font-weight: 600;">
                  <span style="color: #25D366; display: inline-flex; align-items: center; font-size: 14px; line-height: 1; flex-shrink: 0;">${window.renderIcon('whatsapp')}</span>
                  <span>${window.CustomModal.escape(phone)}</span>
                </div>
                ${email ? `
                  <div style="display: flex; align-items: center; gap: 6px; color: #5a6e62; font-weight: 500; font-size: 0.78rem; word-break: break-all; overflow-wrap: anywhere; max-width: 100%; min-width: 0; overflow: hidden;">
                    <svg class="svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width: 13px; height: 13px; flex-shrink: 0; color: #c59b27;"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>
                    <span style="word-break: break-all; overflow-wrap: anywhere; min-width: 0; max-width: 100%; display: inline-block;">${window.CustomModal.escape(email)}</span>
                  </div>
                ` : ''}
              ` : 'Sign in to track orders, manage your profile and chat.'}
            </div>
          </div>
        </div>

        ${isLoggedIn ? `
          <div style="background: #ffffff; border: 1px solid #e5e5e5; border-radius: 10px; padding: 12px 14px; margin: 12px 0; display: flex; justify-content: space-around; text-align: center;">
            <div style="cursor: pointer;" id="accountOrdersStatBox">
              <div style="font-size: 1.25rem; font-weight: 900; color: #c59b27;">${orders.length}</div>
              <div style="font-size: 0.74rem; color: #5a6e62; font-weight: 700;">Orders / Requests</div>
            </div>
            <div style="border-left: 1px solid #e5e5e5;"></div>
            <div>
              <div style="font-size: 1.25rem; font-weight: 900; color: #c59b27;">${state || 'NG'}</div>
              <div style="font-size: 0.74rem; color: #5a6e62; font-weight: 700;">Delivery State</div>
            </div>
          </div>

          <div style="background: #ffffff; border: 1px solid #e5e5e5; border-radius: 10px; padding: 12px 14px; margin-bottom: 12px; font-size: 0.84rem; color: #1f2937;">
            <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px;">
              <strong style="color: #111111;">Default Delivery Address:</strong>
              <button type="button" id="accountQuickEditAddrBtn" style="background: none; border: none; color: #c59b27; font-size: 0.78rem; font-weight: 700; cursor: pointer; text-decoration: underline; padding: 0;">Edit</button>
            </div>
            <div>${window.CustomModal.escape(address || 'No street address set yet')}, ${window.CustomModal.escape(lga || '')}, <strong>${window.CustomModal.escape(state || 'NG')} State</strong></div>
          </div>

          <div style="display: flex; gap: 8px; flex-wrap: wrap;">
            <button type="button" class="btn btn-secondary btn-sm" id="accountEditProfileBtn" style="flex: 1 1 calc(50% - 4px); justify-content: center; padding: 9px 10px; font-size: 0.8rem;">
              ${window.renderIcon('edit')}
              <span>Edit Profile &amp; Address</span>
            </button>
            <button type="button" class="btn btn-secondary btn-sm" id="accountChangePassBtn" style="flex: 1 1 calc(50% - 4px); justify-content: center; padding: 9px 10px; font-size: 0.8rem;">
              <svg class="svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width: 14px; height: 14px;"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
              <span>Change Password</span>
            </button>
            <a href="chat.html" class="btn btn-secondary btn-sm" id="accountDirectChatBtn" style="flex: 1 1 100%; justify-content: center; padding: 11px 14px; font-size: 0.86rem; font-weight: 800; background: #eaf7f0; color: #075b2a; border: 1.5px solid #d4af37; text-decoration: none; display: inline-flex; align-items: center; gap: 8px;">
              <span style="display: inline-flex; align-items: center; color: #c59b27; flex-shrink: 0;">${window.renderIcon('chat')}</span>
              <span>Open Live Chat</span>
              <span class="account-chat-indicator" id="accountChatIndicator" style="display: none; background: #dc2626; color: #ffffff; font-size: 0.72rem; font-weight: 800; padding: 2px 8px; border-radius: 999px; line-height: 1.2; margin-left: 6px; align-items: center; gap: 4px;">
                <span id="accountChatBadgeText">0</span> New
              </span>
            </a>
            <button type="button" class="btn btn-primary btn-sm" id="accountTrackOrdersBtn" style="flex: 1 1 100%; justify-content: center; padding: 10px; font-size: 0.82rem; font-weight: 700; background-color: #d4af37; border-color: #c59b27; color: #000000 !important;">
              <svg class="svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width: 14px; height: 14px;"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
              <span>View My Orders &amp; Tracking (${orders.length})</span>
            </button>
            <button type="button" class="btn btn-danger btn-sm" id="accountLogoutBtn" style="flex: 1 1 100%; justify-content: center; padding: 9px 10px; font-size: 0.8rem;">
              <span>Log Out</span>
            </button>
          </div>
        ` : `
          <div style="display: flex; gap: 10px;">
            <button type="button" class="btn btn-primary" id="accountSignInBtn" style="flex: 1; justify-content: center; padding: 11px; background-color: #d4af37; border-color: #c59b27; color: #000000 !important;">
              <span>Sign In</span>
            </button>
            <button type="button" class="btn btn-secondary" id="accountRegisterBtn" style="flex: 1; justify-content: center; padding: 11px;">
              <span>Create Account</span>
            </button>
          </div>
          <div style="text-align: center; margin-top: 10px;">
            <button type="button" id="accountForgotBtn" style="background: none; border: none; color: #c59b27; font-size: 0.84rem; font-weight: 700; cursor: pointer; text-decoration: underline; padding: 4px 8px;">
              Forgot Password?
            </button>
          </div>
        `}
      </div>

      <!-- Support & Direct Communication Card -->
      <div class="account-card-box">
        <h4 style="color: #111111; font-size: 1.05rem; font-weight: 800; margin-bottom: 12px;">Support & Contact Channels</h4>

        <a href="chat.html" class="account-support-btn">
          <div class="support-left" style="display: flex; align-items: center; gap: 8px;">
            <span style="color: #c59b27; display: inline-flex; align-items: center;">${window.renderIcon('chat')}</span>
            <span>Live Chat</span>
            <span id="accountSupportChannelBadge" style="display: none; background: #dc2626; color: #ffffff; font-size: 0.72rem; font-weight: 800; padding: 2px 7px; border-radius: 999px; line-height: 1.2; margin-left: 6px;">0 New</span>
          </div>
          <span class="support-action-link">
            <span>Open Chat</span>
            <svg class="support-chevron-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
          </span>
        </a>

        <a href="https://wa.me/2349164504134?text=Hello%20Networth%20Integreaterd%20services%20LTD%2C%20I%20am%20inquiring%20about%20my%20account" target="_blank" rel="noopener" class="account-support-btn">
          <div class="support-left">
            <span style="color: #25D366;">${window.renderIcon('whatsapp')}</span>
            <span>WhatsApp Business Desk (+234 916 450 4134)</span>
          </div>
          <span class="support-action-link">
            <span>Chat</span>
            <svg class="support-chevron-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
          </span>
        </a>

        <a href="tel:+2349164504134" class="account-support-btn">
          <div class="support-left">
            <span style="color: #c59b27;">${window.renderIcon('phone')}</span>
            <span>Direct Enquiries Line (+234 916 450 4134)</span>
          </div>
          <span class="support-action-link">
            <span>Call</span>
            <svg class="support-chevron-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
          </span>
        </a>
      </div>

      <!-- Corporate Accreditation & CAC Verification Card -->
      <div class="account-card-box">
        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; flex-wrap: wrap; gap: 6px;">
          <h4 style="color: #111111; font-size: 1.05rem; font-weight: 800; margin: 0; display: flex; align-items: center; gap: 8px;">
            <svg class="svg-icon" viewBox="0 0 24 24" fill="none" stroke="#d4af37" stroke-width="2.2" style="width: 20px; height: 20px;"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
            <span>Corporate Governance &amp; CAC Profile</span>
          </h4>
          <span style="font-size: 0.72rem; font-weight: 800; color: #c59b27; background: #fdf8ee; padding: 3px 9px; border-radius: 999px; border: 1px solid #c2e8d0;">
            CAC Verified Entity
          </span>
        </div>

        <p style="font-size: 0.82rem; color: #4b5563; line-height: 1.5; margin-bottom: 12px;">
          <strong>Networth Integreaterd services LTD</strong> is an indigenous Nigerian enterprise fully registered under the Corporate Affairs Commission (CAC).
        </p>

        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 10px; margin-bottom: 14px;">
          <div style="background: #f9fbf9; border: 1px solid #e2ece5; border-radius: 8px; padding: 10px 12px; font-size: 0.8rem;">
            <div style="color: #6b7280; font-size: 0.72rem; text-transform: uppercase; font-weight: 700;">Statutory Authority</div>
            <strong style="color: #111111;">Corporate Affairs Commission (CAC)</strong>
            <div style="color: #c59b27; font-weight: 600; margin-top: 2px;">Fully Registered Indigenous Enterprise</div>
          </div>

          <div style="background: #f9fbf9; border: 1px solid #e2ece5; border-radius: 8px; padding: 10px 12px; font-size: 0.8rem;">
            <div style="color: #6b7280; font-size: 0.72rem; text-transform: uppercase; font-weight: 700;">Executive Leadership</div>
            <strong style="color: #111111;">Networth Integrated Services LTD</strong>
            <div style="color: #4b5563; margin-top: 2px;">Corporate Desk</div>
          </div>

          <div style="background: #f9fbf9; border: 1px solid #e2ece5; border-radius: 8px; padding: 10px 12px; font-size: 0.8rem;">
            <div style="color: #6b7280; font-size: 0.72rem; text-transform: uppercase; font-weight: 700;">Tax &amp; Safety Compliance</div>
            <strong style="color: #111111;">FIRS (TIN &amp; VAT) &bull; NSITF</strong>
            <div style="color: #4b5563; margin-top: 2px;">100% Nigerian Content (NOGICD)</div>
          </div>

          <div style="background: #f9fbf9; border: 1px solid #e2ece5; border-radius: 8px; padding: 10px 12px; font-size: 0.8rem;">
            <div style="color: #6b7280; font-size: 0.72rem; text-transform: uppercase; font-weight: 700;">Operational Base</div>
            <strong style="color: #111111;">Lagos, Nigeria</strong>
            <div style="color: #4b5563; margin-top: 2px;">Felele</div>
          </div>
        </div>

        <div class="account-corp-actions">
          <a href="https://victoriv2.github.io/Networth-Integreaterd-services-LTD/" target="_blank" rel="noopener" class="btn btn-secondary btn-sm account-corp-btn">
            <svg class="svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width: 15px; height: 15px; flex-shrink: 0;"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
            <span>Visit Corporate Website</span>
          </a>
          <a href="https://wa.me/2349164504134?text=Hello%20Networth%20Integreaterd%20services%20LTD%2C%20I%20would%20like%20to%20submit%20a%20formal%20corporate%20RFQ%20%2F%20Inquiry" target="_blank" rel="noopener" class="btn btn-secondary btn-sm account-corp-btn">
            <svg class="svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width: 15px; height: 15px; flex-shrink: 0;"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
            <span>Send Formal RFQ / Inquiry</span>
          </a>
        </div>
      </div>
    `;

    // Hook up buttons
    container.querySelector('#accountSignInBtn')?.addEventListener('click', () => {
      if (window.AuthModal) {
        window.AuthModal.showSignIn(() => renderAccountView());
      }
    });
    container.querySelector('#accountRegisterBtn')?.addEventListener('click', () => {
      if (window.AuthModal) {
        window.AuthModal.showSignUp(() => renderAccountView());
      }
    });
    container.querySelector('#accountForgotBtn')?.addEventListener('click', () => {
      if (window.AuthModal && window.AuthModal.showForgotPassword) {
        window.AuthModal.showForgotPassword(() => renderAccountView());
      }
    });
    container.querySelector('#accountEditProfileBtn')?.addEventListener('click', () => {
      if (window.AuthModal) {
        window.AuthModal.showProfile('profile', () => renderAccountView());
      }
    });
    container.querySelector('#accountQuickEditAddrBtn')?.addEventListener('click', () => {
      if (window.AuthModal) {
        window.AuthModal.showProfile('profile', () => renderAccountView());
      }
    });
    container.querySelector('#accountChangePassBtn')?.addEventListener('click', () => {
      if (window.AuthModal) {
        window.AuthModal.showProfile('security', () => renderAccountView());
      }
    });
    container.querySelector('#accountTrackOrdersBtn')?.addEventListener('click', () => {
      window.switchAppTab('requests');
    });
    container.querySelector('#accountOrdersStatBox')?.addEventListener('click', () => {
      window.switchAppTab('requests');
    });
    container.querySelector('#accountLogoutBtn')?.addEventListener('click', () => {
      window.CustomModal.confirm({
        title: 'Confirm Logout',
        message: 'Are you sure you want to log out of your Networth Integreaterd services LTD account?',
        confirmText: 'Log Out',
        onConfirm: () => {
          window.SupabaseService.logoutUser();
          renderAccountView();
          window.CustomModal.toast({ message: 'Logged out successfully.', type: 'info' });
        }
      });
    });

    // Check and populate unread messages indicator immediately
    checkUnreadMessages();
  }

  /* ==========================================================================
     10. ORDER CONFIRMATION MODAL & RECEIPT DOWNLOAD
     ========================================================================== */
  function openOrderSuccessModal(ordersInput) {
    if (!orderSuccessModal) return;
    const orders = Array.isArray(ordersInput) ? ordersInput : [ordersInput];
    if (orders.length === 0) return;
    const firstOrder = orders[0];
    const isMulti = orders.length > 1;
    const totalOrderAmount = orders.reduce((sum, o) => sum + (Number(o.product_price) || 0), 0);

    orderSuccessModal.innerHTML = `
      <div class="c-modal-box" style="max-width: 520px; max-height: 90vh; max-height: 90dvh; display: flex; flex-direction: column;">
        <div class="c-modal-header" style="flex-shrink: 0;">
          <div class="c-modal-title-wrap">
            <h3 class="c-modal-title" style="color: #c59b27;">${isMulti ? `${orders.length} Order Requests Received!` : 'Order Request Received!'}</h3>
          </div>
          <button class="c-modal-close-btn" type="button" id="closeSuccessModalBtn">
            ${window.renderIcon('close')}
          </button>
        </div>

        <div class="c-modal-body receipt-modal-box" style="overflow-y: auto; -webkit-overflow-scrolling: touch; flex: 1 1 auto; padding: 18px 20px; display: flex; flex-direction: column; gap: 12px; text-align: left;">
          <p class="c-modal-text" style="margin: 0; font-size: 0.88rem; color: #2d3748; flex-shrink: 0; line-height: 1.45;">
            Thank you, <strong>${window.CustomModal.escape(firstOrder.first_name)} ${window.CustomModal.escape(firstOrder.last_name)}</strong>! Your ${isMulti ? `<strong>${orders.length} orders</strong> have` : 'order has'} been recorded and sent to our admin team.
          </p>

          <div class="success-order-items-list" style="display: flex; flex-direction: column; gap: 10px; flex-shrink: 0; min-height: fit-content; margin: 4px 0;">
            ${orders.map((ord, i) => `
              <div class="success-order-item-card" style="background: #ffffff; border: 1.5px solid #e5e5e5; border-radius: 12px; padding: 12px 14px; text-align: left; display: flex; gap: 12px; align-items: center; flex-shrink: 0; min-height: 78px; box-sizing: border-box;">
                <img src="${ord.product_image || 'assets/images/logo.png'}" alt="Item" style="width: 58px; height: 58px; min-width: 58px; border-radius: 8px; object-fit: cover; border: 1.5px solid #e5e5e5; background: #ffffff; flex-shrink: 0;" onerror="this.src='assets/images/logo.png';" />
                <div style="flex: 1; min-width: 0;">
                  <div style="color: #111111; font-weight: 800; font-size: 0.92rem; line-height: 1.35; margin-bottom: 3px; word-break: break-word;">${window.CustomModal.escape(ord.product_title)}</div>
                  <div style="color: #c59b27; font-weight: 800; font-size: 0.95rem; margin-bottom: 4px;">${window.formatNaira(ord.product_price)}</div>
                  <div style="font-size: 0.76rem; color: #5a6e62;">Code: <span style="font-family: monospace; font-weight: 700; background: #fdf8ee; padding: 2px 6px; border-radius: 4px; color: #111111; border: 1px solid #c2e8d0;">${ord.retrieval_code || ord.id}</span></div>
                </div>
                <button type="button" class="btn btn-secondary btn-sm req-mini-download-btn" data-index="${i}" title="Download Receipt" style="padding: 8px 10px; font-size: 0.78rem; flex-shrink: 0;">
                  ${window.renderIcon('download')}
                </button>
              </div>
            `).join('')}
          </div>

          <div style="background: #fdf8ee; border: 1px solid #c2e8d0; border-radius: 10px; padding: 10px 14px; font-size: 0.86rem; display: flex; justify-content: space-between; align-items: center; flex-shrink: 0;">
            <span style="font-weight: 700; color: #111111;">Total Order Value:</span>
            <span style="color: #c59b27; font-weight: 900; font-size: 1.15rem;">${window.formatNaira(totalOrderAmount)}</span>
          </div>

          <div class="code-actions-row" style="flex-shrink: 0;">
            <button class="btn btn-primary" type="button" id="downloadReceiptImgBtn" style="width: 100%; justify-content: center; padding: 12px; font-weight: 800; background-color: #d4af37; border-color: #c59b27; color: #000000 !important;">
              ${window.renderIcon('download')}
              <span>Download Official Receipt${isMulti ? 's' : ''}</span>
            </button>
          </div>

          <p style="font-size: 0.78rem; color: #5a6e62; margin: 0; flex-shrink: 0; line-height: 1.4;">
            Official receipts carry Networth Integreaterd services LTD brand details, shop contact info, and retrieval codes for instant tracking.
          </p>

          <div style="padding-top: 10px; border-top: 1px solid #e5e5e5; display: flex; flex-direction: column; gap: 8px; flex-shrink: 0;">
            <button class="btn btn-primary" style="width: 100%; justify-content: center; background-color: #b8860b; border-color: #996515; color: #000000 !important; padding: 11px;" type="button" id="trackInOrdersBtn">
              <svg class="svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width: 15px; height: 15px;"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
              <span>Track in Requests Tab</span>
            </button>
            <a href="chat.html" class="btn btn-secondary" style="width: 100%; justify-content: center; text-decoration: none; padding: 11px;" id="orderSuccessChatBtn">
              ${window.renderIcon('chat')}
              <span>Open Direct Chat with Support</span>
            </a>
            <button class="btn btn-secondary" style="width: 100%; justify-content: center; padding: 11px;" type="button" id="closeSuccessBtn">
              <span>Continue Shopping</span>
            </button>
          </div>
        </div>
      </div>
    `;

    // Download handlers
    orderSuccessModal.querySelectorAll('.req-mini-download-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const idx = Number(btn.getAttribute('data-index'));
        if (orders[idx]) {
          window.CustomModal.toast({ message: 'Generating receipt...', type: 'info' });
          await window.ReceiptGenerator.downloadReceiptImage(orders[idx]);
          window.CustomModal.toast({ message: 'Receipt downloaded!', type: 'success' });
        }
      });
    });

    orderSuccessModal.querySelector('#downloadReceiptImgBtn')?.addEventListener('click', async () => {
      window.CustomModal.toast({ message: `Generating receipt${isMulti ? 's' : ''}...`, type: 'info' });
      for (const ord of orders) {
        await window.ReceiptGenerator.downloadReceiptImage(ord);
      }
      window.CustomModal.toast({ message: 'Receipt download ready!', type: 'success' });
    });

    const closeSuccess = () => orderSuccessModal.classList.remove('active');
    orderSuccessModal.querySelector('#closeSuccessModalBtn')?.addEventListener('click', () => {
      closeSuccess();
      window.switchAppTab('shop');
    });
    orderSuccessModal.querySelector('#closeSuccessBtn')?.addEventListener('click', () => {
      closeSuccess();
      window.switchAppTab('shop');
    });

    const trackBtn = orderSuccessModal.querySelector('#trackInOrdersBtn');
    if (trackBtn) {
      trackBtn.addEventListener('click', () => {
        closeSuccess();
        window.switchAppTab('requests');
      });
    }

    orderSuccessModal.classList.add('active');
  }

  /* ==========================================================================
     11. REALTIME CHAT UNREAD BADGE & URL HASH INITIALIZATION
     ========================================================================== */
  async function checkUnreadMessages() {
    try {
      const activeUser = getActiveUser();
      if (!activeUser || !activeUser.id) {
        const ids = ['accountChatIndicator', 'accountSupportChannelBadge', 'bottomChatCount', 'deskChatBadge'];
        ids.forEach(id => {
          const el = document.getElementById(id);
          if (el) el.style.display = 'none';
        });
        const deskAccountBtn = document.getElementById('deskAccountNavBtn');
        if (deskAccountBtn) deskAccountBtn.textContent = 'Account';
        return;
      }

      const count = await window.SupabaseService.getUnreadCountForUser(activeUser.id);

      // 1. Account View Direct Chat Button Indicator
      const chatIndicator = document.getElementById('accountChatIndicator');
      const chatBadgeText = document.getElementById('accountChatBadgeText');
      if (chatIndicator) {
        if (count > 0) {
          if (chatBadgeText) chatBadgeText.textContent = count;
          chatIndicator.style.display = 'inline-flex';
        } else {
          chatIndicator.style.display = 'none';
        }
      }

      // 2. Account View Support Channel Card Indicator
      const channelBadge = document.getElementById('accountSupportChannelBadge');
      if (channelBadge) {
        if (count > 0) {
          channelBadge.textContent = `${count} New`;
          channelBadge.style.display = 'inline-flex';
        } else {
          channelBadge.style.display = 'none';
        }
      }

      // 3. Mobile Bottom Navigation "Account" Tab Indicator Bubble
      const bottomCount = document.getElementById('bottomChatCount');
      if (bottomCount) {
        if (count > 0) {
          bottomCount.textContent = count > 99 ? '99+' : String(count);
          bottomCount.style.display = 'flex';
        } else {
          bottomCount.style.display = 'none';
        }
      }

      // 4. Desktop Navigation "Account" Tab
      const deskAccountBtn = document.getElementById('deskAccountNavBtn');
      if (deskAccountBtn) {
        const dName = activeUser.first_name || (activeUser.name ? activeUser.name.split(' ')[0] : 'Account');
        const deskBadge = document.getElementById('deskChatBadge');
        if (deskBadge) {
          deskBadge.textContent = count;
          deskBadge.style.display = count > 0 ? 'inline-block' : 'none';
        } else {
          deskAccountBtn.innerHTML = `
            <span>${window.CustomModal.escape(dName)}</span>
            <span class="desktop-nav-badge" id="deskChatBadge" style="${count > 0 ? 'display: inline-block;' : 'display: none;'} background: #dc2626; color: #ffffff; margin-left: 6px; padding: 1px 7px; border-radius: 999px; font-size: 0.72rem; font-weight: 800;">
              ${count}
            </span>
          `;
        }
      }
    } catch (e) {
      console.warn('Error checking unread messages:', e);
    }
  }

  // Poll for incoming chat messages every 10 seconds for real-time notification
  if (!window._chatUnreadPollInterval) {
    window._chatUnreadPollInterval = setInterval(() => {
      if (typeof checkUnreadMessages === 'function') checkUnreadMessages();
    }, 10000);
  }

  // Multi-device real-time cart sync polling (responsive 8s interval for fast cross-device sync)
  if (!window._cartCloudSyncInterval) {
    window._cartCloudSyncInterval = setInterval(() => {
      if (typeof syncCartWithCloud === 'function') syncCartWithCloud(false);
    }, 8000);
  }

  window.addEventListener('online', () => {
    if (typeof syncCartWithCloud === 'function') syncCartWithCloud(false);
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      if (typeof syncCartWithCloud === 'function') syncCartWithCloud(false);
      if (typeof checkUnreadMessages === 'function') checkUnreadMessages();
    }
  });

  window.addEventListener('focus', () => {
    if (typeof syncCartWithCloud === 'function') syncCartWithCloud(false);
    if (typeof checkUnreadMessages === 'function') checkUnreadMessages();
  });

  // Setup Search in Requests Tab
  const reqSearchInput = document.getElementById('requestsSearchInput');
  if (reqSearchInput) {
    reqSearchInput.addEventListener('input', () => {
      renderRequestsView();
    });
  }

  // Setup Clear Cart Button
  const cartClearBtn = document.getElementById('cartClearBtn');
  if (cartClearBtn) {
    cartClearBtn.addEventListener('click', () => {
      window.CustomModal.confirm({
        title: 'Clear Shopping Cart',
        message: 'Are you sure you want to remove all items from your cart?',
        confirmText: 'Clear Cart',
        onConfirm: clearCart
      });
    });
  }

  // Initialize Tab listeners, View Layout Toggle & Category Search
  initTabListeners();
  initViewToggle();
  initCategorySearch();

  // Listen for user profile updates to instantly re-sync cart & account views
  window.addEventListener('user-profile-updated', () => {
    if (state.currentTab === 'cart') {
      renderCartView();
    } else if (state.currentTab === 'account') {
      renderAccountView();
    }
  });

  // Instantly activate target tab (from hash or saved session) before data fetching
  const validTabs = ['shop', 'home', 'requests', 'cart', 'account'];
  const hash = (window.location.hash || '').replace('#', '').toLowerCase();
  const savedTab = sessionStorage.getItem('networth_current_tab');
  const initialTab = validTabs.includes(hash) ? hash : (validTabs.includes(savedTab) ? savedTab : 'shop');
  window.switchAppTab(initialTab);

  // Load Initial Data
  await loadInitialData();

  // Re-render views if current tab requires fresh cloud data
  if (initialTab === 'cart') {
    renderCartView();
  } else if (initialTab === 'requests') {
    renderRequestsView();
  } else if (initialTab === 'account') {
    renderAccountView();
  }
});
