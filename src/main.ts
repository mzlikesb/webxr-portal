import * as THREE from 'three';
import { makeRoach } from './roach';

// ---------------------------------------------------------------------------
// 1) 화면 밖으로 상태를 내보내는 두 경로
//    AR 세션에 들어가면 2D DOM은 보이지 않는다. dom-overlay를 요청하지 않으므로
//    세션 중 화면에 있는 건 three.js가 그리는 것뿐이다. 그래서 로그를 양쪽에
//    남긴다 — DOM은 세션에서 나온 뒤에 읽고, console은 chrome://inspect로 붙은
//    DevTools에서 세션 중에도 실시간으로 읽는다.
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
// 4) 평면 감지
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
  const isVertical = plane.orientation === 'vertical';

  const material = new THREE.MeshBasicMaterial({
    color: isVertical ? 0x33ff88 : 0x3366ff,
    transparent: true,
    opacity: 0.25,
    // 평면은 양쪽에서 다 보여야 한다. 뒤에서 보면 사라지면 곤란하다.
    side: THREE.DoubleSide,
    // 반투명 오버레이가 깊이 버퍼를 오염시켜 뒤의 물체를 가리지 않게.
    depthWrite: false,
  });

  const mesh = new THREE.Mesh(buildPlaneGeometry(plane), material);
  // 포털이 확정된 뒤에 새로 들어오는 평면도 숨겨 둔다.
  mesh.visible = portalPlaced === false;
  return mesh;
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
    // three.js는 보통 render() 때 행렬을 갱신한다. 하지만 아래 ⑤의 레이캐스트가
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
// 5) 포털 자리 잡기
//
//    시선 레이를 쏴서 ④의 벽 메시와 교차시키고, 거기에 포털 미리보기를 붙여
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
const portalEdgeMaterial = new THREE.LineBasicMaterial({
  color: 0x66ccff,
  transparent: true,
});

const portal = new THREE.Group();
scene.add(portal);

// PlaneGeometry는 X-Y에 서서 +Z를 향한다. orientPortal이 이 그룹의 로컬 +Z를
// 벽의 법선에 맞추므로, 지오메트리를 따로 돌릴 필요가 없다.
const portalShape = new THREE.PlaneGeometry(PORTAL_WIDTH, PORTAL_HEIGHT);

/** 확정 전에 보여 주는 반투명 사각형. 확정되면 숨기고 진짜 포털로 바꾼다. */
const portalPreview = new THREE.Mesh(portalShape, portalSurfaceMaterial);
portal.add(portalPreview);

/** 테두리. 포털이 뚫린 뒤에도 남아서 '액자'가 된다. */
portal.add(new THREE.LineSegments(new THREE.EdgesGeometry(portalShape), portalEdgeMaterial));

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
    // 벽 메시의 로컬 +Y가 평면의 법선이다(④에서 지오메트리를 X-Z로 눕혔으므로).
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

  // 미리보기를 끄고 진짜 포털을 켠다.
  portalPreview.visible = false;
  portalMask.visible = true;
  portalWorld.visible = true;
  portalEdgeMaterial.color.setHex(0xffcc33);

  // 평면 시각화는 디버그용이었다. 켜 둔 채로 두면 벽 오버레이가 포털 앞을
  // 가린다.
  for (const mesh of planeMeshes.values()) mesh.visible = false;

  log(`포털 확정: ${portalPoint.x.toFixed(2)}, ${portalPoint.y.toFixed(2)}, ${portalPoint.z.toFixed(2)}`);
}

function resetPortal(): void {
  portalPlaced = false;
  pointerRay.visible = false;
  portalPreview.visible = true;
  portalMask.visible = false;
  portalWorld.visible = false;
  portalEdgeMaterial.color.setHex(0x66ccff);
  // 페이드 중에 세션이 끝났을 수 있다. 다음 세션은 멀쩡한 상태로 시작한다.
  for (const entry of portalFadeMaterials) entry.material.opacity = entry.baseOpacity;
}

// ---------------------------------------------------------------------------
// 6) 포털 너머 공간 (스텐실)
//
//    원리는 간단하다. 두 번에 나눠 그린다.
//      1. 포털 사각형을 '색도 깊이도 쓰지 않고' 그린다. 스텐실 버퍼에 1만 찍힌다.
//      2. 너머 공간을 '스텐실이 1인 픽셀에만' 그린다.
//    너머 공간의 물체들은 실제로 벽 뒤 좌표에 있다. 가려 주는 물체가 없으니
//    그냥 그리면 벽을 뚫고 둥둥 떠 보이는데, 2번의 스텐실 테스트가 포털 구멍
//    밖의 픽셀을 전부 버려서 '구멍으로만 보이는' 상태를 만든다.
//
//    AR이라 유리한 점이 하나 있다. 포털 밖은 우리가 아무것도 안 그리므로
//    투명하게 남고, 거기에 패스스루가 합성된다. 즉 '벽을 가리는 가짜 벽'을
//    그릴 필요가 없다 — VR에서 같은 기법을 쓸 때 필요한 단계가 통째로 빠진다.
//
//    이 기법이 성립하려면 스텐실 버퍼가 있어야 한다. ①에서 WebGLRenderer에
//    stencil: true를 준 것이 XRWebGLLayer/XRProjectionLayer까지 전달돼
//    DEPTH24_STENCIL8로 잡힌다.
// ---------------------------------------------------------------------------
const PORTAL_STENCIL_REF = 1;
const PORTAL_DEPTH = 9; // 너머 공간의 깊이(m)

/** 1단계: 스텐실에 표시만 하는 사각형. */
const portalMask = new THREE.Mesh(
  portalShape,
  new THREE.MeshBasicMaterial({
    colorWrite: false, // 색을 쓰지 않는다 — 화면에는 아무것도 안 나온다
    depthWrite: false, // 깊이도 쓰지 않는다 — 너머 공간을 가리면 안 되니까
    stencilWrite: true,
    stencilRef: PORTAL_STENCIL_REF,
    stencilFunc: THREE.AlwaysStencilFunc, // 깊이 테스트만 통과하면 무조건
    stencilZPass: THREE.ReplaceStencilOp, // 스텐실 값을 ref로 덮어쓴다
  }),
);
// 마스크는 반드시 '모든 것보다 먼저' 그려져야 한다.
//
// three.js는 불투명 물체를 renderOrder로 먼저 정렬하지만, 값이 같으면
// material.id 순 — 즉 재질을 만든 순서로 그린다. 기본값 0짜리 오브젝트를
// 하나만 추가해도 마스크와 순서가 코드 작성 순서에 좌우된다.
//
// 그게 위험한 이유: 포털보다 앞에 있으면서 깊이를 쓰는 물체가 마스크보다
// 먼저 그려지면, 마스크가 그 픽셀에서 깊이 테스트에 떨어져 스텐실을 못 찍는다.
// 포털 일부가 뜯겨 나간 것처럼 보이고, 원인을 찾기가 아주 어렵다.
// 음수를 줘서 순서를 못 넘보게 한다.
portalMask.renderOrder = -1;
portalMask.visible = false;
portal.add(portalMask);

/** 2단계: 너머 공간. portal의 자식이라 포털이 놓인 자세를 그대로 따라간다.
 *  로컬 -Z가 벽 안쪽이므로, 내용물을 z<0에 두면 '벽 너머'가 된다. */
const portalWorld = new THREE.Group();
portalWorld.visible = false;
portal.add(portalWorld);

/** 재질에 '스텐실이 ref와 같은 픽셀에만 그려라'를 건다. */
/** 가까이 갔을 때 같이 흐려질 재질들.
 *
 *  원래 투명도를 같이 들고 다닌다. 리브는 거리별로 서로 다른 opacity를 갖는데,
 *  페이드가 그 값을 덮어쓰면 깊이 단서가 사라지기 때문이다. 페이드는 덮어쓰는
 *  게 아니라 원래 값에 곱한다. */
const portalFadeMaterials: { material: THREE.Material; baseOpacity: number }[] = [];

function registerFadeMaterial(material: THREE.Material): void {
  portalFadeMaterials.push({ material, baseOpacity: material.opacity });
}

registerFadeMaterial(portalEdgeMaterial);

function clipToPortal(object: THREE.Mesh | THREE.LineSegments): void {
  const material = object.material as THREE.Material;
  material.stencilWrite = true;
  material.stencilRef = PORTAL_STENCIL_REF;
  material.stencilFunc = THREE.EqualStencilFunc;
  object.renderOrder = 1; // 마스크보다 나중
}

{
  // 복도. BackSide라서 안쪽 면만 그려진다 — 상자 안에 들어와 있는 셈이다.
  // 포털 구멍보다 살짝 크게 만들어서, 비스듬히 보면 측벽이 원근으로 모여
  // 깊이가 읽히게 한다.
  const corridor = new THREE.Mesh(
    new THREE.BoxGeometry(PORTAL_WIDTH + 0.2, PORTAL_HEIGHT + 0.3, PORTAL_DEPTH),
    new THREE.MeshStandardMaterial({
      color: 0x2a3b4d,
      roughness: 0.95,
      side: THREE.BackSide,
      // 페이드를 위해 처음부터 transparent로 둔다. 런타임에 이 값을 바꾸면
      // 셰이더가 다시 컴파일돼서 그 프레임이 튄다.
      transparent: true,
    }),
  );
  registerFadeMaterial(corridor.material as THREE.Material);
  corridor.position.z = -PORTAL_DEPTH / 2;
  clipToPortal(corridor);
  portalWorld.add(corridor);

  // 일정 간격의 테두리. 같은 크기의 사각형이 작아지며 멀어지는 게
  // 사람 눈에 가장 잘 먹는 깊이 단서다.
  const ribShape = new THREE.PlaneGeometry(PORTAL_WIDTH + 0.18, PORTAL_HEIGHT + 0.28);
  const ribEdges = new THREE.EdgesGeometry(ribShape);

  for (let i = 1; i <= 5; i += 1) {
    const rib = new THREE.LineSegments(
      ribEdges,
      new THREE.LineBasicMaterial({
        color: 0x88ccff,
        transparent: true,
        // 멀수록 흐리게. 거리감을 한 번 더 준다.
        opacity: 0.9 - i * 0.15,
      }),
    );
    rib.position.z = -i * 1.4;
    clipToPortal(rib);
    portalWorld.add(rib);
    registerFadeMaterial(rib.material as THREE.Material);
  }

  // 너머 공간은 자기 조명을 가진다. 거리에 따라 꺼지는 PointLight가
  // 복도 끝을 어둠으로 만들어 준다.
  const lamp = new THREE.PointLight(0x99ddff, 6, PORTAL_DEPTH);
  lamp.position.z = -1.2;
  portalWorld.add(lamp);

  // 아주 약한 환경광. 이게 없으면 램프가 닿지 않는 면이 완전히 검게 죽어서
  // 형태가 안 읽힌다. three.js의 조명은 부모와 무관하게 씬 전체에 작용하지만,
  // 지금 조명을 받는 재질은 복도뿐이라 여기 두는 게 읽기 좋다.
  portalWorld.add(new THREE.AmbientLight(0x335577, 1.5));
}

// 포털 평면에 얼굴을 들이밀면 두 가지가 깨진다. 카메라의 near(1cm)가 마스크
// 사각형을 잘라서 포털이 가장자리부터 뜯겨 나가고, 평면을 넘는 순간 마스크가
// 백페이스 컬링으로 사라진다. 더 나쁜 건 그 사이 구간인데, 두 눈 간격이 6.4cm라
// 한 눈은 포털을 보고 다른 눈은 못 보는 상태가 반드시 생긴다. 보는 사람이
// 멀미하는 종류의 깨짐이다.
//
// 그 구간에 도달하기 전에 포털을 흐려서 없앤다. 통과를 지원하려면 더 큰 작업이
// 필요한데(⑥에서 다룬 기법들), 이 작품의 범위에서는 이걸로 충분하다.
const PORTAL_FADE_FULL_AT = 0.3; // 이보다 멀면 완전히 보인다
const PORTAL_FADE_GONE_AT = 0.08; // 이보다 가까우면 완전히 사라진다

const headPosition = new THREE.Vector3();
const portalFacing = new THREE.Vector3();
const headToPortal = new THREE.Vector3();

function updatePortalFade(): void {
  renderer.xr.getCamera().getWorldPosition(headPosition);

  // 포털 그룹의 로컬 +Z가 법선이다(orientPortal이 그렇게 맞춰 놨다).
  portalFacing.set(0, 0, 1).applyQuaternion(portal.quaternion);
  // 평면까지의 '부호 있는' 거리. 뒤로 넘어가면 음수가 되므로,
  // 평면을 넘은 경우도 같은 식으로 처리된다.
  const distance = headToPortal.subVectors(headPosition, portal.position).dot(portalFacing);

  const visibility = THREE.MathUtils.smoothstep(
    distance,
    PORTAL_FADE_GONE_AT,
    PORTAL_FADE_FULL_AT,
  );

  // 완전히 투명해지면 아예 그리지 않는다. 스텐실까지 멈춰야 깨끗하다.
  portalMask.visible = visibility > 0;
  portalWorld.visible = visibility > 0;

  for (const entry of portalFadeMaterials) {
    entry.material.opacity = entry.baseOpacity * visibility;
  }
}

// ---------------------------------------------------------------------------
// 7) 바퀴벌레 (작업 중)
//
//    지금은 걸음새만 맞추는 단계라 2D 미리보기 카메라 앞에 임시로 세워 둔다.
//    포털 안에 둘지 진짜 방 바닥에 둘지는 아직 안 정했다.
// ---------------------------------------------------------------------------
// ④에서 씬 조명을 포털 안으로 옮겼다. 포털 바깥에 조명을 받는 물체가
// 바퀴벌레 하나 생겼으므로 다시 들인다. AR에서는 실제 방의 조명 정보가
// 오지 않으므로(Quest 브라우저에 light estimation이 없다) 방 조명을 가정한다.
scene.add(new THREE.HemisphereLight(0xffffff, 0x404050, 1.6));
const roachSun = new THREE.DirectionalLight(0xffffff, 2);
roachSun.position.set(0.5, 1, 0.4);
scene.add(roachSun);

const roach = makeRoach();
roach.root.position.set(0, 1.26, -0.13); // 임시 — 미리보기 카메라 코앞(13cm)
scene.add(roach.root);

/** 걸음새를 눈으로 맞추려고 둔 임시 슬라이더. 0이면 제자리, 1이면 전력 질주. */
const speedSlider = document.querySelector('#speed') as HTMLInputElement | null;

// ---------------------------------------------------------------------------
// 8) 렌더 루프
//    requestAnimationFrame이 아니라 renderer.setAnimationLoop을 쓴다.
//    XR 세션 중에는 프레임 타이밍의 주인이 브라우저 창이 아니라 XRSession이고,
//    three.js가 세션 유무에 따라 둘을 알아서 갈아끼운다.
// ---------------------------------------------------------------------------
// setAnimationLoop의 콜백은 (시간, XRFrame)을 받는다. frame은 XR 세션 중에만
// 들어오고, 세션 밖에서는 undefined다.
let lastFrameTime = 0;

renderer.setAnimationLoop((time, frame) => {
  // setAnimationLoop은 밀리초 타임스탬프를 준다. 첫 프레임은 이전 값이 없어
  // dt가 통째로 튀므로 버린다. 상한을 두는 건 탭이 백그라운드로 갔다 오면
  // dt가 몇 초짜리로 들어와서 다리가 순간이동하기 때문이다.
  const dt = lastFrameTime === 0 ? 0 : Math.min((time - lastFrameTime) / 1000, 0.1);
  lastFrameTime = time;

  roach.pose(speedSlider === null ? 0 : Number(speedSlider.value), dt);

  if (frame !== undefined) {
    const referenceSpace = renderer.xr.getReferenceSpace();
    if (referenceSpace !== null) {
      updatePlanes(frame, referenceSpace);
      if (portalPlaced === false) {
        updatePortalPreview(frame, referenceSpace);
      } else {
        updatePortalFade();
      }
    }
  }

  renderer.render(scene, camera);
});

// ---------------------------------------------------------------------------
// 9) AR 세션 진입
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
// 10) 지원 여부 확인
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
