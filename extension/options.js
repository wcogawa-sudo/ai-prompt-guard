const FIELDS = ["collectorUrl", "collectorToken", "userName", "deviceId", "group", "policyJson", "peopleNames", "evidenceConfig"];

function row(dl, k, v, cls) {
  const dt = document.createElement("dt");
  dt.textContent = k;
  const dd = document.createElement("dd");
  dd.textContent = v;
  if (cls) dd.className = cls;
  dl.append(dt, dd);
}

async function render() {
  const { options = {}, policyError } = await chrome.storage.local.get(["options", "policyError"]);
  let managed = {};
  try { managed = await chrome.storage.managed.get(null); } catch (_) { /* none */ }

  for (const f of FIELDS) {
    const el = document.getElementById(f);
    el.value = options[f] || "";
    if (managed[f] !== undefined) {
      el.value = f === "collectorToken" ? "••••••" : managed[f];
      el.disabled = true;
    }
  }

  const s = await chrome.runtime.sendMessage({ type: "status" });
  // Managed by an organisation: every local setting is ignored, so lock the page.
  if (s.managed) {
    document.querySelectorAll("input, textarea, #save").forEach((x) => { x.disabled = true; });
    document.getElementById("saved").textContent = "These settings are managed by your organisation.";
  }
  const wEl = document.getElementById("warningsEnabled");
  wEl.checked = s.warningsEnabled !== false;
  wEl.disabled = managed.warningsEnabled !== undefined;
  const dl = document.getElementById("status");
  dl.replaceChildren();
  if (s.scope) {
    row(dl, "Monitoring", s.scope.active
      ? `Active (${s.scope.reason})`
      : `Paused: not at work (${s.scope.reason})`, s.scope.active ? "ok" : "");
  }
  row(dl, "Warnings", s.warningsEnabled === false ? "Off (silent redaction)" : s.warningsEnabled === true ? "On" : "Per rule");
  row(dl, "Encrypted originals", s.evidence ? `On (key ${s.evidence})` : "Off");
  row(dl, "User", s.userName);
  row(dl, "Device", s.deviceId);
  row(dl, "Group", s.group || "—");
  row(dl, "Policy version", String(s.policyVersion));
  row(dl, "Managed by org", s.managedKeys.length ? s.managedKeys.join(", ") : "no");
  row(dl, "Collector", s.collectorUrl || "not set (logs are queued locally)");
  row(dl, "Queued events", String(s.queued));
  if (s.dropped) row(dl, "Dropped (queue full)", String(s.dropped), "bad");
  if (s.lastFlush) {
    row(dl, "Last upload", s.lastFlush.ok
      ? `OK, ${s.lastFlush.sent} events at ${new Date(s.lastFlush.at).toLocaleString()}`
      : `Failed at ${new Date(s.lastFlush.at).toLocaleString()}: ${s.lastFlush.error}`, s.lastFlush.ok ? "ok" : "bad");
  }
  if (policyError) row(dl, "Policy error", `${policyError.source}: ${policyError.error}`, "bad");
}

document.getElementById("save").addEventListener("click", async () => {
  const options = {};
  for (const f of FIELDS) {
    const el = document.getElementById(f);
    if (!el.disabled && el.value.trim()) options[f] = el.value.trim();
  }
  const wEl = document.getElementById("warningsEnabled");
  if (!wEl.disabled) options.warningsEnabled = wEl.checked;
  if (options.evidenceConfig) {
    try {
      const e = JSON.parse(options.evidenceConfig);
      const ev = e.evidence || e;
      if (!ev.public_key_spki) throw new Error("missing public_key_spki");
    } catch (e) {
      document.getElementById("saved").textContent = `Evidence key invalid: ${e.message}`;
      return;
    }
  }
  if (options.policyJson) {
    try { JSON.parse(options.policyJson); } catch (e) {
      document.getElementById("saved").textContent = `Policy JSON invalid: ${e.message}`;
      return;
    }
  }
  await chrome.storage.local.remove("policyError");
  await chrome.storage.local.set({ options });
  const urlEl = document.getElementById("collectorUrl");
  document.getElementById("saved").textContent = !urlEl.disabled && !options.collectorUrl
    ? "Saved, but no Collector URL is set: logs will queue on this device and not be uploaded."
    : "Saved.";
  setTimeout(render, 500);
});

document.getElementById("flush").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "flushNow" });
  render();
});

render();
