if (executionOrder.join(",") !== "first,inline") {
  document.querySelector("#result").textContent = "FAIL:second:" + executionOrder.join(",");
}
executionOrder.push("second");
