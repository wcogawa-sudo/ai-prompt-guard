const site = new URLSearchParams(location.search).get("site") || "This site";
document.getElementById("site").textContent = site;

chrome.runtime.sendMessage({ type: "getRedirectTarget" }, (target) => {
  if (!target || !/^https:\/\//.test(target)) return;
  const a = document.getElementById("go");
  a.href = target;
  a.hidden = false;
});
