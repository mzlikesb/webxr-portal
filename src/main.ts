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
import { makeWalkSurface, orientSurface, transferIfCrossed } from './walk-surface';
import type { WalkSurface } from './walk-surface';

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
corridorFloor.next = wallFace;
corridorFloor.exitZ = 0; // 아래턱을 넘으면 벽면으로
wallFace.prev = corridorFloor;
// 벽면에서 아래턱 위로 올라가는 건 구멍 폭 안에서만 된다. 그 밖은 벽이다.
wallFace.backHalfWidth = PORTAL_WIDTH / 2;

wallFace.next = roomFloor; // 벽을 다 내려오면 방 바닥으로 (높이는 아래에서)
roomFloor.prev = wallFace;
// 벽은 좌우로 이어지므로 어디서든 타고 오를 수 있다.
roomFloor.backHalfWidth = 2;

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
corridorFloor.boundCenterZ = -0.12;
corridorFloor.boundRadius = 0.2;
roomFloor.boundCenterZ = 0.25;
roomFloor.boundRadius = 0.4;

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

/** 대기 구역 안의 아무 자리에 놓는다. 원 안에 고르게 퍼지도록 반지름에 √를 쓴다. */
function scatterInLurk(roach: Roach): void {
  const angle = Math.random() * Math.PI * 2;
  const radius = Math.sqrt(Math.random()) * LURK_RADIUS * 0.8;
  roach.placeOn(
    corridorFloor.node,
    Math.cos(angle) * radius,
    LURK_CENTER_Z + Math.sin(angle) * radius,
    Math.random() * Math.PI * 2,
  );
}

function beginLurking(): void {
  hasEmerged = false;
  corridorFloor.boundCenterZ = LURK_CENTER_Z;
  corridorFloor.boundRadius = LURK_RADIUS;
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

/** 지금 올라서 있는 면의 설정을 바퀴에게 적용한다. */
function applySurface(unit: RoachUnit): void {
  unit.roach.setExitZ(unit.surface.exitZ);
  unit.roach.setBounds(unit.surface.boundCenterZ, unit.surface.boundRadius);
  unit.roach.setDrift(unit.surface.drift);
  unit.roach.setBackLimit(unit.surface.backLimitZ, unit.surface.backHalfWidth);
  unit.roach.setHugEdges(unit.surface.hugEdges);
}

function beginEmerging(): void {
  if (hasEmerged) return;
  hasEmerged = true;
  corridorFloor.boundCenterZ = -0.12;
  corridorFloor.boundRadius = 0.2;
  corridorFloor.drift = 0; // 구멍 밖으로
  // 면의 설정을 바꿨으니 지금 그 면에 서 있는 바퀴들에게도 알려 줘야 한다.
  for (const unit of units) {
    if (unit.surface === corridorFloor) applySurface(unit);
  }
  log('바퀴가 나오기 시작했다');
}

beginLurking();

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
  // 포털을 아주 낮게 걸면 내려갈 벽이 없다. 그때는 출구를 없앤다.
  const dropHeight = sill.y;
  wallFace.exitZ = dropHeight > 0.05 ? dropHeight : null;
  wallFace.boundCenterZ = dropHeight / 2;
  wallFace.boundRadius = dropHeight / 2 + 0.12;
  // 아래턱 위는 벽이 아니라 구멍이다. 구멍 폭 밖에서 넘어가면 허공을 걷게 되니
  // 선으로 막고, 폭 안쪽은 열어 둔다 — 거기로는 복도로 되돌아 들어간다.
  wallFace.backLimitZ = 0;

  for (const surface of [corridorFloor, wallFace, roomFloor]) {
    surface.node.updateMatrixWorld();
  }
}


// 걸음이 미끄러지는지, 모서리를 어떻게 넘는지 보려면 면에 무늬가 있어야
// 한다. 면마다 하나씩. 임시.
const surfaceGrids = [
  { surface: corridorFloor, side: -1 }, // 복도 바닥은 아래턱 안쪽(-Z)만 유효
  { surface: wallFace, side: 1 }, // 벽면은 아래턱 아래쪽(+Z)만 유효
  { surface: roomFloor, side: 1 }, // 방 바닥은 벽 바깥쪽(+Z)만 유효
].map(({ surface, side }) => {
  const grid = new THREE.GridHelper(0.4, 40, 0x335544, 0x223333);
  // GridHelper는 원점 중심이다. 면의 원점은 모서리 위에 있으므로 그대로 두면
  // 격자가 모서리 반대편까지 뻗어 두 면이 겹쳐 보인다. 유효한 쪽으로 민다.
  grid.position.z = side * 0.2;
  surface.node.add(grid);
  return grid;
});

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
  roach.setExitZ(corridorFloor.exitZ);
  roach.setBounds(corridorFloor.boundCenterZ, corridorFloor.boundRadius);
  roach.setDrift(corridorFloor.drift);
  roach.setBackLimit(corridorFloor.backLimitZ, corridorFloor.backHalfWidth);
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
camera.position.set(0, 1.15, -0.35);
camera.lookAt(0, 0.95, -1.3); // 포털을 정면으로 — 시선 조건도 같이 보려고

const viewerPosition = new THREE.Vector3();
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

    // 모서리를 넘었으면 다음 면으로 옮긴다.
    const next = transferIfCrossed(unit.roach, unit.surface);
    if (next !== unit.surface) {
      const name = next === wallFace ? '벽면' : next === roomFloor ? '방 바닥' : '복도 바닥';
      log(`${units.indexOf(unit)}번 → ${name}`);
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

  if (frame !== undefined) {
    const referenceSpace = renderer.xr.getReferenceSpace();
    if (referenceSpace !== null) {
      updatePlanes(frame, referenceSpace);
      if (portalPlaced === false) updatePortalPreview(frame, referenceSpace);
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
