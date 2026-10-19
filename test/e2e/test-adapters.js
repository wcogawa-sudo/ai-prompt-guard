// Test build only: map localhost mock pages to the real adapters' selectors.
(function () {
  const A = globalThis.PG.adapters;
  const real = (name) => A.registry.find((a) => a.name === name);
  const chatgpt = A.makeAdapter({ ...real("chatgpt"), name: "chatgpt", hosts: ["localhost"] });
  const claude = A.makeAdapter({ ...real("claude"), name: "claude", hosts: ["localhost"] });
  const original = A.forLocation;
  A.forLocation = (loc) => {
    if (loc.hostname !== "localhost") return original(loc);
    return loc.pathname.includes("claude") ? claude : chatgpt;
  };
})();
