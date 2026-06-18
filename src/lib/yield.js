export function yieldToMain() {
  return new Promise(resolve => {
    if (typeof scheduler !== "undefined" && typeof scheduler.yield === "function") {
      scheduler.yield().then(resolve);
      return;
    }
    setTimeout(resolve, 0);
  });
}

export function isTabVisible() {
  return typeof document === "undefined" || document.visibilityState !== "hidden";
}
