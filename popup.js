/** 팝업 UI 로직 — 토글/재생속도 상태와 스킵 카운터를 storage와 동기화 */

const STORAGE_KEY = "yt_ad_skip_settings";
const COUNT_KEY = "yt_ad_skip_count";

const toggle = document.getElementById("toggle");
const statusText = document.getElementById("status-text");
const countEl = document.getElementById("count");
const speedEl = document.getElementById("speed");
const speedVal = document.getElementById("speed-val");
const chips = Array.from(document.querySelectorAll(".chip"));

// 팝업이 보유한 현재 설정 (저장 시 통째로 써서 한 항목이 다른 항목을 덮어쓰지 않게 함)
let settings = { enabled: true, speed: 1 };

function fmtSpeed(v) {
  return parseFloat(v) + "×";
}

function normalizeSpeed(v) {
  return typeof v === "number" && v > 0 ? v : 1;
}

function renderEnabled(enabled) {
  toggle.checked = enabled;
  statusText.textContent = enabled ? "동작 중" : "꺼짐";
}

function renderSpeed(speed) {
  const s = normalizeSpeed(parseFloat(speed));
  speedEl.value = String(s);
  speedVal.textContent = fmtSpeed(s);
  chips.forEach((c) =>
    c.classList.toggle("active", parseFloat(c.dataset.speed) === s)
  );
}

function save() {
  chrome.storage.local.set({
    [STORAGE_KEY]: { enabled: settings.enabled, speed: settings.speed },
  });
}

// 초기 상태 로드
chrome.storage.local.get([STORAGE_KEY, COUNT_KEY], (res) => {
  const s = res?.[STORAGE_KEY] || {};
  settings.enabled = s.enabled !== false; // 기본 ON
  settings.speed = normalizeSpeed(s.speed);
  renderEnabled(settings.enabled);
  renderSpeed(settings.speed);
  countEl.textContent = res?.[COUNT_KEY] || 0;
});

// 토글 변경 저장
toggle.addEventListener("change", () => {
  settings.enabled = toggle.checked;
  renderEnabled(settings.enabled);
  save();
});

// 슬라이더로 속도 변경
speedEl.addEventListener("input", () => {
  settings.speed = normalizeSpeed(parseFloat(speedEl.value));
  renderSpeed(settings.speed);
  save();
});

// 프리셋 칩으로 속도 변경
chips.forEach((c) =>
  c.addEventListener("click", () => {
    settings.speed = normalizeSpeed(parseFloat(c.dataset.speed));
    renderSpeed(settings.speed);
    save();
  })
);

// 다른 곳(content script 등)에서의 변경 실시간 반영
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes[COUNT_KEY]) countEl.textContent = changes[COUNT_KEY].newValue || 0;
  if (changes[STORAGE_KEY]) {
    const nv = changes[STORAGE_KEY].newValue || {};
    settings.enabled = nv.enabled !== false;
    settings.speed = normalizeSpeed(nv.speed);
    renderEnabled(settings.enabled);
    renderSpeed(settings.speed);
  }
});
