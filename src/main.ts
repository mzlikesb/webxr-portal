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
// 5) 평면 감지
//
//    WebXR 런타임이 방을 스캔해서 만든 평면들을 매 프레임 XRFrame.detectedPlanes로
//    준다. Quest에서는 '공간 설정'(룸 스캔) 데이터가 출처라서, 스캔을 한 적이
//    없으면 이 집합은 비어 있다. 우리가 만드는 게 아니라 받아오는 것이다.
//
//    three.js에 XRPlanes 애드온과 'planesdetected' 이벤트가 있지만 둘 다 안 쓴다.
//    이벤트는 어차피 매 프레임 발생해서 루프 대비 이득이 없고, @types/three가
//    이벤트 payload를 XRPlaneSet으로 잘못 선언해 둬서(실제로는 XRFrame) 캐스팅이
//    필요해진다. 루프에서 직접 읽으면 타입이 맞는다.
// ---------------------------------------------------------------------------

/** XRPlane은 런타임이 소유하는 객체라, 같은 평면이면 프레임이 바뀌어도 같은
 *  참조가 유지된다. 그래서 Map의 키로 쓸 수 있다. */
const planeMeshes = new Map<XRPlane, THREE.Mesh>();

/** 평면의 모양이 언제 갱신됐는지. Quest는 스캔을 하면서 폴리곤을 계속 다듬는다. */
const planeShapeTimes = new Map<XRPlane, DOMHighResTimeStamp>();

const planeMatrix = new THREE.Matrix4();

function buildPlaneGeometry(plane: XRPlane): THREE.BufferGeometry {
  // polygon의 점들은 '그 평면의 로컬 좌표계'에 있고, 그 좌표계는 평면이
  // X-Z에 눕도록 잡혀 있다(모든 점의 y가 0). 즉 평면의 법선은 언제나 로컬 +Y다.
  // 벽도 예외가 아니다 — 벽은 그 좌표계 통째로 세워져 있을 뿐이다.
  // ④단계에서 포털을 벽에 붙일 때 이게 핵심이 된다.
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;

  for (const point of plane.polygon) {
    minX = Math.min(minX, point.x);
    maxX = Math.max(maxX, point.x);
    minZ = Math.min(minZ, point.z);
    maxZ = Math.max(maxZ, point.z);
  }

  // 폴리곤 그대로가 아니라 바운딩 사각형으로 단순화한다. 지금은 '벽이 어디
  // 있는지' 보이기만 하면 되고, 포털도 사각형이라 이걸로 충분하다.
  const geometry = new THREE.PlaneGeometry(maxX - minX, maxZ - minZ);
  // PlaneGeometry는 X-Y에 서 있다. 평면 좌표계에 맞추려면 X-Z로 눕힌다.
  geometry.rotateX(-Math.PI / 2);
  // 바운딩 사각형의 중심이 로컬 원점이 아닐 수 있으므로 옮겨 준다.
  geometry.translate((minX + maxX) / 2, 0, (minZ + maxZ) / 2);

  return geometry;
}

function buildPlaneMesh(plane: XRPlane): THREE.Mesh {
  const isWall = plane.orientation === 'vertical';

  const material = new THREE.MeshBasicMaterial({
    color: isWall ? 0x33ff88 : 0x3366ff,
    transparent: true,
    opacity: 0.25,
    // 평면은 양쪽에서 다 보여야 한다. 뒤에서 보면 사라지면 곤란하다.
    side: THREE.DoubleSide,
    // 반투명 오버레이가 깊이 버퍼를 오염시켜 뒤의 물체를 가리지 않게.
    depthWrite: false,
  });

  return new THREE.Mesh(buildPlaneGeometry(plane), material);
}

function disposePlane(plane: XRPlane): void {
  const mesh = planeMeshes.get(plane);
  if (mesh === undefined) return;

  scene.remove(mesh);
  // three.js는 GPU 자원을 GC해 주지 않는다. 직접 버려야 한다.
  mesh.geometry.dispose();
  (mesh.material as THREE.Material).dispose();

  planeMeshes.delete(plane);
  planeShapeTimes.delete(plane);
}

let lastPlaneSummary = '';

function updatePlanes(frame: XRFrame, referenceSpace: XRReferenceSpace): void {
  const detectedPlanes = frame.detectedPlanes;
  // plane-detection이 안 켜진 세션에서는 아예 undefined다.
  if (detectedPlanes === undefined) return;

  // 런타임이 더 이상 추적하지 않는 평면 치우기.
  for (const plane of planeMeshes.keys()) {
    if (detectedPlanes.has(plane) === false) disposePlane(plane);
  }

  for (const plane of detectedPlanes) {
    let mesh = planeMeshes.get(plane);

    if (mesh === undefined) {
      mesh = buildPlaneMesh(plane);
      scene.add(mesh);
      planeMeshes.set(plane, mesh);
      planeShapeTimes.set(plane, plane.lastChangedTime);
    } else if (planeShapeTimes.get(plane) !== plane.lastChangedTime) {
      // 모양이 다듬어졌다. 지오메트리만 새로 만든다.
      mesh.geometry.dispose();
      mesh.geometry = buildPlaneGeometry(plane);
      planeShapeTimes.set(plane, plane.lastChangedTime);
    }

    // 위치는 매 프레임 갱신한다. 평면은 추적이 진행되면서 조금씩 움직인다.
    const pose = frame.getPose(plane.planeSpace, referenceSpace);
    // 일시적으로 추적을 놓치면 null이 온다. 그 프레임은 그냥 건너뛴다.
    if (pose === undefined || pose === null) continue;

    planeMatrix.fromArray(pose.transform.matrix);
    mesh.position.setFromMatrixPosition(planeMatrix);
    mesh.quaternion.setFromRotationMatrix(planeMatrix);
    // three.js는 보통 render() 때 행렬을 갱신한다. 하지만 아래 ⑥의 레이캐스트가
    // render보다 먼저 돌고 matrixWorld를 읽으므로, 여기서 직접 갱신해 둔다.
    // 안 하면 평면이 생긴 첫 프레임에 행렬이 단위행렬이라 엉뚱한 데를 맞춘다.
    mesh.updateMatrixWorld();
  }

  reportPlanes(detectedPlanes);
}

function extentOf(plane: XRPlane, axis: 'x' | 'z'): number {
  let min = Infinity;
  let max = -Infinity;
  for (const point of plane.polygon) {
    min = Math.min(min, point[axis]);
    max = Math.max(max, point[axis]);
  }
  return max - min;
}

/** 세션 안에서는 DOM이 안 보이므로, 평면 목록은 나중에/DevTools로 읽기 위해
 *  남긴다. 매 프레임 찍으면 로그가 터지니 내용이 바뀔 때만 쓴다. */
function reportPlanes(detectedPlanes: XRPlaneSet): void {
  const lines: string[] = [];

  for (const plane of detectedPlanes) {
    const label = plane.semanticLabel ?? '?';
    const width = extentOf(plane, 'x');
    const height = extentOf(plane, 'z');
    lines.push(`${plane.orientation}/${label} ${width.toFixed(2)}x${height.toFixed(2)}m`);
  }

  const summary = `평면 ${detectedPlanes.size}개: ${lines.sort().join(', ')}`;
  if (summary === lastPlaneSummary) return;

  lastPlaneSummary = summary;
  log(summary);
}

// ---------------------------------------------------------------------------
// 6) 포털 자리 잡기
//
//    시선 레이를 쏴서 ⑤의 벽 메시와 교차시키고, 거기에 포털 미리보기를 붙여
//    둔다. 벽이 안 잡히면 눈앞 1.5m에 세운다(평면 감지가 아예 안 되는 기기의
//    대체 경로도 겸한다). 트리거를 당기면 그 자리에 확정된다.
// ---------------------------------------------------------------------------
const PORTAL_WIDTH = 0.9;
const PORTAL_HEIGHT = 1.6;
/** 벽을 못 찾았을 때 포털을 띄울 거리. */
const PORTAL_FALLBACK_DISTANCE = 1.5;

const portalSurfaceMaterial = new THREE.MeshBasicMaterial({
  color: 0x000000,
  transparent: true,
  opacity: 0.25,
});
const portalEdgeMaterial = new THREE.LineBasicMaterial({ color: 0x66ccff });

const portal = new THREE.Group();
scene.add(portal);

{
  // PlaneGeometry는 X-Y에 서서 +Z를 향한다. 아래 orientPortal이 그룹의 로컬
  // +Z를 벽의 법선에 맞추므로, 여기서 따로 돌릴 필요가 없다.
  const surface = new THREE.Mesh(
    new THREE.PlaneGeometry(PORTAL_WIDTH, PORTAL_HEIGHT),
    portalSurfaceMaterial,
  );
  portal.add(surface);

  // 테두리. ④단계에서 안쪽은 스텐실 포털로 바뀌지만 테두리는 남는다.
  portal.add(new THREE.LineSegments(new THREE.EdgesGeometry(surface.geometry), portalEdgeMaterial));
}

const raycaster = new THREE.Raycaster();
const WORLD_UP = new THREE.Vector3(0, 1, 0);

// 매 프레임 new Vector3를 만들지 않으려고 미리 잡아 둔다. three.js 코드에서
// 흔한 관습이다.
const pointerOrigin = new THREE.Vector3();
const pointerDirection = new THREE.Vector3();
const pointerQuaternion = new THREE.Quaternion();
const pointerMatrix = new THREE.Matrix4();
const portalPoint = new THREE.Vector3();
const portalNormal = new THREE.Vector3();
const basisRight = new THREE.Vector3();
const basisUp = new THREE.Vector3();
const basisMatrix = new THREE.Matrix4();

let portalPlaced = false;

/** semanticLabel이 있으면 그걸 믿는다. 문과 창문도 vertical이라서,
 *  라벨 없이 orientation만 보면 포털이 문짝에 걸릴 수 있다. */
function isWall(plane: XRPlane): boolean {
  if (plane.semanticLabel !== undefined) return plane.semanticLabel === 'wall';
  return plane.orientation === 'vertical';
}

/** 오른손이 가리키는 레이를 읽는다. 못 읽으면 false.
 *
 *  three.js에 renderer.xr.getController(i)가 있지만 i는 입력 소스의 순서일 뿐
 *  손이 아니다. 오른손을 '확실히' 집으려면 handedness를 직접 봐야 한다.
 *  targetRaySpace는 컨트롤러든 맨손이든 똑같이 있다(맨손이면 핀치 레이).
 *  평면을 읽을 때와 같은 frame.getPose 패턴이라 새로 배울 게 없다. */
function readRightPointer(frame: XRFrame, referenceSpace: XRReferenceSpace): boolean {
  for (const inputSource of frame.session.inputSources) {
    if (inputSource.handedness !== 'right') continue;

    const pose = frame.getPose(inputSource.targetRaySpace, referenceSpace);
    if (pose === undefined || pose === null) continue;

    pointerMatrix.fromArray(pose.transform.matrix);
    pointerOrigin.setFromMatrixPosition(pointerMatrix);
    pointerQuaternion.setFromRotationMatrix(pointerMatrix);
    // 타깃 레이는 그 좌표계의 -Z를 향한다. 카메라와 같은 규약이다.
    pointerDirection.set(0, 0, -1).applyQuaternion(pointerQuaternion);

    return true;
  }

  return false;
}

/** 오른손이 없을 때(컨트롤러가 잠들었거나 핸드 트래킹이 꺼졌을 때)의 대비책. */
function readGaze(): void {
  // 중요: XR 세션 중에 머리 포즈를 들고 있는 건 위에서 만든 camera가 아니라
  // renderer.xr.getCamera()가 돌려주는 ArrayCamera다. camera는 three.js가
  // 내부 기준으로만 쓰고, 실제로 그려지는 건 눈마다 하나씩인 하위 카메라다.
  const xrCamera = renderer.xr.getCamera();
  xrCamera.getWorldPosition(pointerOrigin);
  xrCamera.getWorldDirection(pointerDirection); // 월드 기준 -Z
}

// 조준선. 안 보이면 벽의 어디를 맞추는지 알 수 없다.
const pointerRay = new THREE.Line(
  new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0, 0, -1),
  ]),
  new THREE.LineBasicMaterial({ color: 0x66ccff }),
);
pointerRay.visible = false;
scene.add(pointerRay);

/** 벽에 '똑바로' 거는 자세를 만든다. 벽 평면의 로컬 축을 그대로 쓰지 않는
 *  이유는, 로컬 X/Z 중 어느 쪽이 세로인지 스펙이 보장하지 않기 때문이다.
 *  월드 업과 법선으로 직접 기저를 만들면 그 가정이 필요 없다. */
function orientPortal(point: THREE.Vector3, normal: THREE.Vector3): void {
  basisRight.crossVectors(WORLD_UP, normal).normalize();
  basisUp.crossVectors(normal, basisRight).normalize();
  basisMatrix.makeBasis(basisRight, basisUp, normal);

  portal.quaternion.setFromRotationMatrix(basisMatrix);
  // 벽과 완전히 같은 평면에 두면 z-fighting이 난다. 1cm 띄운다.
  portal.position.copy(point).addScaledVector(normal, 0.01);
}

/** 확정 전까지 매 프레임 호출. 가리키는 자리로 포털을 옮겨 둔다. */
function updatePortalPreview(frame: XRFrame, referenceSpace: XRReferenceSpace): void {
  const hasPointer = readRightPointer(frame, referenceSpace);
  if (hasPointer === false) readGaze();

  // 확정 전까지만 도는 코드라 매 프레임 배열을 만들어도 괜찮다.
  const wallMeshes: THREE.Mesh[] = [];
  for (const [plane, mesh] of planeMeshes) {
    if (isWall(plane)) wallMeshes.push(mesh);
  }

  raycaster.set(pointerOrigin, pointerDirection);
  const hit = raycaster.intersectObjects(wallMeshes, false)[0];

  if (hit !== undefined) {
    // 벽 메시의 로컬 +Y가 평면의 법선이다(⑤에서 지오메트리를 X-Z로 눕혔으므로).
    portalNormal.set(0, 1, 0).applyQuaternion(hit.object.quaternion).normalize();
    // 법선이 벽 안쪽을 향할 수도 있다. 보는 사람 쪽으로 뒤집는다.
    if (portalNormal.dot(pointerDirection) > 0) portalNormal.negate();
    portalPoint.copy(hit.point);
  } else {
    // 벽이 없다. 눈앞에 세운다.
    portalNormal.copy(pointerDirection).negate();
    portalNormal.y = 0; // 바닥이나 천장을 보고 있었어도 포털은 수직으로 세운다.
    if (portalNormal.lengthSq() < 0.001) portalNormal.set(0, 0, 1);
    portalNormal.normalize();
    portalPoint.copy(pointerOrigin).addScaledVector(pointerDirection, PORTAL_FALLBACK_DISTANCE);
  }

  orientPortal(portalPoint, portalNormal);

  // 조준선을 손에서 포털까지 늘인다. 선은 로컬 -Z 방향 1m짜리라,
  // 거리만큼 z로 스케일하면 된다.
  pointerRay.visible = hasPointer;
  if (hasPointer) {
    pointerRay.position.copy(pointerOrigin);
    pointerRay.quaternion.copy(pointerQuaternion);
    pointerRay.scale.setScalar(pointerOrigin.distanceTo(portalPoint));
  }
}

/** 트리거를 당겼을 때. 지금 미리보기가 있는 자리에 그대로 확정한다. */
function placePortal(): void {
  if (portalPlaced) return;

  portalPlaced = true;
  pointerRay.visible = false;
  portalSurfaceMaterial.opacity = 0.7;
  portalEdgeMaterial.color.setHex(0xffcc33);

  log(`포털 확정: ${portalPoint.x.toFixed(2)}, ${portalPoint.y.toFixed(2)}, ${portalPoint.z.toFixed(2)}`);
}

function resetPortal(): void {
  portalPlaced = false;
  pointerRay.visible = false;
  portalSurfaceMaterial.opacity = 0.25;
  portalEdgeMaterial.color.setHex(0x66ccff);
}

// ---------------------------------------------------------------------------
// 7) 렌더 루프
//    requestAnimationFrame이 아니라 renderer.setAnimationLoop을 쓴다.
//    XR 세션 중에는 프레임 타이밍의 주인이 브라우저 창이 아니라 XRSession이고,
//    three.js가 세션 유무에 따라 둘을 알아서 갈아끼운다.
// ---------------------------------------------------------------------------
// setAnimationLoop의 콜백은 (시간, XRFrame)을 받는다. frame은 XR 세션 중에만
// 들어오고, 세션 밖에서는 undefined다.
renderer.setAnimationLoop((_time, frame) => {
  if (frame !== undefined) {
    const referenceSpace = renderer.xr.getReferenceSpace();
    if (referenceSpace !== null) {
      updatePlanes(frame, referenceSpace);
      if (portalPlaced === false) updatePortalPreview(frame, referenceSpace);
    }
  }

  renderer.render(scene, camera);
});

// ---------------------------------------------------------------------------
// 8) AR 세션 진입
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

  // 'select'는 컨트롤러 트리거와 핸드 핀치를 모두 포함한다. 세션에 직접 붙이면
  // 어느 손/컨트롤러인지 신경 쓸 필요가 없다. three.js의 renderer.xr.getController(i)
  // 로도 같은 이벤트를 받을 수 있지만, 그건 컨트롤러를 씬에 그릴 때 쓰는 것이다.
  session.addEventListener('select', placePortal);

  log('세션 시작');
  // ①단계의 실제 목적: Quest 3가 뭘 허락했는지 눈으로 확인하는 것.
  log('허용된 기능: ' + (session.enabledFeatures?.join(', ') ?? '(브라우저가 알려주지 않음)'));

  session.addEventListener('end', () => {
    currentSession = null;
    enterButton.textContent = 'AR 시작';
    enterButton.disabled = false;

    // 평면도 포털도 이 세션에 묶인 것이다. 다음 세션에서 다시 찾는다.
    for (const plane of [...planeMeshes.keys()]) disposePlane(plane);
    lastPlaneSummary = '';
    resetPortal();

    log('세션 종료');
  });
}

enterButton.addEventListener('click', () => {
  // 전환 중에는 잠근다. 메타 버튼으로 세션에서 나온 직후 바로 누르면,
  // 'end' 이벤트는 이미 왔는데 런타임은 아직 세션을 정리하는 중이라
  // requestSession이 InvalidStateError로 터진다.
  enterButton.disabled = true;

  if (currentSession === null) {
    startSession()
      .catch((error: unknown) => {
        log('세션 요청 실패: ' + String(error));
      })
      .finally(() => {
        enterButton.disabled = false;
      });
  } else {
    currentSession.end();
  }
});

// ---------------------------------------------------------------------------
// 9) 지원 여부 확인
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
