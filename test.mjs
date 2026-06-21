/**
 * 의존성 없는 테스트 하니스.
 * 실제 content.js를 경량 모의 DOM/Chrome API 위에서 구동하고,
 * 광고 시나리오 및 재생속도 동작을 검증한다.
 */
import { readFileSync } from "node:fs";
import vm from "node:vm";
import assert from "node:assert";

const SKIP_SELECTORS = new Set([
  ".ytp-ad-skip-button-modern",
  ".ytp-ad-skip-button",
  ".ytp-skip-ad-button",
  "button.ytp-ad-skip-button-modern",
  "button.ytp-ad-skip-button",
  "button.ytp-skip-ad-button",
  ".ytp-ad-skip-button-container button",
]);
const CLOSE_SELECTORS = new Set([
  ".ytp-ad-overlay-close-button",
  ".ytp-ad-overlay-close-container .ytp-ad-overlay-close-button",
]);

/** 기본은 화면에 보이는(클릭 가능한) 요소. extra로 숨김 등을 흉내낼 수 있다. */
function makeEl(extra = {}) {
  return {
    clicked: 0,
    click() {
      this.clicked += 1;
    },
    offsetParent: {}, // null이 아니면 isClickable이 보임으로 판단
    getClientRects: () => [{}],
    ...extra,
  };
}

/** 테스트가 조작하는 현재 화면 상태 */
function makeScene() {
  const video = { muted: false, duration: NaN, currentTime: 0, playbackRate: 1 };
  return {
    adShowing: false,
    skipButton: null, // 플레이어 내부 건너뛰기 버튼: makeEl() 또는 null
    closeButton: null,
    pageSkipButton: null, // 플레이어 밖(페이지 상단 등) 요소: 절대 눌리면 안 됨
    video,
  };
}

/** content.js 한 인스턴스를 격리 컨텍스트에서 구동하고 핸들을 돌려준다 */
function bootContentScript(source) {
  const scene = makeScene();
  let intervalFn = null;
  const store = {};
  const changeListeners = [];

  // 광고 버튼은 플레이어 내부에서만 조회된다 (content.js가 player를 root로 넘김)
  const player = {
    classList: { contains: (c) => c === "ad-showing" && scene.adShowing },
    querySelector: (sel) => {
      if (sel === "video") return scene.video;
      if (SKIP_SELECTORS.has(sel)) return scene.skipButton;
      if (CLOSE_SELECTORS.has(sel)) return scene.closeButton;
      return null;
    },
  };

  const document = {
    body: { /* observe 대상 */ },
    addEventListener() {},
    querySelector(sel) {
      if (sel === ".html5-video-player") return player;
      // 플레이어 밖에서 skip 셀렉터가 매칭되는 상황(예: "메뉴 건너뛰기")을 흉내낸다.
      // content.js는 player를 root로만 조회하므로 여기에 닿으면 안 된다.
      if (SKIP_SELECTORS.has(sel)) return scene.pageSkipButton;
      return null;
    },
  };

  const chrome = {
    storage: {
      local: {
        get(keys, cb) {
          const out = {};
          for (const k of [].concat(keys)) out[k] = store[k];
          cb(out);
        },
        set(obj) {
          Object.assign(store, obj);
          for (const l of changeListeners) {
            const changes = {};
            for (const k of Object.keys(obj)) changes[k] = { newValue: obj[k] };
            l(changes, "local");
          }
        },
      },
      onChanged: { addListener: (l) => changeListeners.push(l) },
    },
  };

  const sandbox = {
    chrome,
    document,
    Date,
    setInterval: (fn) => {
      intervalFn = fn;
      return 1;
    },
    requestAnimationFrame: () => {},
    MutationObserver: class {
      observe() {}
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);

  return {
    scene,
    store,
    tick: () => intervalFn && intervalFn(),
    setEnabled: (enabled) =>
      chrome.storage.local.set({ yt_ad_skip_settings: { enabled } }),
    setSpeed: (speed) =>
      chrome.storage.local.set({
        yt_ad_skip_settings: { enabled: true, speed },
      }),
  };
}

const source = readFileSync(new URL("./content.js", import.meta.url), "utf8");

let passed = 0;
function test(name, fn) {
  const h = bootContentScript(source);
  fn(h);
  passed += 1;
  console.log(`  ✓ ${name}`);
}

console.log("content.js 광고 스킵 + 재생속도 테스트\n");

test("건너뛰기 버튼이 있으면 자동 클릭한다", (h) => {
  h.scene.adShowing = true;
  h.scene.skipButton = makeEl();
  h.tick();
  assert.strictEqual(h.scene.skipButton.clicked, 1, "skip 버튼이 클릭돼야 함");
});

test("건너뛰기 버튼 클릭 시 카운터가 증가한다", (h) => {
  h.scene.adShowing = true;
  h.scene.skipButton = makeEl();
  h.tick();
  assert.strictEqual(h.store.yt_ad_skip_count, 1, "카운트가 1이어야 함");
});

test("건너뛰기 불가 광고는 음소거 + 끝으로 점프한다", (h) => {
  h.scene.adShowing = true;
  h.scene.skipButton = null;
  h.scene.video.duration = 30;
  h.scene.video.currentTime = 5;
  h.tick();
  assert.strictEqual(h.scene.video.muted, true, "음소거돼야 함");
  assert.strictEqual(h.scene.video.currentTime, 30, "끝으로 점프해야 함");
});

test("duration 미상 광고는 재생속도를 최대로 올린다", (h) => {
  h.scene.adShowing = true;
  h.scene.skipButton = null;
  h.scene.video.duration = NaN;
  h.tick();
  assert.strictEqual(h.scene.video.playbackRate, 16, "playbackRate=16 이어야 함");
});

test("오버레이/배너 광고의 닫기 버튼을 클릭한다", (h) => {
  h.scene.adShowing = false;
  h.scene.closeButton = makeEl();
  h.tick();
  assert.strictEqual(h.scene.closeButton.clicked, 1, "닫기 버튼이 클릭돼야 함");
});

test("광고 표시(.ad-showing)가 꺼진 뒤 남은 건너뛰기 버튼도 클릭한다", (h) => {
  // 광고가 끝으로 점프했지만 "넘어가기" 버튼만 남아있는 상황
  h.scene.adShowing = false;
  h.scene.skipButton = makeEl();
  h.tick();
  assert.strictEqual(h.scene.skipButton.clicked, 1, "남은 skip 버튼이 클릭돼야 함");
});

test("숨겨진 건너뛰기 버튼은 클릭하지 않는다", (h) => {
  h.scene.adShowing = false;
  h.scene.skipButton = makeEl({ offsetParent: null, getClientRects: () => [] });
  h.tick();
  assert.strictEqual(h.scene.skipButton.clicked, 0, "숨김 버튼은 클릭 안 함");
});

test("플레이어 밖의 'Skip' 버튼은 누르지 않는다 (카운터 오작동 방지)", (h) => {
  h.scene.adShowing = false;
  h.scene.skipButton = null; // 플레이어 안엔 없음
  h.scene.pageSkipButton = makeEl(); // 페이지 상단 "메뉴 건너뛰기" 같은 요소
  h.tick();
  assert.strictEqual(
    h.scene.pageSkipButton.clicked,
    0,
    "플레이어 밖 버튼은 클릭하면 안 됨"
  );
  assert.strictEqual(h.store.yt_ad_skip_count || 0, 0, "카운터가 오르면 안 됨");
});

test("토글 OFF면 아무 동작도 하지 않는다", (h) => {
  h.setEnabled(false);
  h.scene.adShowing = true;
  h.scene.skipButton = makeEl();
  h.tick();
  assert.strictEqual(h.scene.skipButton.clicked, 0, "OFF면 클릭 안 함");
});

test("OFF 후 다시 ON하면 동작이 재개된다", (h) => {
  h.setEnabled(false);
  h.setEnabled(true);
  h.scene.adShowing = true;
  h.scene.skipButton = makeEl();
  h.tick();
  assert.strictEqual(h.scene.skipButton.clicked, 1, "다시 ON되면 클릭돼야 함");
});

test("사용자 지정 배속(3배)을 본영상에 적용한다", (h) => {
  h.setSpeed(3);
  assert.strictEqual(h.scene.video.playbackRate, 3, "playbackRate=3 이어야 함");
});

test("기본 배속(1배)일 땐 영상 속도에 관여하지 않는다", (h) => {
  h.scene.video.playbackRate = 1.5; // 사용자가 YouTube에서 직접 바꾼 상태
  h.tick();
  assert.strictEqual(
    h.scene.video.playbackRate,
    1.5,
    "1배 설정이면 건드리지 않아야 함"
  );
});

test("광고 중에는 사용자 배속을 적용하지 않는다", (h) => {
  h.scene.adShowing = true;
  h.setSpeed(3); // 광고 중 → 본영상 배속 적용 보류
  assert.notStrictEqual(
    h.scene.video.playbackRate,
    3,
    "광고 중엔 본영상 배속 미적용"
  );
});

test("배속 적용 후 다시 1배로 되돌리면 1배로 반영된다", (h) => {
  h.setSpeed(3);
  assert.strictEqual(h.scene.video.playbackRate, 3);
  h.setSpeed(1);
  assert.strictEqual(h.scene.video.playbackRate, 1, "1배 선택 시 1배로 복귀");
});

console.log(`\n✅ ${passed}개 테스트 모두 통과`);
