(function installStyloFixtureHelpers() {
  function unsupported(reason, details = {}) {
    return { status: "unsupported", reason, details };
  }

  function readStyle(element, properties, pseudo = undefined) {
    if (!element || typeof window.getComputedStyle !== "function") {
      return unsupported("getComputedStyle is unavailable");
    }
    let style;
    try {
      style = window.getComputedStyle(element, pseudo);
    } catch (error) {
      return unsupported(`getComputedStyle threw: ${error.name || error}`);
    }
    if (!style || typeof style.getPropertyValue !== "function") {
      return unsupported("computed style object is unavailable");
    }
    const observations = {};
    for (const property of properties) {
      const value = style.getPropertyValue(property);
      if (typeof value !== "string" || value.length === 0) {
        return unsupported(`computed style did not expose ${property}`);
      }
      observations[property] = value;
    }
    return observations;
  }

  function install(test) {
    window.__styloTest = test;
    window.testing = {
      attempts: 0,
      assertOk() {
        if (!window.__styloResult) {
          if (++this.attempts > 80) throw new Error(document.body?.textContent || "stylo fixture timed out");
          return false;
        }
        if (window.__styloResult.status === "error") {
          throw new Error(window.__styloResult.reason);
        }
        return window.__styloResult.status === "pass" || window.__styloResult.status === "unsupported";
      },
      printTimeoutState: () => console.log(document.body?.textContent || ""),
    };

    Promise.resolve()
      .then(() => test())
      .then((result) => {
        window.__styloResult = result;
        if (document.body) {
          document.body.id = result.status;
          document.body.textContent = JSON.stringify(result);
        }
      })
      .catch((error) => {
        window.__styloResult = { status: "error", reason: `${error.name || "Error"}: ${error.message || error}` };
        if (document.body) {
          document.body.id = "error";
          document.body.textContent = window.__styloResult.reason;
        }
      });
  }

  window.styloFixture = { install, readStyle, unsupported };
})();
