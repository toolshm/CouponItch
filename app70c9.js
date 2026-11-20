"use strict";

const OWNER_SETTINGS = {
  storageKey: "couponitch_owner_mode",
  unlockDelay: 60000,
  unlockAllCoupons: true
};

(() => {
  const $ = (id) => document.getElementById(id);
  const FALLBACK_IMAGE = "images/placeholder.webp";
  const MODAL_PREVIEW_DURATION = 10000;
  const MODAL_PREVIEW_INTERVAL = 300;
  const delayKey = `${OWNER_SETTINGS.storageKey}_unlock_delay`;
  const delayRevisionKey = `${delayKey}_revision`;
  let storageAvailable = true;
  const storage = {
    get(key) { try { return localStorage.getItem(key); } catch { storageAvailable = false; return null; } },
    set(key, value) { try { localStorage.setItem(key, value); } catch { storageAvailable = false; } },
    remove(key) { try { localStorage.removeItem(key); } catch { storageAvailable = false; } }
  };
  const validDelay = (value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 86400000;
  // Retain existing testing preferences when these files replace the old site.
  ["", "_unlock_delay", "_unlock_delay_revision"].forEach((suffix) => {
    const key = `${OWNER_SETTINGS.storageKey}${suffix}`;
    const legacyValue = storage.get(`aicoupons_owner_mode${suffix}`);
    if (storage.get(key) === null && legacyValue !== null) storage.set(key, legacyValue);
  });
  const savedDelay = storage.get(delayKey);
  const parsedDelay = savedDelay !== null && /^\d+$/.test(savedDelay) ? Number(savedDelay) : NaN;
  let unlockDelay = validDelay(parsedDelay) ? parsedDelay : OWNER_SETTINGS.unlockDelay;
  // Upgrade the old three-second default once, retaining later custom settings.
  if (storage.get(delayRevisionKey) !== "minute-default") {
    if (parsedDelay === 3000) {
      unlockDelay = OWNER_SETTINGS.unlockDelay;
      storage.set(delayKey, String(unlockDelay));
    }
    storage.set(delayRevisionKey, "minute-default");
  }
  let ownerEnabled = storage.get(OWNER_SETTINGS.storageKey) === "true";
  // One page-local flag controls every coupon. It is never persisted.
  let allCouponsUnlocked = false;
  let unlockTimer = null;
  let unlockDeadline = null;
  let activeCoupon = null;
  let modalFinding = false;
  let previewTimer = null;
  let previewInterval = null;
  let previewCodeAnimation = null;
  let activeCategory = null;
  let searchQuery = "";
  let returnFocus = null;
  let infoReturnHash = "";
  let catalogue = [];
  const byId = new Map();
  const couponDialog = $("coupon-dialog");
  const infoDialog = $("info-dialog");
  const categorySymbols = { "Gaming": "✚", "Streaming": "▷", "Music": "♫", "Software": "⌘", "Shopping": "◇", "AI Tools": "✧", "Mobile Apps": "▣", "Subscriptions": "↻", "Food & Delivery": "♨" };
  const AVAILABILITY = { cookiePrefix: "ci_av2_", legacyCookiePrefix: "ci_availability_v1_", maxAge: 2592000, minInterval: 45000, maxInterval: 120000 };
  const availabilityStates = new Map();

  function randomInteger(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  function readAvailabilityCookie(id, now) {
    try {
      const cookies = document.cookie.split(";").map((part) => part.trim());
      let prefix = `${AVAILABILITY.cookiePrefix}${id}=`;
      let cookie = cookies.find((part) => part.startsWith(prefix));
      const legacy = !cookie;
      if (legacy) {
        prefix = `${AVAILABILITY.legacyCookiePrefix}${id}=`;
        cookie = cookies.find((part) => part.startsWith(prefix));
      }
      if (!cookie || cookie.length > 300) return null;
      const value = cookie.slice(prefix.length);
      // Compact base-36 values keep a large catalogue's Cookie header small.
      const state = legacy ? JSON.parse(decodeURIComponent(value)) : value.split(".").map((part) => /^[a-z0-9]{1,12}$/.test(part) ? parseInt(part, 36) : NaN);
      if (!Array.isArray(state) || state.length !== 4 || !state.every(Number.isSafeInteger)) return null;
      const [initial, remaining, nextAt, interval] = state;
      if (initial < 200 || initial > 400 || remaining < 0 || remaining > initial ||
          interval < AVAILABILITY.minInterval || interval > AVAILABILITY.maxInterval ||
          nextAt < 0 || nextAt > now + AVAILABILITY.maxInterval) return null;
      const result = { initial, remaining, nextAt, interval };
      if (legacy) {
        saveAvailabilityCookie(id, result);
        try { document.cookie = `${AVAILABILITY.legacyCookiePrefix}${id}=; Path=/; Max-Age=0; SameSite=Lax${location.protocol === "https:" ? "; Secure" : ""}`; } catch { /* Migration can wait until cookies are writable. */ }
      }
      return result;
    } catch { return null; }
  }

  function saveAvailabilityCookie(id, state) {
    try {
      const value = [state.initial, state.remaining, state.nextAt, state.interval].map((part) => part.toString(36)).join(".");
      document.cookie = `${AVAILABILITY.cookiePrefix}${id}=${value}; Path=/; Max-Age=${AVAILABILITY.maxAge}; SameSite=Lax${location.protocol === "https:" ? "; Secure" : ""}`;
    } catch { /* Keep the counters working in page memory when cookies are blocked. */ }
  }

  function initializeAvailability() {
    const now = Date.now();
    catalogue.forEach((coupon) => {
      let state = readAvailabilityCookie(coupon.id, now);
      if (!state) {
        const initial = randomInteger(200, 400);
        const interval = randomInteger(AVAILABILITY.minInterval, AVAILABILITY.maxInterval);
        state = { initial, remaining: initial, nextAt: now + interval, interval };
        saveAvailabilityCookie(coupon.id, state);
      }
      availabilityStates.set(coupon.id, state);
    });
    refreshAvailability(false);
  }

  function paintAvailability(view, state, drop = 0) {
    const amount = view.querySelector(".availability-amount");
    amount.textContent = String(state.remaining);
    view.classList.toggle("is-low", state.remaining <= 25);
    if (drop > 0) {
      view.querySelector(".availability-change").textContent = `−${drop}`;
      view.classList.remove("is-updating");
      // Restart the brief glow when this same counter drops a second time.
      void view.offsetWidth;
      view.classList.add("is-updating");
      if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches && amount.animate) {
        amount.animate([
          { opacity: .4, transform: "translateY(-4px)" },
          { opacity: 1, transform: "translateY(0)" }
        ], { duration: 350, easing: "ease-out" });
      }
    }
  }

  function makeAvailability(coupon, modal = false) {
    const view = element("div", "availability");
    view.dataset.availabilityId = coupon.id;
    const row = element("div", "availability-row");
    const dot = element("span", "availability-dot");
    dot.setAttribute("aria-hidden", "true");
    const value = element("span", "availability-value");
    if (modal) { value.setAttribute("role", "status"); value.setAttribute("aria-live", "polite"); value.setAttribute("aria-atomic", "true"); }
    value.append(element("strong", "availability-amount"), document.createTextNode(" coupons left"));
    const change = element("span", "availability-change");
    change.setAttribute("aria-hidden", "true");
    row.append(dot, value, change);
    view.append(row);
    view.title = "Randomized count saved in this browser. This is a simulation, not live merchant stock.";
    view.addEventListener("animationend", (event) => {
      if (event.animationName === "availability-glow") view.classList.remove("is-updating");
    });
    paintAvailability(view, availabilityStates.get(coupon.id));
    return view;
  }

  function refreshAvailability(animate = true) {
    const now = Date.now();
    availabilityStates.forEach((current, id) => {
      // Read the latest cookie so another tab cannot make a counter jump back up.
      const stored = readAvailabilityCookie(id, now);
      const state = { ...(stored && stored.remaining <= current.remaining ? stored : current) };
      if (state.remaining > 0 && now >= state.nextAt) {
        const steps = Math.floor((now - state.nextAt) / state.interval) + 1;
        state.remaining = Math.max(0, state.remaining - steps);
        state.nextAt += steps * state.interval;
        saveAvailabilityCookie(id, state);
      }
      const drop = current.remaining - state.remaining;
      availabilityStates.set(id, state);
      if (drop > 0) document.querySelectorAll(`[data-availability-id="${id}"]`).forEach((view) => paintAvailability(view, state, animate ? drop : 0));
    });
  }

  function safeText(value, fallback = "", maxLength = 1000) {
    return typeof value === "string" && value.trim() ? value.trim().slice(0, maxLength) : fallback;
  }

  function safeExternalURL(value) {
    if (typeof value !== "string" || value.length > 4096 || /[\u0000-\u0020\\]/.test(value)) return null;
    try {
      const url = new URL(value);
      return ["https:", "http:"].includes(url.protocol) && url.hostname && !url.username && !url.password ? url.href : null;
    } catch { return null; }
  }

  function safeImage(value) {
    return typeof value === "string" && /^images\/[a-zA-Z0-9_-]+\.(?:webp|jpe?g|png|svg)$/.test(value) ? value : FALLBACK_IMAGE;
  }

  function validateCatalogue(data) {
    if (!Array.isArray(data)) {
      console.warn("CouponItch: coupons.js must define an array named coupons.");
      $("catalogue-error").hidden = false;
      return [];
    }
    const seen = new Set();
    return data.reduce((result, entry, index) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        console.warn(`CouponItch: skipped invalid entry at position ${index + 1}.`);
        return result;
      }
      const id = safeText(entry.id, "", 100);
      const name = safeText(entry.name, "", 140);
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id) || !name || seen.has(id.toLowerCase())) {
        console.warn(`CouponItch: skipped entry ${index + 1}; supply a unique id and a name.`);
        return result;
      }
      seen.add(id.toLowerCase());
      const link = safeExternalURL(entry.link);
      if (!link) console.warn(`CouponItch: "${id}" has an invalid destination; its offer action is disabled.`);
      const coupon = {
        id, name,
        category: safeText(entry.category, "Other", 80),
        image: safeImage(entry.image),
        imageFit: entry.imageFit === "contain" ? "contain" : "cover",
        description: safeText(entry.description, "Explore this listing and check the destination for current offer details."),
        coupon: safeText(entry.coupon, "", 300),
        link,
        featured: entry.featured === true,
        sample: entry.sample === true
      };
      coupon.searchText = `${coupon.name} ${coupon.category} ${coupon.description}`.toLocaleLowerCase();
      result.push(coupon);
      return result;
    }, []);
  }

  function element(tag, className, content) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (content !== undefined) node.textContent = content;
    return node;
  }

  function setImage(image, source, alt) {
    image.onerror = () => {
      image.onerror = null;
      image.src = FALLBACK_IMAGE;
    };
    image.alt = alt;
    image.src = source;
  }

  function makeCard(coupon) {
    const card = element("article", "coupon-card");
    card.dataset.couponId = coupon.id;
    const imageWrap = element("div", "card-image-wrap");
    const image = element("img", "card-image");
    image.width = 400;
    image.height = 400;
    image.loading = "lazy";
    image.decoding = "async";
    image.style.objectFit = coupon.imageFit;
    setImage(image, coupon.image, `${coupon.name} — ${coupon.category.toLowerCase()} artwork`);
    imageWrap.append(image);
    if (coupon.sample) imageWrap.append(element("span", "sample-badge", "Sample"));
    const body = element("div", "card-body");
    const button = element("button", "card-button", "Get Coupon");
    button.type = "button";
    button.dataset.couponId = coupon.id;
    button.setAttribute("aria-label", `Get coupon for ${coupon.name}`);
    button.setAttribute("aria-haspopup", "dialog");
    const arrow = element("span", "", "↗");
    arrow.setAttribute("aria-hidden", "true");
    button.append(arrow);
    body.append(element("span", "category-badge", coupon.category), element("h3", "", coupon.name), element("p", "", coupon.description), makeAvailability(coupon), button);
    card.append(imageWrap, body);
    return card;
  }

  function renderCards(container, entries) {
    const fragment = document.createDocumentFragment();
    entries.forEach((coupon) => fragment.append(makeCard(coupon)));
    container.replaceChildren(fragment);
  }

  function renderCategories() {
    const counts = new Map();
    catalogue.forEach((coupon) => counts.set(coupon.category, (counts.get(coupon.category) || 0) + 1));
    const fragment = document.createDocumentFragment();
    [null, ...counts.keys()].forEach((category) => {
      const button = element("button", "category-filter");
      button.type = "button";
      button.setAttribute("aria-pressed", String(category === activeCategory));
      const symbol = element("span", "category-symbol", category === null ? "▦" : categorySymbols[category] || "◇");
      symbol.setAttribute("aria-hidden", "true");
      const count = category === null ? catalogue.length : counts.get(category);
      button.append(symbol, element("span", "", category === null ? "All" : category), element("span", "category-count", String(count)));
      button.addEventListener("click", () => {
        activeCategory = category;
        $("category-filters").querySelectorAll("button").forEach((item) => item.setAttribute("aria-pressed", String(item === button)));
        renderResults();
      });
      fragment.append(button);
    });
    $("category-filters").replaceChildren(fragment);
  }

  function renderResults() {
    const query = searchQuery.toLocaleLowerCase().trim();
    const matches = catalogue.filter((coupon) => (!activeCategory || coupon.category === activeCategory) && (!query || coupon.searchText.includes(query)));
    renderCards($("all-grid"), matches);
    const featured = matches.filter((coupon) => coupon.featured);
    renderCards($("featured-grid"), featured);
    $("featured").hidden = featured.length === 0;
    $("result-count").textContent = `${matches.length} ${matches.length === 1 ? "coupon" : "coupons"}${query || activeCategory ? " found" : " to explore"}`;
    $("search-clear").hidden = searchQuery.length === 0;
    $("no-results").hidden = matches.length > 0;
    $("sample-notice").hidden = !matches.some((coupon) => coupon.sample);
    if (!catalogue.length) {
      $("empty-title").textContent = "Good finds are on their way";
      $("empty-description").textContent = "There are no listings just yet. Please check back soon.";
      $("reset-filters").hidden = true;
    }
  }

  function cancelUnlockTimer() {
    if (unlockTimer !== null) window.clearTimeout(unlockTimer);
    unlockTimer = null;
    unlockDeadline = null;
  }

  function cancelModalPreview() {
    if (previewTimer !== null) window.clearTimeout(previewTimer);
    if (previewInterval !== null) window.clearInterval(previewInterval);
    if (previewCodeAnimation) previewCodeAnimation.cancel();
    previewTimer = null;
    previewInterval = null;
    previewCodeAnimation = null;
    modalFinding = false;
  }

  function startModalPreview() {
    cancelModalPreview();
    modalFinding = true;
    const selected = activeCoupon;
    const started = performance.now();
    const panel = $("discovery-panel");
    const progress = $("discovery-progress");
    const codeBox = $("coupon-code");
    const codeValue = element("span", "code-value");
    codeBox.replaceChildren(codeValue);
    let previewStep = 0;
    panel.classList.remove("is-complete");
    panel.classList.add("is-finding");
    panel.style.setProperty("--preview-duration", `${MODAL_PREVIEW_DURATION}ms`);
    panel.style.setProperty("--preview-progress", "0");
    $("discovery-title").textContent = "Finding Coupons";
    $("discovery-spinner").hidden = false;
    $("discovery-check").hidden = true;
    $("discovery-note").textContent = "";
    $("discovery-note").hidden = true;
    progress.hidden = false;
    progress.setAttribute("aria-valuenow", "0");
    $("modal-actions").hidden = true;
    $("coupon-action").disabled = true;
    $("modal-status").textContent = "";
    $("code-label").textContent = "Preview codes";
    $("code-help").textContent = "";
    codeBox.classList.remove("is-locked", "is-partial");
    codeBox.classList.add("is-preview");
    codeBox.setAttribute("aria-hidden", "true");
    const cycleCode = () => {
      if (!couponDialog.open || activeCoupon !== selected) return;
      // Every placeholder is fully masked; no invented coupon is displayed.
      const masks = ["****-****", "********", "****-******", "******"];
      codeValue.textContent = masks[previewStep++ % masks.length];
      codeBox.classList.add("is-masked-preview");
      if (previewCodeAnimation) previewCodeAnimation.cancel();
      if (codeValue.animate && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        previewCodeAnimation = codeValue.animate([{ opacity: .45, transform: "translateY(4px)" }, { opacity: 1, transform: "translateY(0)" }], { duration: 180, easing: "ease-out" });
      }
      const elapsed = Math.min(.99, (performance.now() - started) / MODAL_PREVIEW_DURATION);
      panel.style.setProperty("--preview-progress", String(elapsed));
      progress.setAttribute("aria-valuenow", String(Math.floor(elapsed * 100)));
      $("discovery-percent").textContent = `${Math.floor(elapsed * 100)}%`;
    };
    cycleCode();
    previewInterval = window.setInterval(cycleCode, MODAL_PREVIEW_INTERVAL);
    previewTimer = window.setTimeout(() => {
      if (!couponDialog.open || activeCoupon !== selected) { cancelModalPreview(); return; }
      cancelModalPreview();
      panel.classList.remove("is-finding");
      panel.classList.add("is-complete");
      panel.style.setProperty("--preview-progress", "1");
      $("discovery-percent").textContent = "100%";
      $("discovery-title").textContent = "Found!";
      $("discovery-spinner").hidden = true;
      $("discovery-check").hidden = false;
      $("discovery-note").textContent = "Coupons Found! Check the destination for current offers.";
      $("discovery-note").hidden = false;
      progress.setAttribute("aria-valuenow", "100");
      progress.hidden = true;
      updateCouponModal();
    }, MODAL_PREVIEW_DURATION);
  }

  function maskedCouponCode(code) {
    if (!code) return "••••••••";
    const characters = Array.from(code);
    const visibleLength = Math.floor(characters.length / 2);
    return characters.slice(0, visibleLength).join("") + "•".repeat(characters.length - visibleLength);
  }

  function updateCouponModal() {
    if (!activeCoupon) return;
    // Owner unlocking never interrupts the ten-second visual sequence.
    if (modalFinding) return;
    const coupon = activeCoupon;
    const codeBox = $("coupon-code");
    const button = $("coupon-action");
    const visit = $("visit-offer");
    $("modal-actions").hidden = false;
    $("code-label").textContent = "Coupon code";
    codeBox.classList.remove("is-preview", "is-masked-preview");
    codeBox.removeAttribute("aria-hidden");
    $("modal-status").textContent = "";
    codeBox.classList.toggle("is-locked", !allCouponsUnlocked);
    codeBox.classList.toggle("is-partial", !allCouponsUnlocked && Boolean(coupon.coupon));
    codeBox.replaceChildren(element("span", "code-value", allCouponsUnlocked ? coupon.coupon || "No code supplied" : maskedCouponCode(coupon.coupon)));
    codeBox.setAttribute("aria-label", allCouponsUnlocked ? coupon.coupon ? "Coupon code" : "No coupon code supplied" : coupon.coupon ? "Coupon code partially hidden" : "Coupon code locked");
    button.disabled = false;
    button.hidden = !coupon.coupon;
    if (!coupon.coupon) {
      codeBox.replaceChildren(element("span", "code-value", "No code supplied"));
      codeBox.setAttribute("aria-label", "No coupon code supplied");
      codeBox.classList.remove("is-locked");
      $("code-help").textContent = "";
      visit.hidden = !coupon.link;
    } else if (allCouponsUnlocked) {
      button.textContent = coupon.coupon ? "Copy Coupon" : "No code supplied";
      button.disabled = !coupon.coupon;
      $("code-help").textContent = coupon.coupon ? "Copy the code, then review the offer at its destination." : "This listing does not include a coupon code. Explore its destination for details.";
      visit.hidden = false;
    } else {
      button.textContent = "Unlock Code ↗";
      button.disabled = !coupon.link;
      $("code-help").textContent = "";
      visit.hidden = true;
    }
    if (coupon.link) {
      visit.href = coupon.link;
      visit.removeAttribute("aria-disabled");
      visit.removeAttribute("tabindex");
    } else {
      visit.removeAttribute("href");
      visit.setAttribute("aria-disabled", "true");
      visit.setAttribute("tabindex", "-1");
      $("code-help").textContent = "This listing’s destination is unavailable. Please try another coupon.";
    }
  }

  function unlockAll() {
    cancelUnlockTimer();
    allCouponsUnlocked = true;
    updateCouponModal();
  }

  function checkOwnerUnlock() {
    if (!ownerEnabled || allCouponsUnlocked || unlockDeadline === null) return;
    const remaining = unlockDeadline - Date.now();
    if (remaining <= 0) { unlockAll(); return; }
    if (unlockTimer !== null) window.clearTimeout(unlockTimer);
    unlockTimer = window.setTimeout(() => {
      unlockTimer = null;
      checkOwnerUnlock();
    }, remaining);
  }

  function startUnlockTimer() {
    cancelUnlockTimer();
    allCouponsUnlocked = false;
    updateCouponModal();
    if (ownerEnabled && OWNER_SETTINGS.unlockAllCoupons) {
      unlockDeadline = Date.now() + unlockDelay;
      checkOwnerUnlock();
    }
  }

  function ownerStatus() {
    return { enabled: ownerEnabled, unlocked: allCouponsUnlocked, unlockDelay, timerPending: unlockTimer !== null, storageAvailable };
  }

  window.CouponItch = Object.freeze({
    enableOwnerMode() {
      ownerEnabled = true;
      storage.set(OWNER_SETTINGS.storageKey, "true");
      startUnlockTimer();
      return ownerStatus();
    },
    disableOwnerMode() {
      ownerEnabled = false;
      storage.remove(OWNER_SETTINGS.storageKey);
      cancelUnlockTimer();
      allCouponsUnlocked = false;
      updateCouponModal();
      return ownerStatus();
    },
    setUnlockDelay(milliseconds) {
      if (!validDelay(milliseconds)) throw new RangeError("Use a whole number of milliseconds between 0 and 86400000 (24 hours).");
      unlockDelay = milliseconds;
      storage.set(delayKey, String(milliseconds));
      if (ownerEnabled && !allCouponsUnlocked) startUnlockTimer();
      return ownerStatus();
    },
    unlockAllNow() {
      unlockAll();
      return ownerStatus();
    },
    getOwnerStatus: ownerStatus
  });
  // Keep previously shared console commands working after the rebrand.
  window.AICoupons = window.CouponItch;

  // Address-bar shortcuts work on phones without exposing public admin controls.
  // Fragments stay in the browser and are removed after a recognised command.
  function handleOwnerLink() {
    const actions = {
      "#owner-on": window.CouponItch.enableOwnerMode,
      "#owner-off": window.CouponItch.disableOwnerMode,
      "#owner-now": window.CouponItch.unlockAllNow
    };
    if (!Object.prototype.hasOwnProperty.call(actions, location.hash)) return false;
    actions[location.hash]();
    try {
      history.replaceState(null, "", `${location.pathname}${location.search}`);
    } catch { /* Restricted file previews may not permit history changes. */ }
    return true;
  }

  function openDialog(dialog, trigger) {
    if (couponDialog.open) couponDialog.close();
    if (infoDialog.open) infoDialog.close();
    returnFocus = trigger || document.activeElement;
    document.body.classList.add("modal-open");
    dialog.showModal();
    dialog.querySelector("[data-close]").focus({ preventScroll: true });
  }

  function openCoupon(id, trigger) {
    const coupon = byId.get(id);
    if (!coupon) return;
    activeCoupon = coupon;
    $("modal-name").textContent = coupon.name;
    $("modal-description").textContent = coupon.description;
    refreshAvailability();
    $("modal-availability").replaceChildren(makeAvailability(coupon, true));
    $("modal-category").textContent = coupon.category;
    $("modal-sample").hidden = !coupon.sample;
    setImage($("modal-image"), coupon.image, `${coupon.name} artwork`);
    $("modal-image").style.objectFit = coupon.imageFit;
    openDialog(couponDialog, trigger);
    if (coupon.coupon) startModalPreview();
    else {
      cancelModalPreview();
      updateCouponModal();
    }
  }

  async function copyCoupon() {
    if (modalFinding || !allCouponsUnlocked || !activeCoupon || !activeCoupon.coupon) return;
    const selected = activeCoupon;
    let copied = false;
    if (navigator.clipboard && window.isSecureContext) {
      try { await navigator.clipboard.writeText(selected.coupon); copied = true; } catch { /* Try browser-compatible copying below. */ }
    }
    if (modalFinding || activeCoupon !== selected || !allCouponsUnlocked || !couponDialog.open) return;
    if (!copied) {
      const field = element("textarea", "sr-only");
      field.value = selected.coupon;
      field.setAttribute("readonly", "");
      field.setAttribute("aria-label", "Copy coupon code");
      // Keep the fallback inside the dialog: content outside a modal is inert.
      couponDialog.append(field);
      field.focus();
      field.select();
      try { copied = document.execCommand("copy"); } catch { copied = false; }
      field.remove();
      $("coupon-action").focus({ preventScroll: true });
    }
    $("modal-status").textContent = copied ? "Copied! Your code is ready to paste." : "Copy wasn’t available. Select the code above and copy it manually.";
    if (!copied) {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents($("coupon-code"));
      if (selection) { selection.removeAllRanges(); selection.addRange(range); }
    }
  }

  function closeMenu() {
    $("main-nav").classList.remove("is-open");
    $("menu-button").setAttribute("aria-expanded", "false");
    $("menu-button").setAttribute("aria-label", "Open navigation");
  }

  function openInfo(id, trigger) {
    const source = $(id);
    if (!source || !source.matches("#information-sections > article")) return;
    const content = source.cloneNode(true);
    content.removeAttribute("id");
    content.querySelector("h2").id = "info-title";
    $("info-content").replaceChildren(...content.childNodes);
    openDialog(infoDialog, trigger);
  }

  [couponDialog, infoDialog].forEach((dialog) => {
    dialog.querySelector("[data-close]").addEventListener("click", () => dialog.close());
    dialog.addEventListener("click", (event) => {
      const bounds = dialog.getBoundingClientRect();
      if (event.target === dialog && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom)) dialog.close();
    });
    dialog.addEventListener("close", () => {
      if (dialog.open) return;
      if (!couponDialog.open && !infoDialog.open) {
        document.body.classList.remove("modal-open");
        if (returnFocus && returnFocus.isConnected) returnFocus.focus({ preventScroll: true });
      }
      if (dialog === couponDialog) {
        cancelModalPreview();
        $("discovery-panel").classList.remove("is-finding");
        activeCoupon = null;
        $("coupon-code").textContent = "••••••••";
      }
      if (dialog === infoDialog && $(location.hash.slice(1))?.matches("#information-sections > article")) {
        history.replaceState(null, "", `${location.pathname}${location.search}${infoReturnHash}`);
      }
    });
    // Native dialog provides focus containment, Escape handling and inert background.
    dialog.addEventListener("keydown", (event) => {
      if (event.key !== "Tab") return;
      const focusable = [...dialog.querySelectorAll('button:not([disabled]), a[href], input:not([disabled]), textarea')].filter((item) => !item.hidden && item.getClientRects().length > 0);
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    });
  });

  document.addEventListener("click", (event) => {
    const trigger = event.target.closest("[data-coupon-id]");
    if (trigger) {
      const button = trigger.matches("button") ? trigger : trigger.querySelector(".card-button");
      openCoupon(trigger.dataset.couponId, button);
    }
    const infoLink = event.target.closest("[data-info]");
    if (infoLink) {
      event.preventDefault();
      infoReturnHash = location.hash;
      history.replaceState(null, "", `#${infoLink.dataset.info}`);
      openInfo(infoLink.dataset.info, infoLink);
    }
    if (!event.target.closest(".site-header")) closeMenu();
  });
  $("coupon-action").addEventListener("click", () => {
    if (!activeCoupon || modalFinding) return;
    if (allCouponsUnlocked) { copyCoupon(); return; }
    // Keep the coupon modal open while its validated destination opens separately.
    if (activeCoupon.link) window.open(activeCoupon.link, "_blank", "noopener,noreferrer");
  });
  $("coupon-search").addEventListener("input", (event) => {
    searchQuery = event.target.value;
    renderResults();
  });
  $("search-form").addEventListener("submit", (event) => { event.preventDefault(); $("all-coupons").scrollIntoView({ block: "start" }); });
  $("search-clear").addEventListener("click", () => {
    searchQuery = "";
    $("coupon-search").value = "";
    renderResults();
    $("coupon-search").focus({ preventScroll: true });
  });
  $("reset-filters").addEventListener("click", () => {
    activeCategory = null;
    searchQuery = "";
    $("coupon-search").value = "";
    renderCategories();
    renderResults();
    $("category-filters").querySelector("button").focus({ preventScroll: true });
  });
  document.querySelectorAll("[data-search]").forEach((button) => button.addEventListener("click", () => {
    activeCategory = null;
    searchQuery = button.dataset.search;
    $("coupon-search").value = searchQuery;
    renderCategories();
    renderResults();
    $("all-coupons").scrollIntoView({ block: "start" });
  }));
  $("header-search").addEventListener("click", () => { $("home").scrollIntoView(); $("coupon-search").focus({ preventScroll: true }); });
  $("menu-button").addEventListener("click", () => {
    const expanded = $("menu-button").getAttribute("aria-expanded") !== "true";
    $("menu-button").setAttribute("aria-expanded", String(expanded));
    $("menu-button").setAttribute("aria-label", expanded ? "Close navigation" : "Open navigation");
    $("main-nav").classList.toggle("is-open", expanded);
  });
  $("main-nav").querySelectorAll("a").forEach((link) => link.addEventListener("click", closeMenu));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && $("menu-button").getAttribute("aria-expanded") === "true") {
      closeMenu();
      $("menu-button").focus({ preventScroll: true });
    }
  });
  window.matchMedia("(min-width: 521px)").addEventListener("change", (event) => {
    if (event.matches) closeMenu();
  });
  window.addEventListener("hashchange", () => {
    if (handleOwnerLink()) return;
    const id = location.hash.slice(1);
    if ($(id)?.matches("#information-sections > article")) { infoReturnHash = ""; openInfo(id); }
  });
  // Mobile browsers can suspend background timers; catch up when the user returns.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") { checkOwnerUnlock(); refreshAvailability(); }
  });
  window.addEventListener("focus", checkOwnerUnlock);
  window.addEventListener("pageshow", checkOwnerUnlock);
  window.addEventListener("focus", () => refreshAvailability());
  window.addEventListener("pageshow", () => refreshAvailability());
  window.setInterval(() => {
    if (document.visibilityState === "visible") refreshAvailability();
  }, 5000);

  // Content and UI initialization cannot depend on browser storage being available.
  catalogue = validateCatalogue(typeof coupons === "undefined" ? undefined : coupons);
  catalogue.forEach((coupon) => byId.set(coupon.id, coupon));
  initializeAvailability();
  renderCategories();
  renderResults();
  $("copyright-year").textContent = String(new Date().getFullYear());
  if (!handleOwnerLink() && ownerEnabled) startUnlockTimer();
  if ($(location.hash.slice(1))?.matches("#information-sections > article")) openInfo(location.hash.slice(1));
})();
