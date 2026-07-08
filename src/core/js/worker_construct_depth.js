// Shared by worker + shared-worker constructor shims (HTML recursive-creation guard).
(function () {
  function enter() {
    if (globalThis.__veloraWorkerConstructing) {
      throw new RangeError();
    }
    globalThis.__veloraWorkerConstructing = true;
  }
  function exit() {
    globalThis.__veloraWorkerConstructing = false;
  }
  globalThis.__veloraWorkerConstructEnter = enter;
  globalThis.__veloraWorkerConstructExit = exit;
})();