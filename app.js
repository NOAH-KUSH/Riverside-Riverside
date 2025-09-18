// app.js - improved SW + immediate-install handling

let deferredPrompt = null;
let refreshing = false;

// ---- Service Worker registration + update flow ----
if ("serviceWorker" in navigator) {
  window.addEventListener("load", async () => {
    try {
      const reg = await navigator.serviceWorker.register("service-worker.js");
      console.log("Service Worker registered:", reg);

      // If there's already a waiting SW (e.g. an update was installed earlier), prompt user
      if (reg.waiting) {
        promptUserToUpdate(reg.waiting);
      }

      // Listen for new SW installation
      reg.addEventListener("updatefound", () => {
        const newWorker = reg.installing;
        if (!newWorker) return;
        newWorker.addEventListener("statechange", () => {
          // When the worker becomes 'installed' while we have a controller => update ready
          if (newWorker.state === "installed" && navigator.serviceWorker.controller) {
            promptUserToUpdate(newWorker);
          }
        });
      });

      // If the browser's active controller changes (new SW took control), reload once
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        if (refreshing) return;
        refreshing = true;
        console.log("Controller changed — reloading to activate new SW");
        window.location.reload();
      });

    } catch (err) {
      console.error("SW registration failed", err);
    }
  });
}

/**
 * Prompt the user to update (simple confirm here; replace with a custom UI if you prefer).
 * If user accepts, message the waiting worker to skipWaiting.
 */
function promptUserToUpdate(worker) {
  try {
    // Replace this confirm with a nicer modal/banner in production
    const ok = confirm("A new version is available. Refresh now?");
    if (ok) {
      // Tell the waiting service worker to skipWaiting and become active
      worker.postMessage({ type: "SKIP_WAITING" });
      // controllerchange event will reload the page
    }
  } catch (e) {
    console.warn("promptUserToUpdate error", e);
  }
}

// ---- Immediate "Add to Home Screen" handling ----
// Try to prompt the install dialog as soon as the browser says it's available.
window.addEventListener("beforeinstallprompt", (e) => {
  // Stop the browser from showing the default mini-infobar
  e.preventDefault();
  deferredPrompt = e;

  // Immediately show the prompt (the smallest delay helps some browsers)
  setTimeout(async () => {
    if (!deferredPrompt) return;
    try {
      await deferredPrompt.prompt(); // show install prompt
      const choice = await deferredPrompt.userChoice;
      console.log("Install prompt result:", choice.outcome);
      deferredPrompt = null;
    } catch (err) {
      console.warn("Install prompt failed:", err);
      // You could show a fallback UI here
    }
  }, 100);
});

// Optional: detect that the app was actually installed
window.addEventListener("appinstalled", () => {
  console.log("PWA was installed (appinstalled event)");
  deferredPrompt = null;
  // hide any manual install UI if present
});

// ---- iOS fallback instructions ----
// iOS Safari doesn't support beforeinstallprompt — show small instructions instead.
function isiOS() {
  return /iphone|ipad|ipod/i.test(window.navigator.userAgent);
}
function isInStandaloneMode() {
  return (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) || window.navigator.standalone === true;
}

document.addEventListener("DOMContentLoaded", () => {
  if (isiOS() && !isInStandaloneMode()) {
    showIosInstallHint();
  }
});

function showIosInstallHint() {
  if (document.getElementById("ios-install-hint")) return;
  const hint = document.createElement("div");
  hint.id = "ios-install-hint";
  hint.style.cssText = "position:fixed;left:12px;right:12px;bottom:14px;padding:12px;background:#fff;color:#000;border-radius:8px;box-shadow:0 6px 18px rgba(0,0,0,.15);z-index:9999;text-align:center;font-size:14px";
  hint.innerHTML = `To install this app on iOS: tap <strong>Share</strong> → <strong>Add to Home Screen</strong>. <button id="ios-install-close" style="margin-left:8px">OK</button>`;

  document.body.appendChild(hint);
  document.getElementById("ios-install-close").addEventListener("click", () => hint.remove());
}
