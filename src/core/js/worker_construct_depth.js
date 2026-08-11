// Shared by worker + shared-worker constructor shims (HTML recursive-creation guard).
(function () {
  function enter() {
    if (globalThis.__kokoWorkerConstructing) {
      throw new RangeError();
    }
    globalThis.__kokoWorkerConstructing = true;
  }
  function exit() {
    globalThis.__kokoWorkerConstructing = false;
  }
  globalThis.__kokoWorkerConstructEnter = enter;
  globalThis.__kokoWorkerConstructExit = exit;
})();