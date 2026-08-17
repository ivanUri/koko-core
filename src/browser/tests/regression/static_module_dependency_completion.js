import { dependencyValue } from "/static-module-delayed-dependency.js";

document.body.textContent = String(dependencyValue);
document.body.id = dependencyValue === 42 ? "pass" : "fail";
