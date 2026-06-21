/**
 * YouTube 광고 스킵 + 재생 속도 제어 - content script
 *
 * 동작 방식 (DOM 조작):
 *  1) 플레이어에 `.ad-showing` 클래스가 붙으면 광고 재생 중으로 판단
 *  2) "건너뛰기" 버튼이 보이면 즉시 클릭 (광고 종료 직후 .ad-showing이 꺼진 뒤
 *     남아있는 "넘어가기" 버튼까지 눌러준다)
 *  3) 건너뛰기 불가 광고는 음소거 + 영상 끝으로 점프시켜 순식간에 넘김
 *  4) 배너/오버레이 광고는 닫기 버튼을 클릭
 *  5) 사용자가 지정한 재생 속도(YouTube 기본 2배 제한을 넘어 최대 5배)를 본영상에 유지
 *
 * YouTube는 마크업을 종종 바꾸기 때문에 셀렉터는 여러 후보를 두고 방어적으로 처리한다.
 */

(() => {
  "use strict";

  const STORAGE_KEY = "yt_ad_skip_settings";
  const COUNT_KEY = "yt_ad_skip_count";

  // 런타임 상태
  let enabled = true;
  let speed = 1; // 사용자 지정 배속 (1 = YouTube 기본값에 맡김)
  let wasAd = false; // 직전 tick의 광고 표시 여부 (광고 종료 감지용)
  let weMuted = false; // 고속 스킵을 위해 우리가 음소거했는지
  let lastCountAt = 0; // 스킵 카운트 중복 방지용 타임스탬프

  // "건너뛰기" 버튼 후보 셀렉터 (마크업 변화 대비 다중 후보).
  // 광고 전용 클래스만 사용한다 — aria 라벨 폴백은 페이지 상단 "메뉴 건너뛰기"
  // 같은 접근성 버튼까지 잡아 카운터가 멋대로 오르므로 쓰지 않는다.
  const SKIP_BUTTON_SELECTORS = [
    ".ytp-ad-skip-button-modern",
    ".ytp-ad-skip-button",
    ".ytp-skip-ad-button",
    "button.ytp-ad-skip-button-modern",
    "button.ytp-ad-skip-button",
    "button.ytp-skip-ad-button",
    ".ytp-ad-skip-button-container button",
  ];

  // 배너/오버레이 광고 닫기 버튼 후보
  const CLOSE_BUTTON_SELECTORS = [
    ".ytp-ad-overlay-close-button",
    ".ytp-ad-overlay-close-container .ytp-ad-overlay-close-button",
  ];

  function applySettings(s) {
    enabled = s?.enabled !== false; // 기본값 ON
    speed = typeof s?.speed === "number" && s.speed > 0 ? s.speed : 1;
  }

  function loadSettings() {
    try {
      chrome.storage?.local.get([STORAGE_KEY], (res) => {
        applySettings(res?.[STORAGE_KEY]);
        applySpeed(true);
      });
    } catch (_) {
      // storage 접근 불가 시 기본값 유지
    }
  }

  function bumpCount() {
    try {
      chrome.storage?.local.get([COUNT_KEY], (res) => {
        const total = (res?.[COUNT_KEY] || 0) + 1;
        chrome.storage?.local.set({ [COUNT_KEY]: total });
      });
    } catch (_) {
      /* noop */
    }
  }

  function countSkip() {
    // MutationObserver가 짧은 시간에 tick을 여러 번 부를 수 있어 중복 카운트를 막는다
    const now = Date.now();
    if (now - lastCountAt < 1000) return;
    lastCountAt = now;
    bumpCount();
  }

  function isClickable(el) {
    if (!el || typeof el.click !== "function") return false;
    // 화면에 보이는 요소만 클릭 — DOM에 남은 숨김 버튼 오클릭/오카운트 방지
    if (el.offsetParent !== null) return true;
    const rects = el.getClientRects && el.getClientRects();
    return !!(rects && rects.length);
  }

  function clickFirst(selectors, root) {
    const scope = root || document;
    for (const sel of selectors) {
      const el = scope.querySelector(sel);
      if (isClickable(el)) {
        el.click();
        return true;
      }
    }
    return false;
  }

  function isAdShowing(player) {
    return !!player && player.classList.contains("ad-showing");
  }

  function currentVideo(player) {
    const p = player || document.querySelector(".html5-video-player");
    return p ? p.querySelector("video") : document.querySelector("video");
  }

  function setRate(video, rate) {
    try {
      if (
        video &&
        Number.isFinite(rate) &&
        rate > 0 &&
        video.playbackRate !== rate
      ) {
        video.playbackRate = rate;
      }
    } catch (_) {
      /* 일부 상태에서 set이 막힐 수 있음 */
    }
  }

  function fastForwardAd(video) {
    if (!video) return;
    try {
      if (!video.muted) {
        weMuted = true;
        video.muted = true;
      }
      const d = video.duration;
      if (Number.isFinite(d) && d > 0) {
        // 이미 끝부분이면 다시 seek 하지 않는다 (반복 seek로 인한 버벅임 방지)
        if (video.currentTime < d - 0.5) video.currentTime = d;
      } else if (video.playbackRate < 16) {
        video.playbackRate = 16; // duration 미상이면 재생속도라도 최대로
      }
    } catch (_) {
      /* noop */
    }
  }

  /**
   * 사용자가 지정한 배속을 본영상에 적용.
   *  - force=false: 유지용. 기본 1배는 YouTube에 맡겨 네이티브 속도 메뉴와 충돌하지 않게 둔다.
   *  - force=true : 사용자가 방금 선택/해제 → 1배라도 즉시 반영.
   */
  function applySpeed(force) {
    if (!enabled) return;
    if (!force && speed === 1) return;
    const player = document.querySelector(".html5-video-player");
    if (isAdShowing(player)) return; // 광고는 고속 스킵 로직이 담당
    setRate(currentVideo(player), speed > 0 ? speed : 1);
  }

  // 광고 종료 직후: 우리가 건드린 음소거/고속을 원복
  function restoreAfterAd() {
    const v = currentVideo();
    if (!v) return;
    if (weMuted) {
      try {
        v.muted = false;
      } catch (_) {
        /* noop */
      }
      weMuted = false;
    }
    // 광고용으로 올린 고속(16x)이 본영상에 남지 않도록 사용자 배속(없으면 1배)으로 원복
    if (v.playbackRate > 2) setRate(v, speed > 0 ? speed : 1);
  }

  function tick() {
    if (!enabled) return;

    const player = document.querySelector(".html5-video-player");
    const adNow = isAdShowing(player);

    // 광고 처리는 플레이어 내부로만 한정한다 — 페이지 상단 "메뉴 건너뛰기" 같은
    // 접근성 버튼을 잘못 눌러 카운터가 멋대로 오르는 일을 막는다.
    if (player) {
      // 건너뛰기 버튼이 보이면 클릭 (.ad-showing이 꺼진 뒤 남은 버튼까지).
      // 없고 광고 중이면 고속 스킵.
      if (clickFirst(SKIP_BUTTON_SELECTORS, player)) countSkip();
      else if (adNow) fastForwardAd(player.querySelector("video"));

      // 배너/오버레이 광고 닫기
      clickFirst(CLOSE_BUTTON_SELECTORS, player);
    }

    // 광고 종료 감지 → 음소거/고속 원복
    if (wasAd && !adNow) restoreAfterAd();
    wasAd = adNow;

    // 사용자 지정 배속 유지
    if (!adNow) applySpeed(false);
  }

  // storage 변경 실시간 반영 (팝업에서 토글/속도 변경 시)
  try {
    chrome.storage?.onChanged.addListener((changes, area) => {
      if (area === "local" && changes[STORAGE_KEY]) {
        applySettings(changes[STORAGE_KEY].newValue);
        applySpeed(true); // 새 속도 즉시 반영
      }
    });
  } catch (_) {
    /* noop */
  }

  // SPA 페이지 전환 시 배속 재적용 (새 영상에서도 지정 배속 유지)
  try {
    document.addEventListener?.("yt-navigate-finish", () => applySpeed(false));
  } catch (_) {
    /* noop */
  }

  loadSettings();

  // 가벼운 폴링만으로 광고를 감지/스킵한다.
  // MutationObserver로 YouTube의 잦은 DOM 변경마다 tick을 돌리면 메인 스레드가
  // 포화되어 클릭/키보드 입력이 멈추는 현상이 생길 수 있어 쓰지 않는다.
  setInterval(tick, 300);
})();
