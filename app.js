if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("service-worker.js").then(reg => {
    console.log("Service Worker registered");

    // Listen for updates
    reg.addEventListener("updatefound", () => {
      const newWorker = reg.installing;
      newWorker.addEventListener("statechange", () => {
        if (newWorker.state === "installed" && navigator.serviceWorker.controller) {
          // Show popup
          const refresh = confirm("A new version is available. Refresh now?");
          if (refresh) {
            window.location.reload();
          }
        }
      });
    });
  }).catch(err => console.error("SW registration failed", err));
}
