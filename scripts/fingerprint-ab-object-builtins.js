// Diagnostic A/B only: bypass profile-ordered Object enumeration hooks. The
// replacements implement ordinary own-key filtering and do not alter network
// traffic or Fingerprint results.
(() => {
  const ownStringKeys = (value) => Reflect.ownKeys(Object(value)).filter(
    (key) => typeof key === "string",
  );
  Object.getOwnPropertyNames = function getOwnPropertyNames(value) {
    return ownStringKeys(value);
  };
  Object.keys = function keys(value) {
    const object = Object(value);
    return ownStringKeys(object).filter(
      (key) => Object.getOwnPropertyDescriptor(object, key)?.enumerable,
    );
  };
})()
