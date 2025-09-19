// app.js — improved immediate-install + SW update handling
(() => {
  const INSTALL_STORAGE_KEY = "pwa_install_prompt_v1";
  const PROMPT_COOLDOWN_DAYS = 7; // don't re-show within this many days after dismiss
  const MAX_PROMPT_ATTEMPTS = 3; // per cooldown window

  let deferredPrompt = null;
  let installBannerEl = null;
  let swRegistration = null;
  let refreshing = false;

  // ---------- Helpers ----------
  function now() { return Date.now(); }
  function daysToMs(d) { return d * 24 * 60 * 60 * 1000; }

  function readInstallState() {
    try {
      return JSON.parse(localStorage.getItem(INSTALL_STORAGE_KEY)) || {};
    } catch (e) {
      return {};
    }
  }
  function writeInstallState(obj) {
    try {
      localStorage.setItem(INSTALL_STORAGE_KEY, JSON.stringify(obj || {}));
    } catch (e) {}
  }

  function canShowPromptNow() {
    const st = readInstallState();
    if (!st.lastShown) return true;
    const nextAllowed = st.lastShown + daysToMs(PROMPT_COOLDOWN_DAYS);
    if (now() < nextAllowed) {
      // still in cooldown
      return false;
    }
    if ((st.attempts || 0) >= MAX_PROMPT_ATTEMPTS) return false;
    return true;
  }

  function recordPromptShown(outcome) {
    const st = readInstallState();
    st.lastShown = now();
    st.attempts = (st.attempts || 0) + 1;
    st.lastOutcome = outcome || null; // 'accepted' | 'dismissed' | 'error'
    writeInstallState(st);
  }

  function cameFromExternalReferrer() {
    try {
      if (!document.referrer) return false;
      const refHost = new URL(document.referrer).hostname;
      return refHost && refHost !== location.hostname;
    } catch (e) {
      return false;
    }
  }

  function urlRequestsAutoPrompt() {
    try {
      const params = new URLSearchParams(location.search);
      return params.get("source") === "external" || params.get("auto_prompt") === "1";
    } catch (e) {
      return false;
    }
  }

  // ---------- Service worker registration + update handling ----------
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", async () => {
      try {
        swRegistration = await navigator.serviceWorker.register("service-worker.js");
        console.log("Service Worker registered:", swRegistration);

        // If a waiting worker exists, offer update flow
        if (swRegistration.waiting) {
          showUpdateReady(swRegistration.waiting);
        }

        swRegistration.addEventListener("updatefound", () => {
          const newWorker = swRegistration.installing;
          if (!newWorker) return;
          newWorker.addEventListener("statechange", () => {
            if (newWorker.state === "installed" && navigator.serviceWorker.controller) {
              showUpdateReady(newWorker);
            }
          });
        });

        navigator.serviceWorker.addEventListener("controllerchange", () => {
          if (refreshing) return;
          refreshing = true;
          console.log("Controller changed — reloading");
          window.location.reload();
        });
      } catch (err) {
        console.error("SW registration failed:", err);
      }
    });
  }

  function showUpdateReady(worker) {
    // Simple confirm; replace with custom UI if desired
    try {
      const ok = confirm("A new version is available. Refresh to update?");
      if (ok) {
        // Ask worker to skipWaiting (SW must listen for this message and call self.skipWaiting())
        try {
          worker.postMessage && worker.postMessage({ type: "SKIP_WAITING" });
        } catch (e) {
          console.warn("Couldn't postMessage to waiting worker", e);
        }
        // as fallback, try to call update() so browser downloads new SW and triggers controllerchange
        if (swRegistration && swRegistration.update) {
          swRegistration.update().catch(() => {});
        }
      }
    } catch (e) {
      console.warn("showUpdateReady error", e);
    }
  }

  // If your service-worker doesn't already listen for SKIP_WAITING, add this snippet to it:
  // self.addEventListener('message', (e) => { if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting(); });

  // ---------- Install flow ----------
  // Try to prompt as soon as possible when installability is announced.
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault(); // hold the event
    deferredPrompt = e;
    console.log("beforeinstallprompt captured");

    // Decide whether to auto-prompt:
    const shouldAutoTry = (cameFromExternalReferrer() || urlRequestsAutoPrompt());

    // If we're allowed by our cooldown and the page is visible, try immediate prompt.
    if (shouldAutoTry && canShowPromptNow()) {
      // If the page is visible, attempt immediate prompt; otherwise wait until visible
      if (document.visibilityState === "visible") {
        attemptPromptWithGestureFallback();
      } else {
        const onVis = () => {
          document.removeEventListener("visibilitychange", onVis);
          attemptPromptWithGestureFallback();
        };
        document.addEventListener("visibilitychange", onVis);
      }
    } else {
      // do not auto show — expose a subtle UI for the user
      createInstallBanner(); // a small CTA that will call prompt when clicked
    }
  });

  // Attempt to call prompt(); if the browser requires a user gesture, we attach a one-time
  // listener for the next user interaction and then call prompt().
  function attemptPromptWithGestureFallback() {
    if (!deferredPrompt) return;

    const alreadyShown = !canShowPromptNow() === true; // if cooldown prevents show
    if (alreadyShown) {
      // fallback: show banner so user can manually install later
      createInstallBanner();
      return;
    }

    // Try to call prompt() directly first (works in many Chrome versions)
    (async () => {
      try {
        await deferredPrompt.prompt();
        const choice = await deferredPrompt.userChoice;
        console.log("Install dialog result:", choice);
        recordPromptShown(choice && choice.outcome);
        deferredPrompt = null;
        removeInstallBanner();
      } catch (err) {
        // If direct prompt failed (maybe needs user gesture), attach one-time gesture listener
        console.warn("Direct prompt failed; will wait for user gesture", err);
        waitForUserGestureThenPrompt();
      }
    })();
  }

  function waitForUserGestureThenPrompt() {
    if (!deferredPrompt) return;

    function onGesture() {
      document.removeEventListener("pointerdown", onGesture);
      document.removeEventListener("keydown", onGesture);
      (async () => {
        try {
          await deferredPrompt.prompt();
          const choice = await deferredPrompt.userChoice;
          console.log("Install dialog result (after gesture):", choice);
          recordPromptShown(choice && choice.outcome);
          deferredPrompt = null;
          removeInstallBanner();
        } catch (err) {
          console.warn("Prompt after gesture failed:", err);
          // show banner as fallback
          createInstallBanner();
        }
      })();
    }

    document.addEventListener("pointerdown", onGesture, { once: true, passive: true });
    document.addEventListener("keydown", onGesture, { once: true, passive: true });

    // Also create banner as a visible fallback (user can click install)
    createInstallBanner();
  }

  // Create an unobtrusive in-page install banner (only if not already present)
  function createInstallBanner() {
    if (installBannerEl || !canShowPromptNow()) return;

    installBannerEl = document.createElement("div");
    installBannerEl.id = "pwa-install-banner";
    installBannerEl.style.cssText = [
      "position:fixed",
      "left:12px",
      "right:12px",
     "top:18px", 
      "padding:12px 14px",
      "background:#fff",
      "color:#000",
      "border-radius:10px",
      "box-shadow:0 8px 30px rgba(0,0,0,.18)",
      "z-index:9999",
      "display:flex",
      "align-items:center",
      "justify-content:space-between",
      "gap:10px",
      "font-family:system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial"
    ].join(";");

    const txt = document.createElement("div");
    txt.style.flex = "1 1 auto";
    txt.style.fontSize = "14px";
    txt.innerHTML = `<strong>Install this app</strong><div style="font-size:12px;color:rgba(0,0,0,.66)">Get a faster experience — add to your home screen.</div>`;

    const btnWrap = document.createElement("div");
    btnWrap.style.display = "flex";
    btnWrap.style.gap = "8px";

    const installBtn = document.createElement("button");
    installBtn.textContent = "Install";
    installBtn.style.cssText = "padding:8px 12px;border-radius:8px;border:0;background:#0a84ff;color:#fff;font-weight:600;cursor:pointer";
    installBtn.addEventListener("click", async () => {
      if (!deferredPrompt) {
        // If beforeinstallprompt never fired (browser supports manual flow), try a fallback:
        // show platform-specific hint (iOS) or encourage Add to Home Screen from menu.
        createManualInstallHint();
        return;
      }
      try {
        await deferredPrompt.prompt();
        const choice = await deferredPrompt.userChoice;
        console.log("Install prompt result (from banner):", choice);
        recordPromptShown(choice && choice.outcome);
        deferredPrompt = null;
        removeInstallBanner();
      } catch (err) {
        console.warn("Install from banner failed:", err);
        createManualInstallHint();
      }
    });

    const closeBtn = document.createElement("button");
    closeBtn.textContent = "Maybe later";
    closeBtn.style.cssText = "padding:8px 12px;border-radius:8px;border:1px solid rgba(0,0,0,.08);background:transparent;cursor:pointer";
    closeBtn.addEventListener("click", () => {
      recordPromptShown("dismissed");
      removeInstallBanner();
    });

    btnWrap.appendChild(installBtn);
    btnWrap.appendChild(closeBtn);

    installBannerEl.appendChild(txt);
    installBannerEl.appendChild(btnWrap);

    document.body.appendChild(installBannerEl);
  }

  function removeInstallBanner() {
    if (!installBannerEl) return;
    installBannerEl.remove();
    installBannerEl = null;
  }

  function createManualInstallHint() {
    // If iOS: show the iOS hint; else show a toast telling user to use browser menu "Add to Home screen"
    if (isiOS() && !isInStandaloneMode()) {
      showIosInstallHint();
    } else {
      // generic hint
      alert("To install: open the browser menu (⋮) and choose 'Add to Home screen' / 'Install app'.");
    }
  }

  // ---------- iOS helper (same as your previous helper) ----------
  function isiOS() {
    return /iphone|ipad|ipod/i.test(window.navigator.userAgent);
  }
  function isInStandaloneMode() {
    return (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) || window.navigator.standalone === true;
  }
  function showIosInstallHint() {
    if (document.getElementById("ios-install-hint")) return;
    const hint = document.createElement("div");
    hint.id = "ios-install-hint";
    hint.style.cssText = "position:fixed;left:12px;right:12px;bottom:14px;padding:12px;background:#fff;color:#000;border-radius:8px;box-shadow:0 6px 18px rgba(0,0,0,.15);z-index:9999;text-align:center;font-size:14px";
    hint.innerHTML = `To install this app on iOS: tap <strong>Share</strong> → <strong>Add to Home Screen</strong>. <button id="ios-install-close" style="margin-left:8px">OK</button>`;
    document.body.appendChild(hint);
    document.getElementById("ios-install-close").addEventListener("click", () => hint.remove());
  }

  // ---------- Observe actual install ----------
  window.addEventListener("appinstalled", () => {
    console.log("PWA installed (appinstalled event)");
    const st = readInstallState();
    st.installed = true;
    st.installedAt = now();
    writeInstallState(st);
    deferredPrompt = null;
    removeInstallBanner();
  });

  // ---------- Public quick helpers (optional) ----------
  // If you want a programmatic "Install" button later, you can call:
  window.pwa = window.pwa || {};
  window.pwa.triggerInstall = async function() {
    if (!deferredPrompt) {
      createManualInstallHint();
      return;
    }
    try {
      await deferredPrompt.prompt();
      const choice = await deferredPrompt.userChoice;
      recordPromptShown(choice && choice.outcome);
      deferredPrompt = null;
      removeInstallBanner();
    } catch (e) {
      console.warn("triggerInstall failed", e);
      createManualInstallHint();
    }
  };

  // Optional: If you want auto prompt for testing, you can append ?auto_prompt=1 to the URL
})();
