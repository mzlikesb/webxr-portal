import * as THREE from 'three';
import { makeRoach } from './roach';
import type { Roach } from './roach';
import {
  disablePortalPlane,
  makePortalCrossing,
  setInsidePortalOpacity,
  setPortalPlane,
  setPortalStencilRef,
} from './portal-crossing';
import type { PortalCrossing } from './portal-crossing';
import { makeInstanceBatch } from './instance-batch';
import { makeHandTracker } from './hands';
import { makeDebugPanel } from './debug-panel';
import { fakeHands, setFakeFingertip, updateFakeHands } from './fake-hands';
import { fakeRoomFrame, fakeRoomSpace } from './fake-room';
import { makeRoomShell } from './room-shell';
import type { ShellSurface } from './room-shell';
import {
  linkSurfaces,
  makeWalkSurface,
  orientSurface,
  transferIfCrossed,
} from './walk-surface';
import type { SurfaceEdge, WalkSurface } from './walk-surface';

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

// 재질마다 다른 클리핑 평면을 쓰려면 켜야 한다. 포털 평면을 가로지르는
// 물체를 앞뒤 반쪽으로 나눠 그리는 데 쓴다(portal-crossing.ts).
renderer.localClippingEnabled = true;

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

/**
 * 평면 오버레이를 켜 둘지.
 *
 * 벽을 고르는 동안에는 켜 둬야 어디를 가리키는지 보이고, 포털을 놓으면 꺼야
 * 포털 앞을 가리지 않는다. 그 뒤로는 손바닥 패널에서 다시 켤 수 있다 —
 * 세션 안에서 '지금 뭐가 잡혔는지' 볼 유일한 길이다.
 */
let showPlanes = true;

function applyPlaneVisibility(): void {
  for (const mesh of planeMeshes.values()) mesh.visible = showPlanes;
}

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
  // 나중에 들어오는 평면도 지금 설정을 따른다.
  mesh.visible = showPlanes;
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
const PORTAL_WIDTH = 0.6;
const PORTAL_HEIGHT = 0.95;
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
  // 가린다. 다시 보고 싶으면 손바닥 패널에서 켠다.
  showPlanes = false;
  applyPlaneVisibility();

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
  // 복도 바닥을 구멍 아래턱과 같은 높이로 올린다. 그래야 바퀴가 안쪽 턱을
  // 기어오르지 않고 그냥 걸어 나온다. 상자는 구멍보다 0.3 높으므로 절반만큼
  // 올리면 바닥이 -PORTAL_HEIGHT/2에 맞는다.
  corridor.position.y = 0.15;
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
// 처음엔 0.3 → 0.08이었는데 너무 일렀다. 30cm는 구멍 안을 들여다보려고 몸을
// 기울이는 거리라, 보려고 다가가면 이미 흐려지기 시작했다.
// 실제로 깨지는 구간은 눈 간격(6.4cm) 안쪽이다. 거기 닿기 직전에만 걷는다.
const PORTAL_FADE_FULL_AT = 0.13; // 이보다 멀면 완전히 보인다
const PORTAL_FADE_GONE_AT = 0.045; // 이보다 가까우면 완전히 사라진다

const portalFacing = new THREE.Vector3();
const headToPortal = new THREE.Vector3();

function updatePortalFade(headPosition: THREE.Vector3): void {

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

  // 포털 안에 있는 바퀴도 같이 흐려져야 한다. 안 묶어 두면 복도만 사라지고
  // 바퀴는 불투명하게 남아, 허공에 벌레만 떠 있는 그림이 된다.
  setInsidePortalOpacity(visibility);
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

// portalNormal은 ⑤에서 포털 자세를 잡을 때 이미 선언해 두었다.

// 바퀴가 걸을 수 있는 면들. 지금은 둘이다.
//   복도 바닥 ──(포털 아래턱)── 벽면
// 둘 다 원점을 아래턱 선 위에 두고 로컬 X를 그 선과 나란히 둔다(walk-surface.ts).
const corridorFloor = makeWalkSurface(scene);
const wallFace = makeWalkSurface(scene);
const roomFloor = makeWalkSurface(scene);

// 모서리는 양방향이다. 나올 때 지나온 길을 그대로 되짚어 올라갈 수 있다.
//
// 아래턱: 복도 바닥의 +Z 끝과 벽면의 -Z 끝이 만난다.
// 벽면에서 위로 올라가는 건 구멍 폭 안에서만 된다 — 그 밖은 막힌 벽이다.
linkSurfaces(
  corridorFloor,
  { nx: 0, nz: 1, at: 0 },
  wallFace,
  { nx: 0, nz: -1, at: 0, halfWidth: PORTAL_WIDTH / 2 },
);

// 걸레받이: 벽면의 +Z 끝(= 바닥까지의 낙차)과 방 바닥의 -Z 끝이 만난다.
// 낙차는 포털을 놓은 높이에 따라 달라지므로 layOutSurfaces에서 채운다.
/** '벽면 → 방 바닥' 모서리. 낙차가 정해지면 at을 고친다. */
const [wallToFloor] = linkSurfaces(
  wallFace,
  { nx: 0, nz: 1, at: 1 },
  roomFloor,
  { nx: 0, nz: -1, at: 0 },
);

// 세 면 모두 +Z가 '계속 가는 쪽'이다.
// 복도에서는 구멍 밖, 벽에서는 아래로, 바닥에서는 벽에서 멀어지는 쪽.
corridorFloor.drift = 0;
wallFace.drift = 0;
// 방 바닥에는 목적지가 없다. 여기서부터는 주촉성으로 가장자리를 살피며
// 돌아다닌다 — 나온 뒤의 행동이다. 가장자리를 따라가는 건 여기서만 켠다.
roomFloor.drift = null;
roomFloor.hugEdges = true;

// 돌아다닐 범위. 면마다 모양이 달라서 따로 준다.
// 복도 바닥은 구멍 안쪽으로 좁게, 방 바닥은 넓게.
/** 복도 폭의 절반. 벽에 몸이 반쯤 박혀 보이지 않게 조금 안쪽으로 둔다. */
const CORRIDOR_HALF_X = PORTAL_WIDTH / 2 - 0.05;
corridorFloor.boundHalfX = CORRIDOR_HALF_X;
corridorFloor.boundCenterZ = -0.12;
corridorFloor.boundHalfZ = 0.2;
// 책상 발자국 전체를 품어야 네 변 어디로든 타고 올라갈 수 있다.
// 원일 때는 반지름 0.75로도 가까운 변 하나에만 닿았다 — 축에서 벗어나면
// 금세 짧아지기 때문이다. 사각형은 네 구석까지 그대로 닿는다.
roomFloor.boundHalfX = 0.9;
roomFloor.boundCenterZ = 0.6;
roomFloor.boundHalfZ = 0.9;

// ── 기다렸다 나오기 ──
//
// 바퀴를 처음부터 걸어 나오게 하면, 보는 사람이 포털을 쳐다보고 있든 말든
// 그냥 일어나 버린다. 안쪽 깊은 데서 어슬렁거리다가 사람이 다가왔을 때
// 나오게 하면, 같은 코드로 '우연히 일어난 일'이 '일어나는 순간'이 된다.
//
// 구멍으로 안쪽을 들여다보면 뭔가 움직이는 게 먼저 보이고, 그 다음에 나온다.
const LURK_CENTER_Z = -0.55; // 구멍에서 이만큼 안쪽을 서성인다
// 복도 안쪽 반폭이 PORTAL_WIDTH/2 + 0.1이다. 여덟 마리가 한 원에 몰리지
// 않도록 그 안에서 최대한 넓게 잡는다.
const LURK_RADIUS = 0.35;
/**
 * 등장 조건.
 *
 * 처음에는 '1m 안으로 다가오면'이었는데, 0.6m짜리 포털을 1m 앞에서 들여다볼
 * 일이 없다. 조건이 영영 안 걸려서 바퀴들이 복도 안에서만 맴돌았다.
 *
 * 거리보다 '쳐다보는가'가 맞다. 작품으로도 그쪽이다 — 알아챘을 때 나온다.
 */
const EMERGE_DISTANCE = 2.5;
/** 시선과 포털 방향 사이가 이 각도 안이면 보고 있는 것으로 친다(라디안). */
const EMERGE_VIEW_ANGLE = 0.7; // 약 40°

let hasEmerged = false;

/** 대기 구역 안의 아무 자리에 놓는다. 구역이 사각형이라 그대로 사각형에 뿌린다. */
function scatterInLurk(roach: Roach): void {
  roach.placeOn(
    corridorFloor.node,
    (Math.random() * 2 - 1) * CORRIDOR_HALF_X * 0.8,
    LURK_CENTER_Z + (Math.random() * 2 - 1) * LURK_RADIUS * 0.8,
    Math.random() * Math.PI * 2,
  );
}

function beginLurking(): void {
  hasEmerged = false;
  corridorFloor.boundHalfX = CORRIDOR_HALF_X;
  corridorFloor.boundCenterZ = LURK_CENTER_Z;
  corridorFloor.boundHalfZ = LURK_RADIUS;
  corridorFloor.drift = null; // 목적 없이 서성인다
}

/** 바퀴들을 복도 깊은 곳으로 되돌린다. 세션을 새로 시작할 때마다 부른다. */
function resetRoaches(): void {
  beginLurking();
  for (const unit of units) {
    unit.surface = corridorFloor;
    scatterInLurk(unit.roach);
    applySurface(unit);
  }
}

/**
 * 앞쪽(+Z)으로 나가는 모서리가 어디쯤인지. 경계 조향을 그쪽에서만 풀어 주려고
 * 바퀴에게 알려 준다. 그런 모서리가 없으면 null.
 */
function forwardExitOf(surface: WalkSurface): number | null {
  for (const edge of surface.edges) {
    if (edge.nz > 0.9 && edge.halfWidth > 0) return edge.at;
  }
  return null;
}

/** [임시] 프로브에서 면을 이름으로 보려고 둔 표. 합치기 전에 지운다. */
const SURFACE_NAMES = new Map<WalkSurface, string>();

/** 지금 올라서 있는 면의 설정을 바퀴에게 적용한다. */
function applySurface(unit: RoachUnit): void {
  unit.roach.setExitZ(forwardExitOf(unit.surface));
  unit.roach.setBounds(
    unit.surface.boundHalfX,
    unit.surface.boundCenterZ,
    unit.surface.boundHalfZ,
    unit.surface.boundGapHalfWidth,
  );
  unit.roach.setDrift(unit.surface.drift);
  unit.roach.setHugEdges(unit.surface.hugEdges);
}

function beginEmerging(): void {
  if (hasEmerged) return;
  hasEmerged = true;
  corridorFloor.boundHalfX = CORRIDOR_HALF_X;
  corridorFloor.boundCenterZ = -0.12;
  corridorFloor.boundHalfZ = 0.2;
  corridorFloor.drift = 0; // 구멍 밖으로
  // 면의 설정을 바꿨으니 지금 그 면에 서 있는 바퀴들에게도 알려 줘야 한다.
  for (const unit of units) {
    if (unit.surface === corridorFloor) applySurface(unit);
  }
  log('바퀴가 나오기 시작했다');
}

beginLurking();

// ---------------------------------------------------------------------------
// 책상
//
// 상판 하나와 옆면 넷. 상판은 네 변 어디로든 넘어갈 수 있고, 옆면은 각각
// 상판과 방 바닥을 잇는다. 한쪽으로 올라가 반대쪽으로 내려오면 바닥으로
// 되돌아오는 고리가 되는데, 모서리를 목록으로 바꾼 게 이걸 위해서다.
// ---------------------------------------------------------------------------
const TABLE_HALF_X = 0.62; // 감지된 책상이 1.25 x 0.73이었다
const TABLE_HALF_Z = 0.36;
const TABLE_HEIGHT = 0.72;

const tableTop = makeWalkSurface(scene);
/** +X, -X, +Z, -Z 순서. 상판의 로컬 축 기준이다. */
const TABLE_SIDE_DIRS = [
  { nx: 1, nz: 0 },
  { nx: -1, nz: 0 },
  { nx: 0, nz: 1 },
  { nx: 0, nz: -1 },
];
const tableSides = TABLE_SIDE_DIRS.map(() => makeWalkSurface(scene));

// [임시] 프로브용 이름표. 합치기 전에 지운다.
SURFACE_NAMES.set(corridorFloor, '복도');
SURFACE_NAMES.set(wallFace, '벽면');
SURFACE_NAMES.set(roomFloor, '방바닥');
SURFACE_NAMES.set(tableTop, '상판');
tableSides.forEach((side, i) => SURFACE_NAMES.set(side, `책상옆${i}`));

tableTop.hugEdges = true; // 상판은 머무는 곳이다
// 상판은 원이 아니라 발자국 그대로다. 원으로 두면 네 구석에 못 가고,
// 짧은 쪽 두 변은 원 안쪽 깊숙이 들어가 변이 없는 것처럼 된다.
tableTop.boundHalfX = TABLE_HALF_X;
tableTop.boundHalfZ = TABLE_HALF_Z;

/** 방 바닥에서 각 옆면으로 올라가는 모서리. 자리는 layOutTable에서 채운다. */
const floorToSide = tableSides.map((side, i) => {
  const halfAlong = TABLE_SIDE_DIRS[i].nx !== 0 ? TABLE_HALF_Z : TABLE_HALF_X;

  // 상판 ↔ 옆면은 손으로 적지 않는다. 상판과 옆면은 직각으로 만나는 두 면이고,
  // 방 껍데기가 쓰는 교선 계산이 그걸 그대로 풀어 준다 — 손으로 적으면 같은
  // 모서리가 둘이 된다. 옆면끼리 만나는 책상 모서리도 거기서 공짜로 따라온다.
  side.boundHalfX = halfAlong;
  side.boundCenterZ = TABLE_HEIGHT / 2;
  side.boundHalfZ = TABLE_HEIGHT / 2;

  // 옆면 ↔ 방 바닥: 옆면의 아래 끝. 바닥 쪽 자리는 책상을 놓을 때 정해진다.
  // 바닥에서 올라갈 때는 띠로 잡는다 — 반평면으로 두면 책상 건너편에 있는
  // 바퀴까지 '넘어섰다'로 잡힌다.
  const [, floorEdge] = linkSurfaces(
    side,
    { nx: 0, nz: 1, at: TABLE_HEIGHT, halfWidth: halfAlong },
    roomFloor,
    // 띠는 두지 않는다. 방 바닥에는 책상 발자국만큼의 구멍이 없어서 바퀴가
    // 그 위를 자유롭게 지나다니고, 주촉성 때문에 선에서 한참 떨어진 자리에
    // 머문다. 띠로 잡으려면 늘 '너무 많이 지나간' 상태다.
    // 대신 진행 방향으로 거른다 — 그쪽으로 가고 있을 때만 타고 오른다.
    { nx: 0, nz: 1, at: 0, halfWidth: halfAlong },
  );
  return floorEdge;
});

const tablePoint = new THREE.Vector3();
/** layOutTable이 들어올 때 베껴 두는 책상 중심. 아래 주석 참고. */
const tableCenter = new THREE.Vector3();
const tableDir = new THREE.Vector3();
const tableQuat = new THREE.Quaternion();
/** 바닥 자세용으로 따로 둔다. 하나를 돌려 쓰면 반복문 두 번째부터 책상 자세가
 *  바닥 자세로 덮여서, 옆면들이 엉뚱한 방향을 가리킨다. */
const floorQuat = new THREE.Quaternion();

/**
 * 책상을 놓는다.
 * @param center 상판 중심(월드)
 * @param facing 상판의 로컬 +Z가 향할 방향(월드, 수평)
 */
function layOutTable(center: THREE.Vector3, facing: THREE.Vector3): void {
  // center는 호출하는 쪽의 스크래치 벡터일 수 있다 — 실제로 그랬다. 부르는
  // 쪽이 tablePoint를 그대로 넘겼고, 아래 루프가 그 tablePoint를 고치는 순간
  // center까지 함께 망가졌다. 그래서 첫 옆면만 제자리에 섰고 나머지 셋은
  // y = 0, 즉 방 바닥에 깔렸다. 바닥에서 올라간 바퀴는 옆면의 '윗변'에
  // 도착했는데 그 윗변이 바닥 높이라, 거기서 상판으로 넘어가면 책상에서
  // 3m 떨어진 허공으로 튀었다.
  //
  // 들어올 때 한 번 베끼고, 이후로는 사본만 읽는다.
  tableCenter.copy(center);
  tableTop.node.position.copy(tableCenter);
  orientSurface(tableTop.node, WORLD_UP, facing);
  tableTop.node.updateMatrixWorld();
  tableTop.node.getWorldQuaternion(tableQuat);

  roomFloor.node.updateMatrixWorld();

  tableSides.forEach((side, i) => {
    const dir = TABLE_SIDE_DIRS[i];
    const halfOut = dir.nx !== 0 ? TABLE_HALF_X : TABLE_HALF_Z;

    // 바깥을 향하는 방향(월드)과 그 변의 중점(월드).
    tableDir.set(dir.nx, 0, dir.nz).applyQuaternion(tableQuat).normalize();
    tablePoint.copy(tableCenter).addScaledVector(tableDir, halfOut);

    // 옆면: 등이 바깥을 보고, 로컬 +Z가 아래로 간다. 원점은 윗변 중점.
    side.node.position.copy(tablePoint);
    orientSurface(side.node, tableDir, WORLD_UP.clone().negate());
    side.node.updateMatrixWorld();

    // 바닥 쪽 모서리: 이 옆면의 밑변이 방 바닥 로컬에서 어떤 직선인지 적는다.
    // 법선은 '책상 쪽으로' 향해야 한다 — 그쪽으로 걸어가다 올라타는 것이다.
    tablePoint.y = 0;
    roomFloor.node.worldToLocal(tablePoint);
    tableDir.applyQuaternion(roomFloor.node.getWorldQuaternion(floorQuat).invert());

    const nx = -tableDir.x;
    const nz = -tableDir.z;
    const length = Math.hypot(nx, nz) || 1;
    floorToSide[i].nx = nx / length;
    floorToSide[i].nz = nz / length;
    floorToSide[i].at = tablePoint.x * floorToSide[i].nx + tablePoint.z * floorToSide[i].nz;
    floorToSide[i].alongCenter =
      -tablePoint.x * floorToSide[i].nz + tablePoint.z * floorToSide[i].nx;
  });
}

/** 두 면을 포털 자리에 맞춰 세운다. 포털을 옮기면 다시 부른다. */
function layOutSurfaces(): void {
  portalNormal.set(0, 0, 1).applyQuaternion(portal.quaternion);

  // 아래턱: 구멍의 바닥 선. 두 면이 여기서 만난다.
  // 벽과 겹쳐 z-fighting이 나지 않게 법선 쪽으로 1mm 띄운다.
  const sill = new THREE.Vector3()
    .copy(portal.position)
    .addScaledVector(WORLD_UP, -PORTAL_HEIGHT / 2)
    .addScaledVector(portalNormal, 0.001);

  // 복도 바닥: 수평, 등은 위를 보고, +Z가 구멍 밖을 향한다.
  corridorFloor.node.position.copy(sill);
  orientSurface(corridorFloor.node, WORLD_UP, portalNormal);

  // 벽면: 수직, 등은 방을 보고, +Z가 벽을 타고 아래로 간다.
  // 직진하던 바퀴가 각도를 바꾸지 않고 그대로 벽을 타도록 하는 배치다.
  wallFace.node.position.copy(sill);
  orientSurface(wallFace.node, portalNormal, WORLD_UP.clone().negate());

  // 방 바닥: 수평, +Z가 벽에서 멀어지는 쪽.
  // 원점은 벽이 바닥과 만나는 선 위, 아래턱 바로 밑이다. 벽면과 로컬 X를
  // 공유하므로(둘 다 up × 법선) 모서리를 넘을 때 x가 그대로 보존된다.
  // local-floor 기준 공간이라 진짜 바닥이 y = 0이다.
  roomFloor.node.position.set(sill.x, 0, sill.z);
  roomFloor.node.position.addScaledVector(portalNormal, 0.001);
  orientSurface(roomFloor.node, WORLD_UP, portalNormal);

  // 아래턱에서 바닥까지의 거리. 벽면의 로컬 +Z가 아래를 향하므로 그대로 쓴다.
  // 포털을 아주 낮게 걸면 내려갈 벽이 없다. 그때는 모서리를 닫는다.
  const dropHeight = sill.y;
  wallToFloor.at = dropHeight;
  wallToFloor.halfWidth = dropHeight > 0.05 ? Infinity : 0;
  // 벽면은 포털보다 양옆으로 조금 더 넓다. 바퀴가 구멍 옆 벽으로도 번진다.
  wallFace.boundHalfX = PORTAL_WIDTH / 2 + 0.2;
  wallFace.boundCenterZ = dropHeight / 2;
  wallFace.boundHalfZ = dropHeight / 2;
  // 사각형의 -Z 변이 곧 아래턱 선이다. 그 위는 벽이 아니라 구멍이라, 구멍 폭
  // 안쪽만 열어 둔다 — 거기로는 복도로 되돌아 들어가고, 그 밖은 막힌 벽이다.
  wallFace.boundGapHalfWidth = PORTAL_WIDTH / 2;

  for (const surface of [corridorFloor, wallFace, roomFloor]) {
    surface.node.updateMatrixWorld();
  }

  // 책상은 벽에서 조금 떨어진 자리에 놓는다. 방에서 감지된 'table' 평면에
  // 맞추는 건 다음 단계다 — 지금은 포털 기준으로 둔다.
  tablePoint
    .set(sill.x, TABLE_HEIGHT, sill.z)
    .addScaledVector(portalNormal, TABLE_HALF_Z + 0.45);
  layOutTable(tablePoint, portalNormal);

  // 복도 바닥과 책상이 방금 옮겨 갔다. 방과 만나는 자리도 다시 구한다.
  roomShell.rebuild();
  // 포털이 다른 벽으로 옮겨 갔을 수도 있다.
  linkPortalToWall();
}


// 걸음이 미끄러지는지, 모서리를 어떻게 넘는지 보려면 면에 무늬가 있어야
// 한다. 면마다 하나씩. 임시.
const surfaceGrids = [
  { surface: corridorFloor, size: 0.4, offsetZ: -0.2, stretchX: 1 }, // 아래턱 안쪽
  { surface: wallFace, size: 0.4, offsetZ: 0.2, stretchX: 1 }, // 아래턱 아래쪽
  { surface: roomFloor, size: 1.6, offsetZ: 0.5, stretchX: 1 }, // 벽 바깥쪽
  // 상판은 원점이 가운데. 격자는 정사각형이라 X로 늘려 직사각형을 만든다.
  { surface: tableTop, size: 2 * TABLE_HALF_Z, offsetZ: 0, stretchX: TABLE_HALF_X / TABLE_HALF_Z },
  ...tableSides.map((surface, i) => ({
    surface,
    size: TABLE_HEIGHT,
    offsetZ: TABLE_HEIGHT / 2,
    stretchX: (2 * (TABLE_SIDE_DIRS[i].nx !== 0 ? TABLE_HALF_Z : TABLE_HALF_X)) / TABLE_HEIGHT,
  })),
].map(({ surface, size, offsetZ, stretchX }) => {
  const grid = new THREE.GridHelper(size, Math.round(size * 100), 0x335544, 0x223333);
  // GridHelper는 원점 중심이다. 면의 원점이 모서리 위에 있으면 그대로 두면
  // 격자가 모서리 반대편까지 뻗어 두 면이 겹쳐 보인다. 유효한 쪽으로 민다.
  grid.position.z = offsetZ;
  if (stretchX !== undefined) grid.scale.x = stretchX;
  surface.node.add(grid);
  return grid;
});

// ---------------------------------------------------------------------------
// 방 껍데기
//
// 감지된 벽·바닥·천장을 걸을 수 있는 면으로 바꾼다. 포털이 만드는 면들과 달리
// 좌표를 계산하지 않는다 — 런타임이 주는 평면 자세를 그대로 쓴다.
// 면끼리 모서리로 잇는 건 다음 단계다. 지금은 면이 제자리에 서는지만 본다.
// ---------------------------------------------------------------------------

// 손으로 세운 면들도 방과 이어지도록 함께 넘긴다. 사각형은 활동 범위에서
// 읽지 않고 적어 준다 — 복도 바닥의 범위는 기다리는 동안 안쪽으로 좁아져
// 있어서, 그때 읽으면 아래턱 선이 사각형 밖으로 떨어진다.
//
// 복도 바닥은 넣지 않는다. 벽 평면과 만나는 선이 아래턱인 건 맞지만, 그 선의
// 어느 쪽이 구멍인지는 두 평면만 봐서는 알 수 없다. 자동 생성은 '사각형
// 중심에서 먼 쪽이 바깥'으로 정하는데, 아래턱은 벽 한가운데에 있어서 그
// 규칙이 아래쪽(막힌 벽)을 가리킨다. 실제로 그렇게 나왔고, 나온 바퀴가 그
// 자리에서 곧장 복도로 되돌아가기를 1초에 한 번씩 반복했다.
// 구멍이 아래턱 위에 있다는 건 포털만 아는 사실이라 아래에서 손으로 적는다.
const roomShell = makeRoomShell(scene, [
  { surface: tableTop, halfX: TABLE_HALF_X, centerZ: 0, halfZ: TABLE_HALF_Z },
  ...tableSides.map((side, i) => ({
    surface: side,
    halfX: TABLE_SIDE_DIRS[i].nx !== 0 ? TABLE_HALF_Z : TABLE_HALF_X,
    centerZ: TABLE_HEIGHT / 2,
    halfZ: TABLE_HEIGHT / 2,
  })),
]);

/** 포털이 걸린 진짜 벽. 못 찾았으면 null이고, 그때는 손으로 세운 벽면을 쓴다. */
let portalWall: WalkSurface | null = null;
/** 복도 ↔ 포털 벽 모서리. 포털을 다시 놓으면 걷어내고 새로 만든다. */
let portalLink: { surface: WalkSurface; edge: SurfaceEdge }[] = [];

const wallLocal = new THREE.Vector3();
const portalUp = new THREE.Vector3();

/** 포털이 어느 감지된 벽에 걸려 있는지. 아니면 null. */
function findPortalWall(): ShellSurface | null {
  let best: ShellSurface | null = null;
  let bestGap = 0.08; // 벽에서 이보다 멀면 그 벽에 걸린 게 아니다(m)

  for (const shell of roomShell.surfaces) {
    shell.surface.node.updateMatrixWorld();
    wallLocal.copy(portal.position);
    shell.surface.node.worldToLocal(wallLocal);

    const gap = Math.abs(wallLocal.y);
    if (gap >= bestGap) continue;
    // 평면에는 끝이 있다. 포털이 그 사각형 밖이면 다른 벽이다.
    if (Math.abs(wallLocal.x) > shell.width / 2) continue;
    if (Math.abs(wallLocal.z) > shell.depth / 2) continue;

    bestGap = gap;
    best = shell;
  }
  return best;
}

/**
 * 복도를 포털이 걸린 진짜 벽에 잇고, 손으로 세운 벽면·방 바닥을 뺀다.
 *
 * 벽면과 방 바닥은 같은 자리를 두 번 적은 것이다 — 손으로 세운 벽면은 포털이
 * 걸린 진짜 벽과 겹치고, 방 바닥은 진짜 바닥과 겹친다. 스캔한 적이 없는 방을
 * 위한 대비일 뿐이라, 진짜가 들어오면 물러난다. 남겨 두면 복도에서 나가는
 * 모서리가 둘이 되어 어느 벽으로 나가는지가 목록 순서에 달린다.
 */
function linkPortalToWall(): void {
  const shell = findPortalWall();
  if (shell === null) return;

  // 전에 이어 둔 게 있으면 걷어낸다. 포털을 다시 놓으면 자리가 바뀐다.
  for (const { surface, edge } of portalLink) {
    const at = surface.edges.indexOf(edge);
    if (at >= 0) surface.edges.splice(at, 1);
  }
  portalLink = [];

  portalWall = shell.surface;
  portalWall.node.updateMatrixWorld();

  // 아래턱 위의 한 점과, 거기서 구멍 쪽으로 가는 방향을 벽의 로컬 2D로 옮긴다.
  wallLocal.copy(corridorFloor.node.position);
  portalWall.node.worldToLocal(wallLocal);
  portalUp
    .set(0, 1, 0)
    .applyQuaternion(portal.quaternion)
    .transformDirection(wallInverse.copy(portalWall.node.matrixWorld).invert());

  const length = Math.hypot(portalUp.x, portalUp.z);
  if (length < 1e-6) return;
  const nx = portalUp.x / length;
  const nz = portalUp.z / length;

  const [corridorEdge, wallEdge] = linkSurfaces(
    corridorFloor,
    { nx: 0, nz: 1, at: 0 },
    portalWall,
    {
      nx,
      nz,
      at: wallLocal.x * nx + wallLocal.z * nz,
      alongCenter: -wallLocal.x * nz + wallLocal.z * nx,
      // 구멍 폭만큼만 열려 있다. 그 밖은 막힌 벽이다.
      halfWidth: PORTAL_WIDTH / 2,
      // 아래턱을 위로 넘어서는 것 = 구멍 안으로 들어가는 것이다. 구멍 높이
      // 만큼만 본다 — 띠가 없으면 구멍보다 한참 위를 기어가는 바퀴까지
      // '넘어섰다'로 잡혀 허공에서 복도로 빨려 들어간다.
      band: PORTAL_HEIGHT,
    },
  );
  portalLink = [
    { surface: corridorFloor, edge: corridorEdge },
    { surface: portalWall, edge: wallEdge },
  ];

  const retired = new Set<WalkSurface>([wallFace, roomFloor]);
  for (const surface of [corridorFloor, tableTop, ...tableSides]) {
    surface.edges = surface.edges.filter((edge) => !retired.has(edge.to));
  }
  wallFace.edges = [];
  roomFloor.edges = [];
  log('감지된 벽·바닥으로 간다 — 손으로 세운 벽면·방 바닥은 뺐다');
}

const wallDown = new THREE.Vector3();
const wallInverse = new THREE.Matrix4();

/**
 * 포털이 걸린 벽에 '아래로'라는 목적을 준다.
 *
 * 손으로 세운 벽면은 로컬 +Z가 아래를 향하도록 세워 두고 drift = 0을 줬다.
 * 감지된 벽은 자세를 런타임이 정하므로 그 요령이 통하지 않는다. 월드의 아래
 * 방향을 면 안으로 눕혀서 heading으로 적는다.
 *
 * 이게 없으면 바퀴가 포털에서 나와 3m × 2.4m 벽 위를 목적 없이 떠돈다.
 * 실제로 그랬다 — 여덟 마리가 다 나왔는데 75초 동안 아무도 바닥에 못 닿았다.
 *
 * 매 프레임 다시 구한다. 면이 하나 더 들어오면 법선 판정이 뒤집힐 수 있고,
 * 뒤집히면 로컬 '아래'도 함께 돌아간다.
 *
 * 올라온 바퀴까지 다시 내려보내지는 않는다. 모서리를 넘을 때, 들어온 방향이
 * 그 면의 drift와 반대면 그 바퀴의 목적지는 지워지기 때문이다.
 */
function aimPortalWallDown(): void {
  if (portalWall === null) return;
  portalWall.node.updateMatrixWorld();
  wallInverse.copy(portalWall.node.matrixWorld).invert();
  wallDown.set(0, -1, 0).transformDirection(wallInverse);
  portalWall.drift = Math.atan2(wallDown.x, wallDown.z);
}


/** 껍데기 면에 깔아 둔 격자들. 손바닥 패널에서 껐다 켠다. */
const shellGrids: THREE.GridHelper[] = [];
let showGrids = true;

/** 새로 생긴 껍데기 면에 격자를 깔아 눈으로 확인한다. */
function addShellGrid(shell: ShellSurface): void {
  const size = Math.max(shell.width, shell.depth);
  const grid = new THREE.GridHelper(size, Math.round(size * 10), 0x554433, 0x332222);
  // 격자는 정사각형이다. 사각형 범위에 맞춰 축마다 다르게 줄인다.
  grid.scale.set(shell.width / size, 1, shell.depth / size);
  grid.visible = showGrids;
  shell.surface.node.add(grid);
  shellGrids.push(grid);
}

/**
 * 바퀴 한 마리와 그에 딸린 것들.
 *
 * 한 마리였을 때는 전부 따로 놓인 변수였는데, 여럿이 되니 같이 움직여야 하는
 * 것들이 분명해졌다 — 몸, 포털 경계용 복사본, 지금 올라서 있는 면.
 */
interface RoachUnit {
  roach: Roach;
  crossing: PortalCrossing;
  surface: WalkSurface;
}

/** 몇 마리나 둘지. 드로우콜을 재 보려고 올려 둔 값이기도 하다. */
const ROACH_COUNT = 8;

/** 이 거리 안에 다른 바퀴가 있으면 서로 비킨다(m). 몸길이의 두 배쯤. */
const SEPARATION = 0.08;

const units: RoachUnit[] = [];

// 부품을 조합별로 묶어 그린다. 등록한 메시는 숨겨지고, 모양은 인스턴스가 낸다.
const roachBatch = makeInstanceBatch(scene);

// 복사본을 만들기 전에 알려 줘야 한다. 재질에 한 번만 구워진다.
setPortalStencilRef(PORTAL_STENCIL_REF);

for (let i = 0; i < ROACH_COUNT; i += 1) {
  const roach = makeRoach();

  // 복도 깊은 곳에 흩어 둔다. 줄 세워 놓으면 한눈에 '배치했구나' 싶어진다.
  scatterInLurk(roach);
  roach.setExitZ(forwardExitOf(corridorFloor));
  roach.setBounds(
    corridorFloor.boundHalfX,
    corridorFloor.boundCenterZ,
    corridorFloor.boundHalfZ,
    corridorFloor.boundGapHalfWidth,
  );
  roach.setDrift(corridorFloor.drift);
  roach.setHugEdges(corridorFloor.hugEdges);

  // 바퀴를 두 벌로 나눈다. roach.root는 '바깥 복사본'이 되고, 같은 자세를
  // 따라가는 '안쪽 복사본'이 옆에 생긴다.
  const crossing = makePortalCrossing(roach.root);
  units.push({ roach, crossing, surface: corridorFloor });

  // 두 벌 모두 배칭에 넘긴다. 안쪽은 재질이 달라 따로 묶인다.
  roachBatch.register(roach.root);
  roachBatch.register(crossing.inside);
}

// 데스크톱 미리보기용 가짜 포털. 헤드셋 없이는 이 그림을 아예 볼 수 없다.
// 세션에 들어가면 resetPortal이 지우고 네가 직접 놓게 한다. 임시.
portal.position.set(0, 1.2, -1.3);
portal.quaternion.identity(); // 로컬 +Z가 법선이라 그대로 카메라를 향한다
portalPoint.copy(portal.position);
placePortal();

layOutSurfaces();

// 미리보기 카메라를 포털 아래턱 가까이 가져간다. 바퀴가 4cm라 멀리서는 점이고,
// 모서리를 넘는 순간을 봐야 한다. 세션에서는 이 값이 헤드셋 포즈에 덮인다. 임시.
camera.position.set(1.7, 1.9, 0.7); // 임시: 벽·바닥·책상이 한 화면에 들어오게
camera.lookAt(0, 0.4, -0.85);

// ---------------------------------------------------------------------------
// 손
// ---------------------------------------------------------------------------
const handTracker = makeHandTracker();
scene.add(handTracker.debug);

/** 손 관절 점을 보여 줄지. 데모를 찍을 때는 꺼야 한다. */
let showHandDots = true;

// ---------------------------------------------------------------------------
// 손바닥 디버그 패널
//
// 세션 안에서는 DOM 로그가 안 보인다. 헤드셋을 쓴 채로 '지금 뭐가 잡혔는지'
// 볼 길이 이것뿐이다.
// ---------------------------------------------------------------------------
const debugPanel = makeDebugPanel([
  {
    label: '평면',
    isOn: () => showPlanes,
    press: () => {
      showPlanes = !showPlanes;
      applyPlaneVisibility();
    },
  },
  {
    label: '격자',
    isOn: () => showGrids,
    press: () => {
      showGrids = !showGrids;
      for (const grid of shellGrids) grid.visible = showGrids;
    },
  },
  {
    label: '손',
    isOn: () => showHandDots,
    press: () => {
      showHandDots = !showHandDots;
      handTracker.debug.visible = showHandDots;
    },
  },
]);
scene.add(debugPanel.group);

/** 화면 갱신율. 매 프레임 출렁여서 천천히 따라가게 둔다. */
let fps = 0;

/**
 * 잡힌 평면을 라벨별로 센 것. 'wall 4 · door 2'처럼.
 *
 * 스캔된 방은 라벨이 열 가지씩 나온다. 한 줄에 다 넣으면 글자가 깨알이 되니
 * 넷씩 끊어 여러 줄로 돌려준다.
 */
function planeSummary(): string[] {
  const counts = new Map<string, number>();
  for (const plane of planeMeshes.keys()) {
    const label = plane.semanticLabel ?? plane.orientation ?? '?';
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  if (counts.size === 0) return ['잡힌 평면 없음'];

  const parts = [...counts].map(([label, n]) => `${label} ${n}`);
  const rows: string[] = [];
  for (let i = 0; i < parts.length; i += 4) rows.push(parts.slice(i, i + 4).join(' · '));
  return rows;
}

/** 손가락 끝이 이 거리 안으로 들어오면 건드린 것으로 친다(m). */
const TOUCH_RADIUS = 0.05;
/** 면에서 이만큼 떨어진 손가락은 아직 닿지 않은 것이다(m). */
const TOUCH_HEIGHT = 0.07;

/** 최근 최고 속력이 이보다 빨랐어야 내려친 것으로 친다(m/s). */
const SMASH_SPEED = 0.9;
/** 내려칠 때 손바닥이 면에서 이 거리 안이어야 한다(m). */
const SMASH_HEIGHT = 0.13;
/** 손바닥에 깔리는 범위(m). */
const SMASH_RADIUS = 0.09;

const tipLocal = new THREE.Vector3();
const palmLocal = new THREE.Vector3();
const palmVelocityLocal = new THREE.Vector3();
const surfaceQuat = new THREE.Quaternion();
let handsSeen = false;

/** 손가락 끝에 닿은 바퀴를 놀래킨다. */
function applyTouches(): void {
  for (const hand of handTracker.hands) {
    if (!hand.tracked) continue;

    if (!handsSeen) {
      handsSeen = true;
      log('손 추적 들어옴');
    }

    for (const tip of hand.tips) {
      for (const unit of units) {
        tipLocal.copy(tip);
        unit.surface.node.worldToLocal(tipLocal);

        // 면에서 떠 있는 손은 아직 닿은 게 아니다. 바닥 위 50cm에서 흔드는
        // 손이 그 아래 바퀴를 놀래키면 안 된다.
        if (Math.abs(tipLocal.y) > TOUCH_HEIGHT) continue;

        const dx = tipLocal.x - unit.roach.root.position.x;
        const dz = tipLocal.z - unit.roach.root.position.z;
        if (dx * dx + dz * dz > TOUCH_RADIUS * TOUCH_RADIUS) continue;

        unit.roach.scare(tipLocal.x, tipLocal.z);
      }
    }
  }
}

/**
 * 손바닥으로 내려친 자리의 바퀴를 짜부러뜨린다.
 *
 * '빠르게' + '면 가까이' 두 가지를 같이 본다. 속도만 보면 허공에서 손을 휘둘러도
 * 걸리고, 거리만 보면 천천히 손을 짚어도 죽는다. 면의 법선 방향 속도를 보므로
 * 벽이든 바닥이든 책상이든 같은 코드로 판정된다.
 */
function applySmashes(): void {
  for (const hand of handTracker.hands) {
    if (!hand.tracked) continue;

    // 손바닥 하나가 아니라 손 전체로 친다.
    //
    // 손바닥 중심은 손목과 중수골의 중점이라 손가락 끝보다 한참 뒤에 있다.
    // 사람은 벌레를 손가락 쪽으로 겨냥해 때리므로, 손바닥만 보면 영영 안 맞는다.
    for (const point of [hand.palm, ...hand.tips]) {
      for (const unit of units) {
        if (unit.roach.isSquashed()) continue;

        const node = unit.surface.node;
        palmLocal.copy(point);
        node.worldToLocal(palmLocal);

        const dx = palmLocal.x - unit.roach.root.position.x;
        const dz = palmLocal.z - unit.roach.root.position.z;
        const distance = Math.hypot(dx, dz);

        if (Math.abs(palmLocal.y) > SMASH_HEIGHT) continue;
        if (distance > SMASH_RADIUS) continue;

        // 속도는 방향만 바꾼다 — 위치처럼 원점을 빼면 안 된다.
        palmVelocityLocal
          .copy(hand.palmVelocity)
          .applyQuaternion(node.getWorldQuaternion(surfaceQuat).invert());
        // 지금은 '면 쪽으로 가고 있다'만 본다. 세기는 최근 최고 속력으로 가른다.
        if (palmVelocityLocal.y > 0) continue;
        if (hand.peakSpeed < SMASH_SPEED) continue;

        unit.roach.squash();
        log(`${units.indexOf(unit)}번 짜부러짐`);
      }
    }
  }
}

const viewerPosition = new THREE.Vector3();
/** 가짜 손을 눈앞에 세우는 데 쓴다. 미리보기 전용. */
const viewerQuaternion = new THREE.Quaternion();
/** 위 값을 면 로컬로 옮긴 것. 마리마다 면이 달라 매번 다시 만든다. */
const viewerLocal = new THREE.Vector3();
const viewerForward = new THREE.Vector3();
const toPortal = new THREE.Vector3();

// 데스크톱에서 놀라는 걸 확인하려면 누를 데가 있어야 한다. 미리보기 카메라는
// 가만히 있어서 '다가옴'이 영영 일어나지 않는다. 임시.
renderer.domElement.addEventListener('pointerdown', () => {
  // 미리보기 카메라는 움직이지 않아서 '다가옴'이 일어나지 않는다.
  // 첫 클릭은 바퀴를 불러내고, 그 뒤로는 놀래킨다.
  if (!hasEmerged) beginEmerging();
  else for (const unit of units) unit.roach.scare(viewerPosition.x, viewerPosition.z);
});

/** 걸음새를 눈으로 맞추려고 둔 임시 슬라이더. 바퀴가 스스로 고른 속도에 곱한다. */
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
let costTimer = 0;

renderer.setAnimationLoop((time, frame) => {
  // setAnimationLoop은 밀리초 타임스탬프를 준다. 첫 프레임은 이전 값이 없어
  // dt가 통째로 튀므로 버린다. 상한을 두는 건 탭이 백그라운드로 갔다 오면
  // dt가 몇 초짜리로 들어와서 다리가 순간이동하기 때문이다.
  const dt = lastFrameTime === 0 ? 0 : Math.min((time - lastFrameTime) / 1000, 0.1);
  lastFrameTime = time;

  // 보는 사람의 위치를 바퀴가 서 있는 땅의 좌표로 옮겨 넘긴다. 세션 중에는
  // 머리 포즈가, 밖에서는 미리보기 카메라가 출처다.
  const viewer = frame === undefined ? camera : renderer.xr.getCamera();
  viewer.getWorldPosition(viewerPosition);

  // 방 껍데기를 먼저 갱신한다. 바퀴를 움직이기 전이어야 한다 — 바퀴는 면의
  // matrixWorld를 읽어 자기 자리를 정하고, 그 계산이 렌더보다 먼저 돈다.
  //
  // 법선이 방 안쪽을 보는지 판정할 기준점으로 머리 위치를 넘긴다. 사람은
  // 늘 방 안에 있으므로, 벽이든 바닥이든 천장이든 한 가지 규칙으로 풀린다.
  // 세션 밖에서는 가짜 방을 먹인다. detectedPlanes는 XR에만 와서, 이게 없으면
  // 이 코드는 데스크톱에서 한 줄도 돌지 않는다 — 맞는지 틀렸는지 알 수가 없다.
  // 미리보기 전용 발판이다.
  const shellFrame = frame ?? fakeRoomFrame;
  const shellSpace = frame === undefined ? fakeRoomSpace : renderer.xr.getReferenceSpace();
  if (shellSpace !== null) {
    for (const shell of roomShell.sync(shellFrame, shellSpace, viewerPosition)) {
      addShellGrid(shell);
      // [임시] 넘어간 기록을 읽을 수 있게 이름을 붙여 둔다.
      SURFACE_NAMES.set(shell.surface, `${shell.label}${SURFACE_NAMES.size}`);
      log(
        `껍데기 면 ${shell.label} ${shell.width.toFixed(2)}×${shell.depth.toFixed(2)}m` +
          `${shell.flipped ? ' (법선 뒤집음)' : ''}` +
          ` · 면 ${roomShell.surfaces.length}개 모서리 ${roomShell.edgeCount}개`,
      );
    }
    // 포털이 걸린 벽은 평면이 들어온 뒤에야 알 수 있다. 찾을 때까지 매 프레임
    // 두드린다 — 찾으면 portalWall이 차고, 그 뒤로는 바로 빠져나온다.
    if (portalWall === null) linkPortalToWall();
    aimPortalWallDown();
  }

  // 아직 복도에 있고, 사람이 가까이서 포털 쪽을 보고 있으면 이제 나온다.
  if (!hasEmerged && portalPlaced) {
    toPortal.subVectors(portal.position, viewerPosition);
    const distance = toPortal.length();
    if (distance < EMERGE_DISTANCE && distance > 1e-3) {
      viewer.getWorldDirection(viewerForward);
      const angle = viewerForward.angleTo(toPortal.divideScalar(distance));
      if (angle < EMERGE_VIEW_ANGLE) beginEmerging();
    }
  }

  if (frame !== undefined) {
    const handSpace = renderer.xr.getReferenceSpace();
    if (handSpace !== null) {
      handTracker.update(frame, handSpace, dt);
      applyTouches();
      applySmashes();
    }
  }

  // ── 손바닥 디버그 패널 ──
  //
  // 세션 밖에서는 가짜 손을 먹인다. 손 추적은 XR에만 와서, 이게 없으면 패널
  // 코드가 데스크톱에서 한 줄도 안 돈다 — 맞는지 틀렸는지 알 수가 없다.
  // 가짜 방 평면과 같은 발판이다.
  let panelHands = handTracker.hands;
  if (frame === undefined) {
    viewer.getWorldQuaternion(viewerQuaternion);
    updateFakeHands(viewerPosition, viewerQuaternion);
    panelHands = fakeHands;
  }

  if (dt > 0) fps += (1 / dt - fps) * Math.min(1, dt * 3);
  debugPanel.setLines([
    `${fps.toFixed(0)} fps · 평면 ${planeMeshes.size}개`,
    `껍데기 ${roomShell.surfaces.length}면 · 모서리 ${roomShell.edgeCount}개`,
    ...planeSummary(),
  ]);
  debugPanel.update(panelHands, viewerPosition);

  const speedScale = speedSlider === null ? 1 : Number(speedSlider.value);

  // ── 서로 비키기 ──
  //
  // 같은 면 위에 있는 짝만 본다. 벽에 붙은 놈과 바닥에 있는 놈은 로컬 좌표가
  // 같아도 월드에서는 떨어져 있다. 여덟 마리면 짝이 스물여덟이라 그냥 다 센다.
  for (let i = 0; i < units.length; i += 1) {
    for (let j = i + 1; j < units.length; j += 1) {
      const a = units[i];
      const b = units[j];
      if (a.surface !== b.surface) continue;
      if (a.roach.isSquashed() || b.roach.isSquashed()) continue;

      const dx = a.roach.root.position.x - b.roach.root.position.x;
      const dz = a.roach.root.position.z - b.roach.root.position.z;
      if (dx * dx + dz * dz > SEPARATION * SEPARATION) continue;

      a.roach.avoid(b.roach.root.position.x, b.roach.root.position.z);
      b.roach.avoid(a.roach.root.position.x, a.roach.root.position.z);
    }
  }

  for (const unit of units) {
    // 시점 위치는 마리마다 올라서 있는 면이 달라서 각자 변환해야 한다.
    viewerLocal.copy(viewerPosition);
    unit.surface.node.worldToLocal(viewerLocal);

    unit.roach.update(dt, speedScale, viewerLocal);

    // 짜부러진 놈은 그 자리에 그대로 둔다.
    if (unit.roach.isSquashed()) continue;

    // 모서리를 넘었으면 다음 면으로 옮긴다.
    const next = transferIfCrossed(unit.roach, unit.surface);
    if (next !== unit.surface) {
      // [임시] 어디서 어디로 넘어갔는지. 합치기 전에 지운다.
      log(
        `${units.indexOf(unit)}번 ${SURFACE_NAMES.get(unit.surface)}` +
          ` → ${SURFACE_NAMES.get(next)}`,
      );
      // 포털에서 막 나왔다. 아래턱은 벽 한가운데에 있어서, 모서리를 넘을 때
      // 쓰는 '새 면 안쪽' 기준이 위쪽을 가리킨다 — 그대로 두면 나온 바퀴가
      // 포털 위 벽을 기어오른다. 손으로 세운 벽면은 사각형이 통째로 아래에
      // 있어서 이 문제가 없었다. 여기서는 방향을 못박는다.
      if (unit.surface === corridorFloor && next === portalWall && next.drift !== null) {
        unit.roach.setHeading(next.drift);
        unit.roach.setDrift(next.drift);
      }
      unit.surface = next;
    }
  }

  // 포털 평면을 바퀴 쪽에 알려 주고, 두 복사본의 자세를 맞춘다.
  if (portalPlaced) {
    // 포털을 놓은 자리에 면들을 맞춘다.
    layOutSurfaces();
    for (const grid of surfaceGrids) grid.visible = frame === undefined;

    portalFacing.set(0, 0, 1).applyQuaternion(portal.quaternion);
    setPortalPlane(portal.position, portalFacing);
  } else {
    disablePortalPlane();
  }
  for (const unit of units) unit.crossing.sync();

  // 자세가 다 정해진 뒤에 행렬을 모은다. render보다 먼저여야 한다.
  roachBatch.sync();

  // 평면 오버레이도 가짜 방을 먹인다. 세션 밖에서 안 돌면 '평면' 버튼이
  // 무엇을 켜고 끄는지 데스크톱에서 볼 수가 없다.
  if (shellSpace !== null) updatePlanes(shellFrame, shellSpace);

  if (frame !== undefined) {
    const referenceSpace = renderer.xr.getReferenceSpace();
    if (referenceSpace !== null && portalPlaced === false) {
      updatePortalPreview(frame, referenceSpace);
    }
  }

  // 근접 페이드는 세션 밖에서도 돈다. 전에는 XR 안에서만 돌아서 데스크톱에서는
  // 한 번도 눈으로 볼 수 없었고, 그래서 잘못된 줄도 몰랐다. 머리 위치만
  // 있으면 되는 계산이라 미리보기 카메라로도 똑같이 돈다.
  if (portalPlaced) updatePortalFade(viewerPosition);

  renderer.render(scene, camera);

  // 렌더 비용을 눈으로 보려고 가끔 찍는다. 세션 안에서는 2D UI가 안 보이므로
  // 콘솔로도 나가야 의미가 있다(log가 양쪽에 쓴다).
  costTimer += dt;
  if (costTimer > 3) {
    costTimer = 0;
    const info = renderer.info.render;
    log(
      `바퀴 ${units.length}마리 · 드로우콜 ${info.calls} · 삼각형 ${info.triangles}` +
        ` · 묶음 ${roachBatch.poolCount()}`,
    );
  }
});

// [임시] 미리보기에서 바퀴가 범위 안에 있는지 콘솔로 확인하려고 둔 창구.
// 합치기 전에 지운다.
Object.assign(window, {
  // [임시] 손바닥 패널의 버튼을 눌러 보는 창구. 미리보기에는 진짜 손가락이
  // 없어서, 패널 로컬 좌표(미터)를 받아 가짜 검지를 거기 갖다 댄다.
  poke: (index = 0) => {
    const point = debugPanel.buttonPoint(index, new THREE.Vector3());
    debugPanel.group.localToWorld(point);
    setFakeFingertip(point.x, point.y, point.z);
    return { 평면: showPlanes, 격자: showGrids, 손: showHandDots };
  },
  unpoke: () => {
    setFakeFingertip(0, -99, 0);
    return { 평면: showPlanes, 격자: showGrids, 손: showHandDots };
  },
  panel: () => ({
    보임: debugPanel.group.visible,
    자리: debugPanel.group.position.toArray().map((c) => +c.toFixed(2)),
  }),
  // [임시] 껍데기 면들의 자리와 법선. 전부 방 안쪽을 봐야 한다.
  shell: () =>
    roomShell.surfaces.map((s) => {
      const p = s.surface.node.getWorldPosition(new THREE.Vector3());
      const n = new THREE.Vector3(0, 1, 0).applyQuaternion(
        s.surface.node.getWorldQuaternion(new THREE.Quaternion()),
      );
      const r = (v: THREE.Vector3) =>
        [v.x, v.y, v.z].map((c) => +c.toFixed(2)).join(',');
      return {
        면: s.label,
        원점: r(p),
        법선: r(n),
        반폭: +s.surface.boundHalfX.toFixed(2),
        반깊이: +s.surface.boundHalfZ.toFixed(2),
        뒤집음: s.flipped,
      };
    }),
  // [임시] 바퀴 하나를 껍데기 면 위에 올려놓는다. 모서리를 실제로 넘는지
  // 보려고 둔 창구다 — 껍데기는 아직 손으로 세운 면들과 이어져 있지 않아서
  // 걸어서 갈 길이 없다.
  drop: (index = 0, which = 0, x = 0, z = 0, heading = Math.random() * Math.PI * 2) => {
    const shell = roomShell.surfaces[index];
    const unit = units[which];
    if (shell === undefined || unit === undefined) return '그런 면/바퀴 없음';
    unit.surface = shell.surface;
    unit.roach.placeOn(shell.surface.node, x, z, heading);
    applySurface(unit);
    return SURFACE_NAMES.get(shell.surface);
  },
  // [임시] 껍데기 면들이 서로 어떻게 이어졌는지. 상자 방이면 벽-바닥 넷,
  // 벽-천장 넷, 벽-벽 넷 = 열두 쌍이 나와야 한다.
  edges: () =>
    roomShell.surfaces.flatMap((s) =>
      s.surface.edges.map((e) => ({
        면: SURFACE_NAMES.get(s.surface) ?? '?',
        이웃: SURFACE_NAMES.get(e.to) ?? '?',
        법선: `${e.nx.toFixed(2)},${e.nz.toFixed(2)}`,
        거리: +e.at.toFixed(3),
        // nx는 정확히 0이 아니라 1e-17 같은 값으로 나온다. !== 0으로 가르면
        // 수평 모서리에서 엉뚱한 축의 범위를 읽는다.
        범위: +(Math.abs(e.nx) > 0.5 ? s.surface.boundHalfX : s.surface.boundHalfZ).toFixed(3),
        반폭: +e.halfWidth.toFixed(2),
        중심: +e.alongCenter.toFixed(2),
      })),
    ),
  // [임시] 책상 네 옆면의 원점 높이. 전부 책상 높이여야 한다.
  sides: () =>
    tableSides.map((side) => +side.node.getWorldPosition(new THREE.Vector3()).y.toFixed(3)),
  probe: () =>
    units.map((unit) => {
      const p = unit.roach.root.position;
      const s = unit.surface;
      return {
        면: SURFACE_NAMES.get(s) ?? '?',
        x: +p.x.toFixed(3),
        z: +p.z.toFixed(3),
        여유X: +(s.boundHalfX - Math.abs(p.x)).toFixed(3),
        여유Z: +(s.boundHalfZ - Math.abs(p.z - s.boundCenterZ)).toFixed(3),
      };
    }),
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
  // hand-tracking: 손가락 끝으로 건드리거나 손바닥으로 내려치는 데 쓴다.
  // 관절 위치는 frame.getJointPose로 읽는다.
  optionalFeatures: ['plane-detection', 'anchors', 'hit-test', 'hand-tracking'],
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

  // 미리보기용으로 놓아 둔 가짜 포털을 지우고, 이 세션에서 다시 고르게 한다.
  resetPortal();
  // 바퀴도 복도 안으로 되돌린다. 세션마다 처음부터 시작해야 한다.
  resetRoaches();

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
