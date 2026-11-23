import * as THREE from 'three';

// ---------------------------------------------------------------------------
// 1) 화면 밖으로 상태를 내보내는 두 경로
//    AR 세션에 들어가면 2D DOM은 보이지 않는다(Quest 브라우저는 dom-overlay를
//    지원하지 않음). 그래서 모든 로그를 DOM과 console 양쪽에 남긴다.
//    console은 chrome://inspect로 붙은 DevTools에서 세션 중에도 실시간으로 보인다.
// ---------------------------------------------------------------------------
const enterButton = document.querySelector('#enter') as HTMLButtonElement;
const statusElement = document.querySelector('#status') as HTMLPreElement;

function log(line: string): void {
  console.log('[mr]', line);
  statusElement.textContent += line + '\n';
}

// ---------------------------------------------------------------------------
// 2) 렌더러
// ---------------------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({
  antialias: true,
  // alpha: canvas를 투명하게. AR에서 우리가 아무것도 그리지 않은 픽셀은
  // 투명으로 남고, 그 자리에 헤드셋이 패스스루 카메라 영상을 합성한다.
  alpha: true,
  // stencil: ④단계의 스텐실 포털이 스텐실 버퍼를 직접 쓴다.
  // 현재 기본값도 true지만, 이 프로젝트의 핵심 요구사항이라 명시해 둔다.
  stencil: true,
});
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);

// 이 한 줄이 three.js의 렌더 경로를 XR 모드로 바꾼다.
// 세션이 붙으면 three.js가 눈(view)별로 카메라를 만들고 두 번 그린다.
renderer.xr.enabled = true;

document.body.appendChild(renderer.domElement);

// ---------------------------------------------------------------------------
// 3) 씬과 카메라
// ---------------------------------------------------------------------------
const scene = new THREE.Scene();
// AR에서 배경을 칠하면 패스스루를 덮어버린다. null이 '아무것도 그리지 않음'.
scene.background = null;

// XR 세션 중에는 three.js가 이 카메라의 행렬과 투영을 헤드셋 포즈로 매 프레임
// 덮어쓴다. 즉 아래 인자들은 세션 '밖' 2D 미리보기에만 쓰인다.
const camera = new THREE.PerspectiveCamera(
  70,
  window.innerWidth / window.innerHeight,
  0.01, // near를 1cm로. 포털에 얼굴을 가까이 댈 수 있어야 하므로.
  20,
);
// 세션 밖 2D 미리보기를 서 있는 눈높이에 맞춘다. 세션에 들어가면 이 값은
// 헤드셋 포즈에 덮여 사라지므로, 순전히 맥 브라우저에서 확인하기 위한 것이다.
camera.position.set(0, 1.3, 0);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---------------------------------------------------------------------------
// 4) 조명
//    AR이지만 실제 방의 조명 정보는 들어오지 않는다(WebXR light estimation은
//    Quest 브라우저에서 아직 못 쓴다). 그래서 방 조명을 '가정'해서 넣는다.
//    HemisphereLight는 위/아래 두 색을 섞는 공짜 환경광이고, DirectionalLight가
//    면마다 명암 차이를 만들어 큐브가 입체로 보이게 한다.
// ---------------------------------------------------------------------------
const hemisphereLight = new THREE.HemisphereLight(0xffffff, 0x444455, 2);
scene.add(hemisphereLight);

const directionalLight = new THREE.DirectionalLight(0xffffff, 2);
directionalLight.position.set(1, 2, 1);
scene.add(directionalLight);

// ---------------------------------------------------------------------------
// 5) 큐브 하나
//    local-floor 기준 공간이라 원점은 '세션을 시작한 자리의 발밑'이고,
//    -Z가 그때 바라보던 방향이다. 따라서 (0, 1.3, -1)은 "시작할 때 보던 쪽으로
//    1m 앞, 눈높이". 세션을 시작할 때 어디를 보고 있었는지에 따라 달라진다.
// ---------------------------------------------------------------------------
const cube = new THREE.Mesh(
  new THREE.BoxGeometry(0.2, 0.2, 0.2), // 단위는 미터. 20cm 큐브.
  new THREE.MeshStandardMaterial({ color: 0xff5533, roughness: 0.4 }),
);
cube.position.set(0, 1.3, -1);
scene.add(cube);

// ---------------------------------------------------------------------------
// 6) 렌더 루프
//    requestAnimationFrame이 아니라 renderer.setAnimationLoop을 쓴다.
//    XR 세션 중에는 프레임 타이밍의 주인이 브라우저 창이 아니라 XRSession이고,
//    three.js가 세션 유무에 따라 둘을 알아서 갈아끼운다.
// ---------------------------------------------------------------------------
renderer.setAnimationLoop(() => {
  // 돌려 두면 "그려지고 있다"와 "멈췄다"를 한눈에 구분할 수 있다.
  // delta time을 안 쓰는 건 지금 프레임레이트가 72/90Hz로 고정이고,
  // 이 큐브는 ②단계 확인용으로만 존재해서다.
  cube.rotation.y += 0.01;
  cube.rotation.x += 0.005;

  renderer.render(scene, camera);
});

// ---------------------------------------------------------------------------
// 7) AR 세션 진입
//    three.js에 ARButton 애드온이 있지만, 여기서는 직접 짠다.
//    세션 수명주기(요청 → setSession → end)가 이 작품의 뼈대이고,
//    애드온이 숨기는 게 바로 그 부분이다.
// ---------------------------------------------------------------------------
const SESSION_MODE: XRSessionMode = 'immersive-ar';

const SESSION_INIT: XRSessionInit = {
  // local-floor: 바닥 높이를 원점으로 하는 기준 공간. three.js의 기본
  // reference space type과 맞춰 둔다(renderer.xr.setReferenceSpaceType 기본값).
  requiredFeatures: ['local-floor'],
  // 여기 있는 건 '있으면 켜 줘'. required에 넣으면 미지원 기기에서
  // requestSession 자체가 실패한다. ③단계에서 plane-detection이 실제로
  // 켜졌는지는 session.enabledFeatures로 확인한다.
  optionalFeatures: ['plane-detection', 'anchors', 'hit-test'],
};

let currentSession: XRSession | null = null;

async function startSession(): Promise<void> {
  const session = await navigator.xr!.requestSession(SESSION_MODE, SESSION_INIT);
  currentSession = session;

  // three.js에 세션을 넘긴다. 이 await 안에서 three.js가 XRWebGLLayer를
  // 만들고 baseLayer로 붙이고 reference space를 요청한다.
  await renderer.xr.setSession(session);

  enterButton.textContent = 'AR 종료';
  log('세션 시작');
  // ①단계의 실제 목적: Quest 3가 뭘 허락했는지 눈으로 확인하는 것.
  log('허용된 기능: ' + (session.enabledFeatures?.join(', ') ?? '(브라우저가 알려주지 않음)'));

  session.addEventListener('end', () => {
    currentSession = null;
    enterButton.textContent = 'AR 시작';
    log('세션 종료');
  });
}

enterButton.addEventListener('click', () => {
  if (currentSession === null) {
    startSession().catch((error: unknown) => {
      log('세션 요청 실패: ' + String(error));
    });
  } else {
    currentSession.end();
  }
});

// ---------------------------------------------------------------------------
// 8) 지원 여부 확인
//    navigator.xr은 secure context(https 또는 localhost)에서만 존재한다.
//    맥의 LAN IP로 http 접속하면 여기서 바로 걸린다 — 그게 adb reverse를
//    쓰는 이유다.
// ---------------------------------------------------------------------------
async function checkSupport(): Promise<void> {
  log('UA: ' + navigator.userAgent);
  log('secure context: ' + window.isSecureContext);

  if (navigator.xr === undefined) {
    enterButton.textContent = 'WebXR 없음';
    log('navigator.xr이 없음 (secure context가 아니거나 WebXR 미지원 브라우저)');
    return;
  }

  const supported = await navigator.xr.isSessionSupported(SESSION_MODE);
  log('immersive-ar 지원: ' + supported);

  if (supported === false) {
    enterButton.textContent = 'immersive-ar 미지원';
    return;
  }

  enterButton.disabled = false;
  enterButton.textContent = 'AR 시작';
}

void checkSupport();
