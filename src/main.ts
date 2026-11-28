import * as THREE from 'three';
import { makeRoach, ROACH_LENGTH } from './roach';
import type { Roach } from './roach';
import {
  disablePipePlane,
  makePipeCrossing,
  pipeStencilRef,
  preparePipes,
  setPipeInsideOpacity,
  setPipePlane,
} from './portal-crossing';
import type { PipeCrossing } from './portal-crossing';
import { makeInstanceBatch } from './instance-batch';
import { makeHandTracker } from './hands';
import type { TrackedHand } from './hands';
import { makeDebugPanel } from './debug-panel';
import {
  clearFakeHand,
  fakeHands,
  setFakeFingertip,
  setFakeHand,
  updateFakeHands,
} from './fake-hands';
import { blinkFakeRoom, fakeRoomFrame, fakeRoomSpace } from './fake-room';
import { boundingRect, makeRoomShell } from './room-shell';
import type { JoinRect, ShellSurface } from './room-shell';
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

/**
 * 세션 안에서 터진 예외를 나중에 읽을 수 있게 남긴다.
 *
 * 렌더 루프에서 예외가 나면 그 프레임의 renderer.render까지 못 간다. AR에서는
 * 그게 '패스스루만 보이고 아무것도 안 그려짐'이고, 매 프레임 반복되니 영영
 * 그렇다. 그런데 세션 안에서는 콘솔도 DOM도 볼 수가 없다 — USB로 붙지 않는 한
 * 무엇이 터졌는지 알 길이 없다. 세션에서 나온 뒤 읽히도록 DOM에 적어 둔다.
 *
 * 몇 개만 적는다. 매 프레임 터지면 쌓이는 문자열이 그 자체로 짐이 된다.
 */
let errorsLogged = 0;
window.addEventListener('error', (event) => {
  if (errorsLogged >= 3) return;
  errorsLogged += 1;
  const where = `${event.filename ?? '?'}:${event.lineno ?? 0}`;
  statusElement.textContent += `[터짐] ${event.message} @ ${where}\n`;
});

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

/**
 * 평면이 마지막으로 목록에 있던 시각.
 *
 * 런타임이 detectedPlanes를 한 프레임 비우는 일이 있다. 그때마다 오버레이를
 * 전부 버리고 다시 만들면 화면이 깜빡이고, 책상을 올려 둔 가구 평면도 한
 * 프레임 사라졌다 돌아온다 — 그 사이 책상이 포털 앞 가짜 자리로 튀었다 온다.
 * 방 껍데기와 같은 유예를 둔다.
 */
const planeLastSeen = new Map<XRPlane, number>();
const PLANE_VANISH_GRACE = 500;

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
  planeLastSeen.delete(plane);
}

let lastPlaneSummary = '';

function updatePlanes(frame: XRFrame, referenceSpace: XRReferenceSpace): void {
  const detectedPlanes = frame.detectedPlanes;
  // plane-detection이 안 켜진 세션에서는 아예 undefined다.
  if (detectedPlanes === undefined) return;

  // 런타임이 더 이상 추적하지 않는 평면 치우기. 한 프레임 안 보이는 것과
  // 정말 없어진 것은 기다려 보면 갈린다(planeLastSeen 주석 참고).
  const now = performance.now();
  for (const plane of [...planeMeshes.keys()]) {
    if (detectedPlanes.has(plane)) {
      planeLastSeen.set(plane, now);
      continue;
    }
    if (now - (planeLastSeen.get(plane) ?? now) < PLANE_VANISH_GRACE) continue;
    disposePlane(plane);
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
// 5) 파이프
//
//    감지된 면(벽·바닥·천장) 중 하나를 골라, 그 면 위의 아무 자리에 파이프를
//    뚫는다. 사람은 고르지 않는다.
//
//    전에는 오른손으로 벽을 가리켜 놓았다. 그건 '내가 여기 놓았다'는 그림이라
//    이야기와 어긋났다 — 이 구멍은 원래 집에 있던 것이어야 한다. 가리키는
//    조준선, 레이캐스트, 확정 전 미리보기 원판이 그래서 통째로 빠졌다.
//
//    여러 개를 서로 떨어진 자리에 뚫는다. 구멍 하나에서 줄지어 나오는 것과,
//    방 여기저기가 동시에 새는 것은 다른 그림이다 — 하나는 '저기 구멍이
//    있구나'고, 여럿은 '이 집이 통째로 그렇구나'다. 보는 사람이 한 구멍을
//    들여다보는 동안 등 뒤의 구멍이 깨어난다.
//
//    면 하나에 올려놓는 방식이라 벽·바닥·천장이 같은 코드로 풀린다. 방향을
//    타는 값은 딱 하나다 — 아래턱(바퀴가 딛고 나오는 쪽)이 구멍의 어디냐.
//    벽에서는 아래, 바닥·천장에서는 아무 쪽이다.
//
//    ── 구멍이 '구멍으로만' 보이는 원리 ──
//
//    두 번에 나눠 그린다.
//      1. 원판을 '색도 깊이도 쓰지 않고' 그린다. 스텐실 버퍼에 그 파이프의
//         번호만 찍힌다.
//      2. 관 속을 '스텐실이 그 번호인 픽셀에만' 그린다.
//    관 속의 물체들은 실제로 벽 뒤 좌표에 있다. 가려 주는 물체가 없으니 그냥
//    그리면 벽을 뚫고 둥둥 떠 보이는데, 2번의 스텐실 테스트가 구멍 밖의
//    픽셀을 전부 버려서 '구멍으로만 보이는' 상태를 만든다.
//
//    파이프마다 번호가 다르다(1, 2, 3...). 같은 값을 나눠 쓰면 화면에서 두
//    구멍이 겹칠 때 한쪽 관 속이 다른 쪽 구멍으로 비친다.
//
//    AR이라 유리한 점이 하나 있다. 구멍 밖은 우리가 아무것도 안 그리므로
//    투명하게 남고, 거기에 패스스루가 합성된다. 즉 '벽을 가리는 가짜 벽'을
//    그릴 필요가 없다 — VR에서 같은 기법을 쓸 때 필요한 단계가 통째로 빠진다.
//
//    이 기법이 성립하려면 스텐실 버퍼가 있어야 한다. ②에서 WebGLRenderer에
//    stencil: true를 준 것이 XRWebGLLayer/XRProjectionLayer까지 전달돼
//    DEPTH24_STENCIL8로 잡힌다.
// ---------------------------------------------------------------------------
/**
 * 파이프 구경(m).
 *
 * 사각형 포털이었다. 벽에 네모난 구멍이 뚫리고 거기서 바퀴가 나오는 건
 * 설명이 안 됐다 — 바퀴가 나오는 데는 파이프다. 틈으로 할까 했지만 틈은
 * 얇아서 너머의 깊이가 안 보이고, 그 깊이가 이 작품의 스텐실이 하는 일
 * 전부다. 파이프는 입이 작으면서 안쪽으로 깊다.
 *
 * 바퀴가 4cm다. 14cm면 한 마리가 넉넉히 지나고, 여러 마리면 줄을 선다.
 */
const PIPE_BORE = 0.14;
/** 파이프의 길이(m). 끝은 어둠에 묻힌다. */
const PIPE_DEPTH = 2.5;
/** 감지된 면이 없을 때 눈앞 허공에 세울 거리(m). */
const PIPE_FALLBACK_DISTANCE = 1.5;
/**
 * 평면이 들어오기를 이만큼 기다린다(ms). 그래도 없으면 허공에 세운다.
 *
 * 평면은 세션이 시작된 뒤 몇 프레임 지나서야 들어온다. 기다리지 않으면
 * 스캔한 방에서도 늘 허공 경로로 떨어진다.
 */
const PIPE_WAIT_FOR_PLANES = 4000;
/** 구멍 테두리를 면의 활동 사각형 끝에서 이만큼 안으로 당긴다(m). */
const PIPE_EDGE_MARGIN = 0.1;

/**
 * 몇 개나 뚫을지.
 *
 * 셋이면 한 화면에 둘이 들어오는 일이 생기면서도 각각이 따로 알아채진다.
 * 넷을 넘기면 어느 구멍에서 나왔는지가 섞여서 그냥 '벌레가 많다'가 된다.
 *
 * 이 수는 나중에 못 바꾼다 — 자르는 평면의 개수가 셰이더에 박히기 때문이다
 * (portal-crossing.ts의 preparePipes 주석 참고). 그래서 상수다.
 */
const PIPE_COUNT = 3;
/**
 * 구멍끼리 이만큼은 떨어뜨린다(m).
 *
 * 난수로 집으면 두 구멍이 한 뼘 차이로 붙는 일이 생각보다 자주 난다. 붙으면
 * 스텐실 원판이 화면에서 겹쳐서, 한쪽 관 속이 다른 쪽 구멍 테두리를 넘어
 * 비친다. 그리고 그림으로도 아깝다 — 떨어져 있어야 방 전체가 샌다.
 */
const PIPE_MIN_GAP = 0.8;

/**
 * 구멍을 면에서 이만큼 띄운다(m). 면과 완전히 같은 평면에 두면 z-fighting이
 * 난다.
 */
const PORTAL_WALL_GAP = 0.01;

/**
 * 자르는 평면을 면보다 이만큼 더 뒤에 둔다(m).
 *
 * 평면을 벽에 딱 맞춰 두었더니 이번엔 벽과 바닥이 만나는 모서리가 문제가 됐다.
 * 주촉성 때문에 바퀴는 그 모서리에 붙어 사는데, 거기가 평면 위라 몸이 반쯤
 * 잘린다. 벽-천장 모서리도, 파이프가 뚫린 벽과 옆벽이 만나는 구석도 마찬가지다.
 *
 * 평면을 벽 속으로 조금 밀어 넣으면 방 전체가 한쪽에 안전하게 들어온다.
 * 이 3cm 띠 안에 있는 것은 구멍 안의 복도뿐이고, 복도에서 기다리는 자리는
 * 거기서 50cm는 더 뒤다.
 */
const PORTAL_CLIP_DEPTH = 0.03;

const WORLD_UP = new THREE.Vector3(0, 1, 0);
const WORLD_DOWN = new THREE.Vector3(0, -1, 0);

// 지오메트리는 파이프끼리 나눠 쓴다. 재질은 못 나눈다 — 스텐실 번호가 재질에
// 박히기 때문이다.
//
// CircleGeometry는 X-Y에 누워 +Z를 향한다. orientPipe가 그룹의 로컬 +Z를 면의
// 법선에 맞추므로, 지오메트리를 따로 돌릴 필요가 없다.
//
// EdgesGeometry는 면이 같은 평면이면 안쪽 변을 버리므로, 원판에서 바깥 테두리만
// 남는다 — 파이프 입구의 링이 공짜로 나온다.
const portalShape = new THREE.CircleGeometry(PIPE_BORE / 2, 32);
const portalRing = new THREE.EdgesGeometry(portalShape);

// 관. CylinderGeometry의 축은 Y다. X로 90° 눕히면 +Y가 +Z로 가므로 축이 벽
// 안쪽을 향한다.
const tubeGeometry = new THREE.CylinderGeometry(
  PIPE_BORE / 2,
  PIPE_BORE / 2,
  PIPE_DEPTH,
  24,
  1,
  true,
);
tubeGeometry.rotateX(Math.PI / 2);

// 일정 간격의 링. 같은 크기의 원이 작아지며 멀어지는 게 사람 눈에 가장 잘
// 먹는 깊이 단서다. 관 안쪽이라 사각형이 아니라 원이어야 한다.
const ribGeometry = new THREE.BufferGeometry().setFromPoints(
  Array.from({ length: 25 }, (_, i) => {
    const angle = (i / 24) * Math.PI * 2;
    const radius = (PIPE_BORE / 2) * 0.96;
    return new THREE.Vector3(Math.cos(angle) * radius, Math.sin(angle) * radius, 0);
  }),
);

/** 관 끝을 막는 원판. */
const capGeometry = new THREE.CircleGeometry(PIPE_BORE / 2, 32);

/** 구멍 하나와 그에 딸린 것들. */
interface Pipe {
  /** 스텐실 번호와 자르는 평면을 고르는 열쇠. 0부터. */
  index: number;
  /** 구멍 전체. 이걸 옮기면 테두리·마스크·관 속이 함께 간다. */
  group: THREE.Group;
  /** 스텐실에 번호만 찍는 원판. */
  mask: THREE.Mesh;
  /** 관 속. group의 자식이라 구멍이 놓인 자세를 그대로 따라간다. */
  world: THREE.Group;
  /**
   * 가까이 갔을 때 같이 흐려질 재질들. 원래 투명도를 들고 다닌다.
   *
   * 리브는 거리별로 서로 다른 opacity를 갖는데, 페이드가 그 값을 덮어쓰면
   * 깊이 단서가 사라진다. 페이드는 덮어쓰는 게 아니라 원래 값에 곱한다.
   */
  fade: { material: THREE.Material; baseOpacity: number }[];
  /** 관 안에서 딛는 면. 바퀴는 여기서 기다리다 나온다. */
  corridor: WalkSurface;
  /** 뚫린 진짜 면. 못 찾았으면 null. 벽일 수도 바닥·천장일 수도 있다. */
  host: WalkSurface | null;
  /** 복도 ↔ 그 면의 모서리. 다시 뚫으면 걷어내고 새로 만든다. */
  link: { surface: WalkSurface; edge: SurfaceEdge }[];
  /** 어디에 뚫렸는지. 로그와 손바닥 패널에만 쓴다. */
  hostLabel: string;
  /** 뚫린 자리(월드). 구멍끼리 간격을 재는 데 쓴다. */
  spot: THREE.Vector3;
  placed: boolean;
  /** 이 구멍의 바퀴들이 이미 나오기 시작했는지. 구멍마다 따로 깨어난다. */
  emerged: boolean;
}

function makePipe(index: number): Pipe {
  const group = new THREE.Group();
  scene.add(group);

  const ref = pipeStencilRef(index);
  const fade: { material: THREE.Material; baseOpacity: number }[] = [];
  function keepFaded<T extends THREE.Material>(material: T): T {
    fade.push({ material, baseOpacity: material.opacity });
    return material;
  }

  /** 재질에 '스텐실이 이 파이프의 번호인 픽셀에만 그려라'를 건다. */
  function showThroughHole(object: THREE.Mesh | THREE.Line): void {
    const material = object.material as THREE.Material;
    material.stencilWrite = true;
    material.stencilRef = ref;
    material.stencilFunc = THREE.EqualStencilFunc;
    object.renderOrder = 1; // 마스크보다 나중
  }

  // 파이프 입구의 링.
  group.add(
    new THREE.LineSegments(
      portalRing,
      keepFaded(new THREE.LineBasicMaterial({ color: 0xffcc33, transparent: true })),
    ),
  );

  // 1단계: 스텐실에 표시만 하는 원판.
  const mask = new THREE.Mesh(
    portalShape,
    new THREE.MeshBasicMaterial({
      colorWrite: false, // 색을 쓰지 않는다 — 화면에는 아무것도 안 나온다
      depthWrite: false, // 깊이도 쓰지 않는다 — 관 속을 가리면 안 되니까
      stencilWrite: true,
      stencilRef: ref,
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
  // 그게 위험한 이유: 구멍보다 앞에 있으면서 깊이를 쓰는 물체가 마스크보다
  // 먼저 그려지면, 마스크가 그 픽셀에서 깊이 테스트에 떨어져 스텐실을 못 찍는다.
  // 구멍 일부가 뜯겨 나간 것처럼 보이고, 원인을 찾기가 아주 어렵다.
  // 음수를 줘서 순서를 못 넘보게 한다.
  mask.renderOrder = -1;
  mask.visible = false;
  group.add(mask);

  // 2단계: 관 속. 로컬 -Z가 벽 안쪽이므로, 내용물을 z<0에 두면 '벽 너머'가 된다.
  const world = new THREE.Group();
  world.visible = false;
  group.add(world);

  // 관. BackSide라서 안쪽 면만 그려진다 — 파이프 속에 들어와 있는 셈이다.
  const tube = new THREE.Mesh(
    tubeGeometry,
    keepFaded(
      new THREE.MeshStandardMaterial({
        // 배수관이다. 파랗고 환한 '너머 공간'이 아니라 때 낀 어둠이어야 한다.
        color: 0x15181c,
        roughness: 1,
        side: THREE.BackSide,
        // 페이드를 위해 처음부터 transparent로 둔다. 런타임에 이 값을 바꾸면
        // 셰이더가 다시 컴파일돼서 그 프레임이 튄다.
        transparent: true,
      }),
    ),
  );
  tube.position.z = -PIPE_DEPTH / 2;
  showThroughHole(tube);
  world.add(tube);

  for (let i = 1; i <= 5; i += 1) {
    const rib = new THREE.Line(
      ribGeometry,
      keepFaded(
        new THREE.LineBasicMaterial({
          color: 0x6e8aa0,
          transparent: true,
          // 멀수록 흐리게. 거리감을 한 번 더 준다.
          opacity: 0.55 - i * 0.09,
        }),
      ),
    );
    rib.position.z = -i * (PIPE_DEPTH / 6);
    showThroughHole(rib);
    world.add(rib);
  }

  // 관은 자기 조명을 가진다. 거리에 따라 꺼지는 PointLight가 끝을 어둠으로
  // 만들어 준다. 좁은 관이라 빛이 사방 벽에 바로 닿아서, 네모 복도 때보다
  // 세기를 많이 낮춰야 한다.
  const lamp = new THREE.PointLight(0x99ddff, 0.12, 1.1);
  lamp.position.z = -0.5;
  world.add(lamp);

  // 관 끝을 막는다. CylinderGeometry를 openEnded로 만들었으므로 끝이 뚫려
  // 있는데, 기기에서는 우리가 아무것도 안 그린 픽셀에 패스스루가 채워진다 —
  // 파이프 끝으로 진짜 방이 비쳐 보인다. 검은 원판 하나로 막는다.
  const cap = new THREE.Mesh(
    capGeometry,
    keepFaded(new THREE.MeshBasicMaterial({ color: 0x05060a, transparent: true })),
  );
  cap.position.z = -PIPE_DEPTH;
  showThroughHole(cap);
  world.add(cap);

  return {
    index,
    group,
    mask,
    world,
    fade,
    corridor: makeWalkSurface(scene),
    host: null,
    link: [],
    hostLabel: '',
    spot: new THREE.Vector3(),
    placed: false,
    emerged: false,
  };
}

// 자르는 평면 자리를 미리 잡아 둔다. 바퀴 복사본을 만들기 전이어야 한다.
preparePipes(PIPE_COUNT);

const pipes: Pipe[] = [];
for (let i = 0; i < PIPE_COUNT; i += 1) pipes.push(makePipe(i));

// 아주 약한 환경광. 이게 없으면 램프가 닿지 않는 면이 완전히 검게 죽어서
// 형태가 안 읽힌다. three.js의 조명은 부모와 무관하게 씬 전체에 작용하므로
// 파이프마다 두면 안 된다 — 세 개면 세 배로 밝아진다. 씬에 하나만 둔다.
scene.add(new THREE.AmbientLight(0x335577, 1.5));

/** 지금 몇 개나 뚫려 있는지. */
let placedCount = 0;

/**
 * 이 시각이 지나도 자리가 안 나오면 있는 것으로 간다. 음수면 아직 재기 전.
 *
 * setAnimationLoop이 주는 시각으로 잰다. performance.now()와 같은 시계일 것
 * 같지만, XR 세션의 프레임 시각이 어느 원점을 쓰는지는 보장하지 않는다 —
 * 들어오는 숫자로만 재면 그걸 알 필요가 없다.
 */
let placeDeadline = -1;
/** 더 뚫을 자리를 찾는 일을 그만뒀는지. 매 프레임 난수를 던지지 않으려고 둔다. */
let placingDone = false;

// 매 프레임 new Vector3를 만들지 않으려고 미리 잡아 둔다. three.js 코드에서
// 흔한 관습이다.
const portalNormal = new THREE.Vector3();
/**
 * 파이프의 로컬 +Y(월드). 아래턱의 반대쪽을 가리킨다.
 *
 * 벽에 걸린 파이프에서는 이게 월드 위다. 바닥이나 천장에 걸리면 면 안에
 * 눕는다 — 그래도 '아래턱 반대쪽'이라는 뜻은 그대로여서, 이걸 기준으로 쓰는
 * 코드는 세 경우를 가리지 않는다.
 */
const portalUp = new THREE.Vector3();
/** 구멍에서 멀어지는 수평 방향. 지어낸 책상을 어디에 둘지 정할 때만 쓴다. */
const awayDir = new THREE.Vector3();
const basisRight = new THREE.Vector3();
const basisUp = new THREE.Vector3();
const basisMatrix = new THREE.Matrix4();

/**
 * 파이프를 면에 '똑바로' 거는 자세를 만든다.
 *
 * 면 평면의 로컬 축을 그대로 쓰지 않는다. 로컬 X/Z 중 어느 쪽이 세로인지
 * 스펙이 보장하지 않고, 바닥·천장에서는 세로라는 것 자체가 없다.
 *
 * 전에는 월드 업과 법선으로 기저를 만들었다. 벽에서만 되는 요령이다 —
 * 바닥에 걸면 법선이 월드 업이라 외적이 0이 되고 자세가 NaN이 된다.
 * 이제는 법선과 아래턱 방향, 둘 다 면 안의 정보로만 만든다.
 *
 * @param sillDir 구멍 가운데에서 아래턱으로 가는 방향(월드). 면 안에 눕는다.
 */
function orientPipe(
  pipe: Pipe,
  point: THREE.Vector3,
  normal: THREE.Vector3,
  sillDir: THREE.Vector3,
): void {
  // 로컬 +Y = 아래턱의 반대쪽. 법선 성분을 빼서 면 안에 눕힌다.
  basisUp
    .copy(sillDir)
    .addScaledVector(normal, -sillDir.dot(normal))
    .negate()
    .normalize();
  // 오른손 좌표계라 X = Y × Z다.
  basisRight.crossVectors(basisUp, normal).normalize();
  basisMatrix.makeBasis(basisRight, basisUp, normal);

  pipe.group.quaternion.setFromRotationMatrix(basisMatrix);
  // 면과 완전히 같은 평면에 두면 z-fighting이 난다. 1cm 띄운다.
  pipe.group.position.copy(point).addScaledVector(normal, PORTAL_WALL_GAP);
}

// 자리를 고른 결과. 고르는 것과 놓는 것을 나눠 둬야 '감지된 면'과 '허공'이
// 같은 놓기 코드를 쓴다.
const spotPoint = new THREE.Vector3();
const spotNormal = new THREE.Vector3();
const spotSill = new THREE.Vector3();
const spotQuaternion = new THREE.Quaternion();
const spotInverse = new THREE.Matrix4();
const sillLocal = new THREE.Vector3();
/** 고른 자리의 면 이름. pickPipeSpot이 채우고 placePipeAt이 가져간다. */
let spotLabel = '';

/**
 * 아래턱이 구멍의 어느 쪽인지 정한다(면 안에 눕는 단위 벡터, 월드).
 *
 * 벽이면 '아래'다. 나와서 벽을 타고 내려가는 그림이 그래야 나온다. 바닥과
 * 천장에는 아래가 없으니 아무 방향이나 고른다 — 관 속에서는 그 방향 반대쪽이
 * 곧 바퀴가 딛는 관 벽이 되므로, 어느 쪽이어도 그림이 성립한다.
 *
 * 면의 로컬에서 고른다. 로컬 XZ는 이미 면 안이라, 수평 면에서 '면 안의 아무
 * 방향'이 각도 하나로 끝난다.
 */
function pickSillDir(node: THREE.Object3D, out: THREE.Vector3): void {
  spotInverse.copy(node.matrixWorld).invert();
  sillLocal.copy(WORLD_DOWN).transformDirection(spotInverse);
  sillLocal.y = 0; // 법선 성분을 버린다

  // transformDirection이 단위로 만들어 주므로, 여기서 0.3보다 짧으면 면이
  // 수평에서 17° 안쪽이라는 뜻이다 — 바닥이나 천장이다.
  if (sillLocal.lengthSq() < 0.09) {
    const angle = Math.random() * Math.PI * 2;
    sillLocal.set(Math.cos(angle), 0, Math.sin(angle));
  }

  out.copy(sillLocal).transformDirection(node.matrixWorld);
}

/**
 * 감지된 면 하나를 골라 그 위의 아무 자리를 집는다. 쓸 만한 자리가 없으면 false.
 *
 * 활동 사각형에서 고른다(평면의 바운딩 박스가 아니라). 구멍이 바퀴가 못 가는
 * 데 뚫리면 나올 길이 없기 때문이다.
 *
 * 면도 자리도 매번 다시 던진다. 면을 미리 배분하지 않는 이유는, 벽이 둘뿐인
 * 방에서도 셋을 뚫을 수 있어야 하기 때문이다 — 같은 벽에 떨어져 뚫리면 된다.
 * 대신 이미 뚫린 구멍과 너무 가까우면 다시 던진다.
 *
 * @param taken 이미 뚫린 구멍들의 자리(월드)
 */
function pickPipeSpot(taken: THREE.Vector3[]): boolean {
  const margin = PIPE_BORE / 2 + PIPE_EDGE_MARGIN;
  const roomy = roomShell.surfaces.filter(
    (shell) =>
      shell.surface.boundHalfX > margin && shell.surface.boundHalfZ > margin,
  );
  if (roomy.length === 0) return false;

  // 난수라 한 번에 멀찍이 떨어진 자리가 나오지 않는다. 몇 번 던져 보고
  // 안 되면 포기한다 — 좁은 방에서는 정말로 자리가 없을 수 있다.
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const shell = roomy[Math.floor(Math.random() * roomy.length)];
    const node = shell.surface.node;
    node.updateMatrixWorld();

    spotPoint.set(
      (Math.random() * 2 - 1) * (shell.surface.boundHalfX - margin),
      0,
      shell.surface.boundCenterZ +
        (Math.random() * 2 - 1) * (shell.surface.boundHalfZ - margin),
    );
    node.localToWorld(spotPoint);

    if (taken.some((point) => point.distanceTo(spotPoint) < PIPE_MIN_GAP)) continue;

    // 면의 로컬 +Y가 법선이다. 껍데기가 이미 방 안쪽을 보도록 뒤집어 놨다.
    node.getWorldQuaternion(spotQuaternion);
    spotNormal.set(0, 1, 0).applyQuaternion(spotQuaternion).normalize();
    pickSillDir(node, spotSill);

    spotLabel = shell.label;
    return true;
  }
  return false;
}

/** 고른 자리에 구멍을 뚫는다. */
function placePipeAt(
  pipe: Pipe,
  point: THREE.Vector3,
  normal: THREE.Vector3,
  sillDir: THREE.Vector3,
): void {
  if (!pipe.placed) placedCount += 1;
  pipe.placed = true;
  pipe.hostLabel = spotLabel;
  // 면들이 통째로 옮겨 간다. 방과 만나는 자리를 다시 구해야 한다.
  needsRelink = true;

  pipe.spot.copy(point);
  orientPipe(pipe, point, normal, sillDir);

  pipe.mask.visible = true;
  pipe.world.visible = true;

  // 평면 시각화는 디버그용이었다. 켜 둔 채로 두면 벽 오버레이가 구멍 앞을
  // 가린다. 다시 보고 싶으면 손바닥 패널에서 켠다.
  showPlanes = false;
  applyPlaneVisibility();

  log(
    `파이프 ${pipe.index} ${pipe.hostLabel}: ` +
      `${point.x.toFixed(2)}, ${point.y.toFixed(2)}, ${point.z.toFixed(2)}`,
  );
}

/**
 * 아직 안 뚫린 파이프가 있으면 뚫는다. 매 프레임 부른다.
 *
 * 평면이 들어오기를 잠깐 기다린다. 방을 스캔한 적 없는 기기에서는 영영 안
 * 오므로, 그때는 눈앞 허공에 벽처럼 하나만 세운다 — 손으로 세운 벽면과 방
 * 바닥이 그 경우를 위해 남아 있고, 그 둘은 한 벌뿐이라 나머지 파이프는
 * 나갈 데가 없다.
 */
function tryPlacePipes(viewer: THREE.Object3D, now: number): void {
  if (placingDone) return;
  if (placeDeadline < 0) placeDeadline = now + PIPE_WAIT_FOR_PLANES;

  const taken = pipes.filter((pipe) => pipe.placed).map((pipe) => pipe.spot);
  for (const pipe of pipes) {
    if (pipe.placed) continue;
    if (!pickPipeSpot(taken)) break;
    placePipeAt(pipe, spotPoint, spotNormal, spotSill);
    taken.push(pipe.spot);
  }

  if (placedCount === PIPE_COUNT) {
    placingDone = true;
    return;
  }
  if (now < placeDeadline) return;

  // 기한이 지났다. 하나도 못 뚫었으면 눈앞 허공에 세운다.
  if (placedCount === 0) {
    viewer.getWorldPosition(spotPoint);
    viewer.getWorldDirection(spotNormal); // 월드 기준 -Z
    spotPoint.addScaledVector(spotNormal, PIPE_FALLBACK_DISTANCE);
    // 법선은 보는 사람 쪽. 바닥이나 천장을 보고 있었어도 벽처럼 수직으로 세운다.
    spotNormal.negate();
    spotNormal.y = 0;
    if (spotNormal.lengthSq() < 1e-4) spotNormal.set(0, 0, 1);
    spotNormal.normalize();
    spotSill.copy(WORLD_DOWN);

    spotLabel = '허공';
    placePipeAt(pipes[0], spotPoint, spotNormal, spotSill);
  }

  // 더 기다려도 자리가 안 나온다. 뚫린 것으로 간다.
  log(`파이프 ${placedCount}개로 간다`);
  placingDone = true;
}

/** [미리보기 전용] 자리가 난수라, 뚫린 데로 카메라를 데려간다. */
function aimPreviewCamera(pipe = pipes.find((p) => p.placed)): void {
  if (pipe === undefined) return;
  portalNormal.set(0, 0, 1).applyQuaternion(pipe.group.quaternion);
  portalUp.set(0, 1, 0).applyQuaternion(pipe.group.quaternion);
  camera.position
    .copy(pipe.group.position)
    .addScaledVector(portalNormal, 0.5)
    // 입구를 정면으로 꽉 채우면 나온 바퀴가 어디로 가는지 안 보인다.
    .addScaledVector(portalUp, 0.25);
  camera.lookAt(pipe.group.position);
}

/**
 * 구멍을 전부 다른 자리로 옮긴다. 핀치하면 이게 돈다.
 *
 * 자리가 난수라 헤드셋에서 여러 경우를 보려면 세션을 다시 시작하는 수밖에
 * 없었다. 바퀴도 되돌린다 — 복도가 통째로 옮겨 가므로, 이미 방에 나와 있던
 * 놈들은 구멍과 상관없는 데 남는다.
 */
function repickPipes(): void {
  resetPipes();
  resetRoaches();
}

function resetPipes(): void {
  placedCount = 0;
  placeDeadline = -1;
  placingDone = false;

  // 평면 오버레이를 다시 켠다. 구멍이 뚫리기 전까지는 이게 유일한 길잡이다.
  //
  // 전에는 평면 메시가 태어날 때 placed를 보고 자기 visible을 정했다. 손바닥
  // 패널에서 껐다 켤 수 있게 그걸 showPlanes 하나로 모았는데, 여기서 되돌리는
  // 걸 빠뜨렸다. 데스크톱 미리보기가 시작하자마자 가짜 구멍을 놓으며
  // showPlanes를 꺼 버리므로, 세션에 들어가면 진짜 방의 평면이 전부 안 보이는
  // 채로 생겼다 — 벽을 가리켜도 아무 표시가 없다.
  showPlanes = true;
  applyPlaneVisibility();

  for (const pipe of pipes) {
    pipe.placed = false;
    pipe.emerged = false;
    pipe.hostLabel = '';
    pipe.mask.visible = false;
    pipe.world.visible = false;
    // 페이드 중에 세션이 끝났을 수 있다. 다음 세션은 멀쩡한 상태로 시작한다.
    for (const entry of pipe.fade) entry.material.opacity = entry.baseOpacity;
  }
}

// 구멍 평면에 얼굴을 들이밀면 두 가지가 깨진다. 카메라의 near(1cm)가 마스크
// 원판을 잘라서 구멍이 가장자리부터 뜯겨 나가고, 평면을 넘는 순간 마스크가
// 백페이스 컬링으로 사라진다. 더 나쁜 건 그 사이 구간인데, 두 눈 간격이 6.4cm라
// 한 눈은 구멍을 보고 다른 눈은 못 보는 상태가 반드시 생긴다. 보는 사람이
// 멀미하는 종류의 깨짐이다.
//
// 그 구간에 도달하기 전에 구멍을 흐려서 없앤다. 통과를 지원하려면 더 큰 작업이
// 필요한데, 이 작품의 범위에서는 이걸로 충분하다.
// 처음엔 0.3 → 0.08이었는데 너무 일렀다. 30cm는 구멍 안을 들여다보려고 몸을
// 기울이는 거리라, 보려고 다가가면 이미 흐려지기 시작했다.
// 실제로 깨지는 구간은 눈 간격(6.4cm) 안쪽이다. 거기 닿기 직전에만 걷는다.
const PORTAL_FADE_FULL_AT = 0.13; // 이보다 멀면 완전히 보인다
const PORTAL_FADE_GONE_AT = 0.045; // 이보다 가까우면 완전히 사라진다

const portalFacing = new THREE.Vector3();
const headToPortal = new THREE.Vector3();

function updatePipeFade(pipe: Pipe, headPosition: THREE.Vector3): void {
  // 구멍 그룹의 로컬 +Z가 법선이다(orientPipe가 그렇게 맞춰 놨다).
  portalFacing.set(0, 0, 1).applyQuaternion(pipe.group.quaternion);
  // 평면까지의 '부호 있는' 거리. 뒤로 넘어가면 음수가 되므로,
  // 평면을 넘은 경우도 같은 식으로 처리된다.
  const distance = headToPortal
    .subVectors(headPosition, pipe.group.position)
    .dot(portalFacing);

  const visibility = THREE.MathUtils.smoothstep(
    distance,
    PORTAL_FADE_GONE_AT,
    PORTAL_FADE_FULL_AT,
  );

  // 완전히 투명해지면 아예 그리지 않는다. 스텐실까지 멈춰야 깨끗하다.
  pipe.mask.visible = visibility > 0;
  pipe.world.visible = visibility > 0;

  for (const entry of pipe.fade) {
    entry.material.opacity = entry.baseOpacity * visibility;
  }

  // 구멍 안에 있는 바퀴도 같이 흐려져야 한다. 안 묶어 두면 관만 사라지고
  // 바퀴는 불투명하게 남아, 허공에 벌레만 떠 있는 그림이 된다.
  setPipeInsideOpacity(pipe.index, visibility);
}
// ---------------------------------------------------------------------------
// 7) 바퀴벌레
//
//    포털 안쪽 복도에서 기다리다, 사람이 다가오면 아래턱을 넘어 벽으로 나온다.
//    거기서부터는 감지된 방이 무대다 — 벽을 타고 내려와 바닥을 돌고 책상에
//    오른다.
// ---------------------------------------------------------------------------
// ④에서 씬 조명을 포털 안으로 옮겼다. 포털 바깥에 조명을 받는 물체가
// 바퀴벌레 하나 생겼으므로 다시 들인다. AR에서는 실제 방의 조명 정보가
// 오지 않으므로(Quest 브라우저에 light estimation이 없다) 방 조명을 가정한다.
scene.add(new THREE.HemisphereLight(0xffffff, 0x404050, 1.6));
const roachSun = new THREE.DirectionalLight(0xffffff, 2);
roachSun.position.set(0.5, 1, 0.4);
scene.add(roachSun);

// portalNormal은 ⑤에서 파이프 자세를 잡을 때 이미 선언해 두었다.

// 손으로 세운 벽면과 방 바닥. 스캔한 적 없는 방을 위한 대비다.
// 둘 다 원점을 아래턱 선 위에 두고 로컬 X를 그 선과 나란히 둔다(walk-surface.ts).
const wallFace = makeWalkSurface(scene);
const roomFloor = makeWalkSurface(scene);

// 관 안에서 딛는 면은 파이프마다 하나씩 있다(⑤의 makePipe가 만든다).
/** 지금 있는 복도들. 바퀴가 어느 관에 있는지 가릴 때 쓴다. */
const corridors = new Set(pipes.map((pipe) => pipe.corridor));

// 모서리는 양방향이다. 나올 때 지나온 길을 그대로 되짚어 올라갈 수 있다.
//
// 아래턱: 복도 바닥의 +Z 끝과 벽면의 -Z 끝이 만난다.
// 벽면에서 위로 올라가는 건 구멍 폭 안에서만 된다 — 그 밖은 막힌 벽이다.
//
// 0번 파이프만 잇는다. 손으로 세운 벽면은 한 벌뿐이고, 이게 쓰이는 경우는
// 감지된 평면이 하나도 없을 때뿐인데 그때는 파이프도 하나만 세운다.
linkSurfaces(
  pipes[0].corridor,
  { nx: 0, nz: 1, at: 0 },
  wallFace,
  { nx: 0, nz: -1, at: 0, halfWidth: PIPE_BORE / 2 },
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

// 복도와 벽면은 +Z가 '계속 가는 쪽'이다.
// 복도에서는 구멍 밖, 벽에서는 아래로.
wallFace.drift = 0;
// 방 바닥에는 목적지가 없다. 여기서부터는 주촉성으로 가장자리를 살피며
// 돌아다닌다 — 나온 뒤의 행동이다. 가장자리를 따라가는 건 여기서만 켠다.
roomFloor.drift = null;
roomFloor.hugEdges = true;

// 돌아다닐 범위. 면마다 모양이 달라서 따로 준다.
// 복도 바닥은 구멍 안쪽으로 좁게, 방 바닥은 넓게.
/**
 * 관 바닥에서 걸을 수 있는 폭의 절반.
 *
 * 관은 둥글어서 구경 끝으로 갈수록 바닥이 솟는다. 가운데 쪽만 평평하다고 치고
 * 그만큼만 쓴다. 여덟 마리가 들어가기엔 좁지만, 길이 방향으로 줄을 서면 된다 —
 * 파이프 안에서 꿈틀대며 밀리는 게 그림으로도 맞다.
 */
const CORRIDOR_HALF_X = PIPE_BORE * 0.3;

/** 바퀴 몸의 반폭(m). 다리를 벌린 폭이라 그림자 판(몸길이의 0.7배)에서 딴다. */
const ROACH_HALF_WIDTH = ROACH_LENGTH * 0.4;

/**
 * 딛는 면을 관 '축'보다 이만큼 아래에 둔다(m). 구경의 절반이 아니다.
 *
 * 전에는 구경의 절반, 즉 관의 맨 밑에 접하는 평면이었다. 둥근 관에 평평한
 * 바닥을 넣는 방법으로는 최악의 짝이다 — 접점은 딱 한 줄(x = 0)뿐이고, 거기서
 * 조금만 옆으로 가면 평면이 관 밖으로 나간다. 축에서 4.2cm 지점에서 벌써
 * 1.4cm를 뚫고 나가는데, 바퀴 키가 1cm도 안 되니 몸이 통째로 관 벽에 묻힌다.
 *
 * 실제로 그랬다. 헤드셋에서 '파이프와 벽 사이 전환부에서 묻힌다'고 보였고,
 * 재 보니 복도에 있는 여덟 마리가 **전부** 관 밖에 있었다 — 가운데 선 놈도
 * 배가 관 벽과 같은 평면이었다(0.03cm 밖). 아래턱 선 자체가 구멍 테두리 위에
 * 놓여 있었으니, 거기를 걷는 바퀴는 스텐실에도 반쯤 잘렸다.
 *
 * 평평한 바닥이 관 안에 들어가려면 접선이 아니라 '현'이어야 한다. 바퀴가 쓸
 * 반폭에 몸 반폭을 더한 지점이 관 벽에 닿도록 깊이를 잡는다 — 피타고라스
 * 한 줄이고, 구경이나 복도 폭을 바꿔도 따라온다.
 */
const CORRIDOR_DROP = Math.sqrt(
  (PIPE_BORE / 2) ** 2 - (CORRIDOR_HALF_X + ROACH_HALF_WIDTH) ** 2,
);

/**
 * 면의 반폭이 이보다 좁으면 서로 비키지 않는다(m).
 *
 * 비키기는 몸길이의 1.6배 안에 든 이웃의 반대쪽으로 트는 조향이다. 복도는
 * 반폭이 4.2cm라 그 반경보다 좁다 — 여덟 마리가 들어가면 모두가 서로의
 * 반경 안이라, 전부가 쉬지 않고 바깥쪽으로 튼다. 가장자리 조향도 조향일
 * 뿐이라 이걸 못 이기고, 축에서 16cm까지 밀려 나간 놈이 있었다. 관 반지름의
 * 두 배다.
 *
 * 좁은 데서는 비키는 대신 겹친다. 파이프 안에서 몸이 서로 밀리고 포개지는
 * 건 피할 일이 아니라 그리려던 그림이다.
 */
const AVOID_MIN_HALF_X = ROACH_LENGTH * 1.5;

for (const pipe of pipes) {
  pipe.corridor.drift = 0; // 구멍 밖으로
  pipe.corridor.boundHalfX = CORRIDOR_HALF_X;
  pipe.corridor.boundCenterZ = -0.12;
  pipe.corridor.boundHalfZ = 0.2;
}
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
// 복도 안쪽 반폭이 PIPE_BORE/2 + 0.1이다. 여덟 마리가 한 원에 몰리지
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

/** 대기 구역 안의 아무 자리에 놓는다. 구역이 사각형이라 그대로 사각형에 뿌린다. */
function scatterInLurk(roach: Roach, pipe: Pipe): void {
  roach.placeOn(
    pipe.corridor.node,
    (Math.random() * 2 - 1) * CORRIDOR_HALF_X * 0.8,
    LURK_CENTER_Z + (Math.random() * 2 - 1) * LURK_RADIUS * 0.8,
    Math.random() * Math.PI * 2,
  );
}

function beginLurking(pipe: Pipe): void {
  pipe.emerged = false;
  pipe.corridor.boundHalfX = CORRIDOR_HALF_X;
  pipe.corridor.boundCenterZ = LURK_CENTER_Z;
  pipe.corridor.boundHalfZ = LURK_RADIUS;
  pipe.corridor.drift = null; // 목적 없이 서성인다
}

/**
 * 바퀴들을 각자의 관 깊은 곳으로 되돌린다. 세션을 새로 시작할 때마다 부른다.
 *
 * 관마다 고르게 나눈다. 한 관에 여덟 마리를 다 넣으면 거기만 붐비고 나머지
 * 구멍은 끝까지 비어 있다 — 여러 개로 뚫은 이유가 사라진다.
 */
function resetRoaches(): void {
  for (const pipe of pipes) beginLurking(pipe);

  units.forEach((unit, i) => {
    const pipe = pipes[i % pipes.length];
    unit.pipe = pipe;
    unit.surface = pipe.corridor;
    unit.crossing.setPipe(pipe.index);
    scatterInLurk(unit.roach, pipe);
    applySurface(unit);
  });
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

/** 미리보기 콘솔 창구가 면을 이름으로 보여 주려고 두는 표. */
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

/**
 * 이 구멍의 바퀴들이 나오기 시작한다. 구멍마다 따로 깨어난다.
 *
 * 전부 한꺼번에 깨우면 보는 사람이 한 구멍을 들여다보는 동안 등 뒤의 구멍도
 * 이미 쏟아져 있다. 따로 깨우면 돌아설 때마다 한 번씩 더 놀란다.
 */
function beginEmerging(pipe: Pipe): void {
  if (pipe.emerged) return;
  pipe.emerged = true;
  pipe.corridor.boundHalfX = CORRIDOR_HALF_X;
  pipe.corridor.boundCenterZ = -0.12;
  pipe.corridor.boundHalfZ = 0.2;
  pipe.corridor.drift = 0; // 구멍 밖으로
  // 면의 설정을 바꿨으니 지금 그 면에 서 있는 바퀴들에게도 알려 줘야 한다.
  for (const unit of units) {
    if (unit.surface === pipe.corridor) applySurface(unit);
  }
  log(`파이프 ${pipe.index}에서 바퀴가 나오기 시작했다`);
}

for (const pipe of pipes) beginLurking(pipe);

// ---------------------------------------------------------------------------
// 책상
//
// 상판 하나와 옆면 넷. 상판은 네 변 어디로든 넘어갈 수 있고, 옆면은 각각
// 상판과 방 바닥을 잇는다. 한쪽으로 올라가 반대쪽으로 내려오면 바닥으로
// 되돌아오는 고리가 되는데, 모서리를 목록으로 바꾼 게 이걸 위해서다.
// ---------------------------------------------------------------------------
// 스캔이 없는 방을 위한 기본 치수. 감지된 가구가 있으면 그 치수로 바뀐다.
const TABLE_HALF_X = 0.62; // 감지된 책상이 1.25 x 0.73이었다
const TABLE_HALF_Z = 0.36;
const TABLE_HEIGHT = 0.72;

/**
 * 지금 쓰고 있는 책상 치수.
 *
 * 전에는 이게 상수였고, 책상을 포털 앞 45cm에 세웠다. 스캔된 방에서는 그게
 * 진짜 책상과 아무 상관이 없는 자리라, 헤드셋에서는 바퀴가 허공을 타고
 * 올라가는 것으로 보였다 — AR에서는 책상 격자를 끄기 때문에 탈 것이 아예
 * 안 보인다. 이제 감지된 가구 평면을 찾아 거기에 세우고, 치수도 따라간다.
 */
const table = { halfX: TABLE_HALF_X, halfZ: TABLE_HALF_Z, height: TABLE_HEIGHT };

const tableTop = makeWalkSurface(scene);
/** +X, -X, +Z, -Z 순서. 상판의 로컬 축 기준이다. */
const TABLE_SIDE_DIRS = [
  { nx: 1, nz: 0 },
  { nx: -1, nz: 0 },
  { nx: 0, nz: 1 },
  { nx: 0, nz: -1 },
];
const tableSides = TABLE_SIDE_DIRS.map(() => makeWalkSurface(scene));

// 미리보기 창구용 이름표.
pipes.forEach((pipe, i) => SURFACE_NAMES.set(pipe.corridor, `복도${i}`));
SURFACE_NAMES.set(wallFace, '벽면');
SURFACE_NAMES.set(roomFloor, '방바닥');
SURFACE_NAMES.set(tableTop, '상판');
tableSides.forEach((side, i) => SURFACE_NAMES.set(side, `책상옆${i}`));

tableTop.hugEdges = true; // 상판은 머무는 곳이다
// 상판은 원이 아니라 발자국 그대로다. 원으로 두면 네 구석에 못 가고,
// 짧은 쪽 두 변은 원 안쪽 깊숙이 들어가 변이 없는 것처럼 된다.
tableTop.boundHalfX = TABLE_HALF_X;
tableTop.boundHalfZ = TABLE_HALF_Z;

/** 각 옆면에서 방 바닥으로 내려가는 모서리. 치수가 바뀌면 같이 고친다. */
const sideToFloor: SurfaceEdge[] = [];

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
  const [sideEdge, floorEdge] = linkSurfaces(
    side,
    { nx: 0, nz: 1, at: TABLE_HEIGHT, halfWidth: halfAlong },
    roomFloor,
    // 띠는 두지 않는다. 방 바닥에는 책상 발자국만큼의 구멍이 없어서 바퀴가
    // 그 위를 자유롭게 지나다니고, 주촉성 때문에 선에서 한참 떨어진 자리에
    // 머문다. 띠로 잡으려면 늘 '너무 많이 지나간' 상태다.
    // 대신 진행 방향으로 거른다 — 그쪽으로 가고 있을 때만 타고 오른다.
    { nx: 0, nz: 1, at: 0, halfWidth: halfAlong },
  );
  sideToFloor.push(sideEdge);
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
 * 걸어 올라갈 만한 가구.
 *
 * 선반은 뺀다 — 벽에 붙어 있어 바닥까지 닿는 옆면이 없고, 그 밑으로 옆면을
 * 세우면 지금 고치려는 '허공 타고 오르기'를 그대로 다시 만드는 셈이다.
 */
const CLIMBABLE_LABELS = ['table', 'desk', 'couch', 'bed'];
/** 상판이 이 높이 안에 있어야 가구로 친다(m). */
const TABLE_MIN_HEIGHT = 0.2;
const TABLE_MAX_HEIGHT = 1.2;

/** 책상을 세울 가구 평면. 평면 목록이 바뀔 때만 다시 고른다. */
let tablePlane: XRPlane | null = null;
/** 마지막으로 고를 때의 평면 수. 이게 바뀌면 다시 고른다. */
let lastPlaneCount = -1;

/**
 * 책상을 세울 가구 평면을 고른다. 없으면 null.
 *
 * 넓이로만 고르면 안 된다 — 스캔된 방에서 침대가 1.64 x 2.22, 책상이
 * 1.25 x 0.73이라 늘 침대가 뽑힌다. 라벨 순서를 먼저 보고, 같은 라벨이
 * 여럿이면 넓은 쪽을 고른다.
 */
function pickTablePlane(): XRPlane | null {
  for (const label of CLIMBABLE_LABELS) {
    let best: XRPlane | null = null;
    let bestArea = 0;

    for (const plane of planeMeshes.keys()) {
      if (plane.orientation !== 'horizontal') continue;
      if (plane.semanticLabel !== label) continue;

      const rect = boundingRect(plane);
      const area = rect.halfX * rect.halfZ;
      if (area <= bestArea) continue;
      bestArea = area;
      best = plane;
    }
    if (best !== null) return best;
  }
  return null;
}

const furnitureCenter = new THREE.Vector3();
const furnitureFacing = new THREE.Vector3();

/** 고른 가구 평면 위에 책상을 세운다. 세웠으면 true. */
function layOutTableOnFurniture(): boolean {
  // 평면이 늘거나 줄었으면 다시 고른다. 세션 초반에는 몇 초에 걸쳐 들어오고,
  // 책상은 벽보다 늦게 잡히는 일이 흔하다.
  if (planeMeshes.size !== lastPlaneCount || (tablePlane !== null && !planeMeshes.has(tablePlane))) {
    lastPlaneCount = planeMeshes.size;
    const next = pickTablePlane();
    if (next !== tablePlane) {
      tablePlane = next;
      needsRelink = true;
    }
  }

  if (tablePlane === null) return false;
  const mesh = planeMeshes.get(tablePlane);
  if (mesh === undefined) return false;

  const rect = boundingRect(tablePlane);
  mesh.updateMatrixWorld();
  furnitureCenter.set(rect.centerX, 0, rect.centerZ).applyMatrix4(mesh.matrixWorld);
  // 평면은 추적이 다듬어지면서 조금씩 움직인다. 눈에 띄게 움직였을 때만
  // 모서리를 다시 구한다 — 매 프레임 구하면 그게 바로 아까 그 낭비다.
  if (furnitureCenter.distanceToSquared(tableCenter) > 0.02 * 0.02) needsRelink = true;
  // 바닥에 깔린 러그나 천장 근처의 무언가를 책상으로 삼지 않는다.
  if (furnitureCenter.y < TABLE_MIN_HEIGHT) return false;
  if (furnitureCenter.y > TABLE_MAX_HEIGHT) return false;

  // 평면의 로컬 +Z를 상판의 '앞'으로 삼는다. 로컬 X/Z 중 어느 쪽이 어느
  // 변인지는 스펙이 보장하지 않지만, 사각형이라 아무 쪽을 앞으로 잡아도 된다 —
  // 반폭만 그 축에 맞춰 주면 된다.
  furnitureFacing.set(0, 0, 1).transformDirection(mesh.matrixWorld);
  furnitureFacing.y = 0;
  if (furnitureFacing.lengthSq() < 1e-6) return false;
  furnitureFacing.normalize();

  resizeTable(rect.halfX, rect.halfZ, furnitureCenter.y);
  layOutTable(furnitureCenter, furnitureFacing);
  return true;
}

/**
 * 책상 치수를 바꾼다. 범위와 모서리와 격자가 전부 이 셋에 달려 있다.
 *
 * 바뀐 게 없으면 아무것도 안 한다. 매 프레임 불리기 때문이다.
 */
function resizeTable(halfX: number, halfZ: number, height: number): void {
  if (
    Math.abs(halfX - table.halfX) < 0.001 &&
    Math.abs(halfZ - table.halfZ) < 0.001 &&
    Math.abs(height - table.height) < 0.001
  ) {
    return;
  }

  table.halfX = halfX;
  table.halfZ = halfZ;
  table.height = height;

  tableTop.boundHalfX = halfX;
  tableTop.boundHalfZ = halfZ;
  tableRects[0].halfX = halfX;
  tableRects[0].halfZ = halfZ;
  // 격자는 만들 때 크기가 박히므로 배율로 고친다. 디버그용이라 대충이 아니라,
  // 이걸 보고 책상이 제자리에 섰는지 판단하기 때문에 맞아야 한다.
  gridOf.get(tableTop)?.scale.set(halfX / TABLE_HALF_Z, 1, halfZ / TABLE_HALF_Z);

  tableSides.forEach((side, i) => {
    const halfAlong = TABLE_SIDE_DIRS[i].nx !== 0 ? halfZ : halfX;

    side.boundHalfX = halfAlong;
    side.boundCenterZ = height / 2;
    side.boundHalfZ = height / 2;

    sideToFloor[i].at = height;
    sideToFloor[i].halfWidth = halfAlong;
    floorToSide[i].halfWidth = halfAlong;

    const rect = tableRects[i + 1];
    rect.halfX = halfAlong;
    rect.centerZ = height / 2;
    rect.halfZ = height / 2;

    const grid = gridOf.get(side);
    if (grid !== undefined) {
      grid.scale.set((2 * halfAlong) / TABLE_HEIGHT, 1, height / TABLE_HEIGHT);
      grid.position.z = height / 2;
    }
  });

  // 치수가 바뀌었으니 방과 만나는 자리도 다시 구해야 한다.
  needsRelink = true;
  log(`책상 ${(halfX * 2).toFixed(2)}×${(halfZ * 2).toFixed(2)}m 높이 ${height.toFixed(2)}m`);
}

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
    const halfOut = dir.nx !== 0 ? table.halfX : table.halfZ;

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

/** 아래턱 자리를 받아 두는 스크래치. layOutCorridor가 채운다. */
const sillPoint = new THREE.Vector3();

/**
 * 한 파이프의 복도를 그 구멍 자리에 맞춰 세우고, 아래턱 자리를 out에 담는다.
 *
 * 덤으로 portalNormal·portalUp이 그 파이프의 것으로 채워진다. 아래 layOut-
 * Surfaces가 0번 파이프를 마지막에 세우는 건 그 때문이다.
 */
function layOutCorridor(pipe: Pipe, out: THREE.Vector3): void {
  portalNormal.set(0, 0, 1).applyQuaternion(pipe.group.quaternion);
  portalUp.set(0, 1, 0).applyQuaternion(pipe.group.quaternion);

  // 아래턱: 바퀴가 딛고 넘는 선. 복도와 바깥 면이 여기서 만난다.
  // 면과 겹쳐 z-fighting이 나지 않게 법선 쪽으로 1mm 띄운다.
  // 구멍의 맨 밑이 아니라 관 안쪽으로 조금 올라온 '현' 위에 있다.
  // 이유는 CORRIDOR_DROP 주석에.
  out
    .copy(pipe.group.position)
    .addScaledVector(portalUp, -CORRIDOR_DROP)
    .addScaledVector(portalNormal, 0.001);

  // 관 안에서 딛는 면: 등은 아래턱 반대쪽(portalUp)을 보고, +Z가 구멍 밖이다.
  //
  // 벽에 걸린 파이프에서는 portalUp이 월드 위라 '관 바닥을 기어 나온다'가
  // 되고, 바닥이나 천장에 걸리면 관이 수직으로 서서 이 면도 같이 서니
  // '관 벽을 타고 올라온다/내려온다'가 된다. 한 줄이 셋을 다 한다.
  pipe.corridor.node.position.copy(out);
  orientSurface(pipe.corridor.node, portalUp, portalNormal);
  pipe.corridor.node.updateMatrixWorld();
}

/** 면들을 구멍 자리에 맞춰 세운다. 구멍을 옮기면 다시 부른다. */
function layOutSurfaces(): void {
  // 0번은 마지막에 세운다. 아래 계산이 portalNormal·portalUp·sill을 그대로
  // 이어받기 때문이다.
  for (const pipe of pipes) {
    if (pipe !== pipes[0] && pipe.placed) layOutCorridor(pipe, sillPoint);
  }
  // 0번이 안 뚫렸으면 아무것도 안 뚫린 것이다(뚫는 순서가 그렇다).
  if (!pipes[0].placed) return;
  layOutCorridor(pipes[0], sillPoint);
  const sill = sillPoint;

  // 손으로 세운 벽면과 방 바닥은 스캔한 적 없는 방을 위한 대비다. 그때 파이프는
  // 늘 허공에 수직으로 서므로, 아래 계산은 파이프가 수직일 때만 뜻이 있다.
  //
  // 바닥이나 천장에 걸린 파이프에서는 법선이 월드 위아래라, '벽을 타고 아래로'
  // 라는 말이 성립하지 않는다 — orientSurface에 법선과 평행한 힌트를 주게 되고
  // 자세가 NaN이 된다. 그 경우 이 두 면은 세우지 않는다. 감지된 면에 뚫린
  // 파이프는 어차피 linkPipeToHost가 이 둘을 빼 버린다.
  const onWall = Math.abs(portalNormal.y) < 0.5;

  if (onWall) {
    // 벽면: 수직, 등은 방을 보고, +Z가 벽을 타고 아래로 간다.
    // 직진하던 바퀴가 각도를 바꾸지 않고 그대로 벽을 타도록 하는 배치다.
    wallFace.node.position.copy(sill);
    orientSurface(wallFace.node, portalNormal, WORLD_DOWN);

    // 방 바닥: 수평, +Z가 벽에서 멀어지는 쪽.
    // 원점은 벽이 바닥과 만나는 선 위, 아래턱 바로 밑이다. 벽면과 로컬 X를
    // 공유하므로(둘 다 up × 법선) 모서리를 넘을 때 x가 그대로 보존된다.
    // local-floor 기준 공간이라 진짜 바닥이 y = 0이다.
    roomFloor.node.position.set(sill.x, 0, sill.z);
    roomFloor.node.position.addScaledVector(portalNormal, 0.001);
    orientSurface(roomFloor.node, WORLD_UP, portalNormal);
  }

  // 아래턱에서 바닥까지의 거리. 벽면의 로컬 +Z가 아래를 향하므로 그대로 쓴다.
  // 파이프를 아주 낮게 걸면 내려갈 벽이 없다. 그때는 모서리를 닫는다.
  const dropHeight = onWall ? sill.y : 0;
  wallToFloor.at = dropHeight;
  wallToFloor.halfWidth = dropHeight > 0.05 ? Infinity : 0;
  // 벽면은 포털보다 양옆으로 조금 더 넓다. 바퀴가 구멍 옆 벽으로도 번진다.
  wallFace.boundHalfX = PIPE_BORE / 2 + 0.2;
  wallFace.boundCenterZ = dropHeight / 2;
  wallFace.boundHalfZ = dropHeight / 2;
  // 사각형의 -Z 변이 곧 아래턱 선이다. 그 위는 벽이 아니라 구멍이라, 구멍 폭
  // 안쪽만 열어 둔다 — 거기로는 복도로 되돌아 들어가고, 그 밖은 막힌 벽이다.
  wallFace.boundGapHalfWidth = PIPE_BORE / 2;

  for (const surface of [wallFace, roomFloor]) {
    surface.node.updateMatrixWorld();
  }

  // 감지된 가구가 있으면 거기에 세운다. 없을 때만 구멍 앞에 지어낸다 —
  // 스캔한 적 없는 방에서도 올라갈 것이 하나는 있어야 한다.
  if (!layOutTableOnFurniture()) {
    // 책상을 밀어낼 방향. 벽이면 법선이 곧 '방 쪽'이지만, 바닥이나 천장에
    // 뚫린 파이프에서는 법선이 위아래라 책상이 허공에 뜬다. 그때는 면 안에
    // 누운 축(portalUp)을 쓴다.
    awayDir.copy(onWall ? portalNormal : portalUp);
    awayDir.y = 0;
    if (awayDir.lengthSq() < 1e-4) awayDir.set(0, 0, 1);
    awayDir.normalize();

    tablePoint
      .set(sill.x, table.height, sill.z)
      .addScaledVector(awayDir, table.halfZ + 0.45);
    layOutTable(tablePoint, awayDir);
  }

  // 방과 다시 잇는 건 여기서 하지 않는다. 이 함수는 포털을 놓은 뒤 매 프레임
  // 도는데(바퀴가 면의 자세를 읽기 전에 자리를 맞춰야 한다), 거기에 모서리
  // 재생성을 붙여 두면 스물네 개를 매 프레임 다시 만들게 된다.
  //
  // 깃발도 여기서 세우지 않는다 — 여기서 세우면 매 프레임 서는 것이라 결국
  // 같다. 포털을 놓을 때(placePortal), 평면이 늘었을 때, 책상이 움직였을 때
  // 각자 세운다.
}

/**
 * 복도 바닥과 책상이 옮겨 갔으니 방과 만나는 자리를 다시 구해야 하는지.
 *
 * 포털을 놓을 때와 평면이 처음 들어올 때만 참이 된다.
 */
let needsRelink = false;


// [미리보기 전용] 걸음이 미끄러지는지, 모서리를 어떻게 넘는지 보려면 면에
// 무늬가 있어야 한다. 포털이 만드는 면마다 하나씩. 세션 안에서는 끈다 —
// 거기서는 진짜 벽과 책상이 보이니 무늬가 필요 없다.
/**
 * 면 → 그 면의 격자.
 *
 * 전에는 surfaceGrids[3], surfaceGrids[4 + i] 처럼 번호로 집었다. 복도가 하나일
 * 때만 맞는 번호였고, 파이프가 셋이 되자 상판 격자를 고치려던 코드가 손으로
 * 세운 벽면의 격자를 고쳤을 것이다. 번호로 집는 것을 그만둔다.
 */
const gridOf = new Map<WalkSurface, THREE.GridHelper>();

const surfaceGrids = [
  ...pipes.map((pipe) => ({ surface: pipe.corridor, size: 0.4, offsetZ: -0.2, stretchX: 1 })), // 아래턱 안쪽
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
  gridOf.set(surface, grid);
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
/** 책상이 방과 만나는 자리를 구할 때 쓰는 사각형들. 치수가 바뀌면 고친다. */
const tableRects: JoinRect[] = [
  { surface: tableTop, halfX: TABLE_HALF_X, centerZ: 0, halfZ: TABLE_HALF_Z },
  ...tableSides.map((side, i) => ({
    surface: side,
    halfX: TABLE_SIDE_DIRS[i].nx !== 0 ? TABLE_HALF_Z : TABLE_HALF_X,
    centerZ: TABLE_HEIGHT / 2,
    halfZ: TABLE_HEIGHT / 2,
  })),
];

const roomShell = makeRoomShell(scene, tableRects);

/**
 * 딛고 있던 면이 사라진 바퀴를 바닥으로 옮긴다.
 *
 * 면을 버리면 그 노드가 씬에서 떨어져 나간다. 그 위에 서 있던 바퀴는 노드에
 * 매달린 채 함께 딸려 나가 화면에서 그냥 사라지고, 다시는 돌아오지 않는다 —
 * 가리키는 면이 이미 씬 밖이라 모서리를 넘을 수도 없다.
 *
 * 살아 있는 바닥으로 내려놓는다. 갑자기 자리가 바뀌는 건 어쩔 수 없지만,
 * 사라지는 것보다는 낫다.
 *
 * 바닥까지 함께 사라졌으면 복도로 보낸다. 손으로 세운 방 바닥은 감지된 방을
 * 쓰기 시작할 때 그래프에서 빠져서 모서리가 하나도 없다 — 거기 내려놓으면
 * 보이기는 해도 영영 갇힌다. 복도는 늘 살아 있고 늘 이어져 있다. 포털로
 * 도로 들어간 것으로 보이고, 조금 뒤 다시 나온다.
 */
function rescueFrom(gone: ShellSurface[]): void {
  const lost = new Set(gone.map((shell) => shell.surface));

  for (const unit of units) {
    if (!lost.has(unit.surface)) continue;

    const floor = roomShell.surfaces.find((shell) => shell.label === 'floor');
    const landing = floor?.surface ?? unit.pipe.corridor;
    unit.surface = landing;
    unit.roach.placeOn(
      landing.node,
      0,
      landing.boundCenterZ,
      Math.random() * Math.PI * 2,
    );
    applySurface(unit);
    log(`${units.indexOf(unit)}번 딛던 면이 사라져 바닥으로 옮김`);
  }
}

const wallLocal = new THREE.Vector3();

/** 손으로 세운 벽면·방 바닥을 이미 뺐는지. 한 번만 하면 된다. */
let fallbackRetired = false;

/**
 * 이 파이프가 어느 감지된 면에 뚫려 있는지. 아니면 null.
 *
 * 뚫린 면은 파이프마다 다르다. '벽'이 아니라 '면'이다 — 바닥이나 천장일 수도
 * 있고, 두 파이프가 같은 면을 쓸 수도 있다.
 */
function findPipeHost(pipe: Pipe): ShellSurface | null {
  let best: ShellSurface | null = null;
  let bestGap = 0.08; // 면에서 이보다 멀면 그 면에 뚫린 게 아니다(m)

  for (const shell of roomShell.surfaces) {
    shell.surface.node.updateMatrixWorld();
    wallLocal.copy(pipe.group.position);
    shell.surface.node.worldToLocal(wallLocal);

    const gap = Math.abs(wallLocal.y);
    if (gap >= bestGap) continue;
    // 평면에는 끝이 있다. 구멍이 그 사각형 밖이면 다른 면이다.
    if (Math.abs(wallLocal.x) > shell.width / 2) continue;
    if (Math.abs(wallLocal.z) > shell.depth / 2) continue;

    bestGap = gap;
    best = shell;
  }
  return best;
}

/**
 * 복도를 파이프가 뚫린 진짜 면에 잇고, 손으로 세운 벽면·방 바닥을 뺀다.
 *
 * 벽면과 방 바닥은 같은 자리를 두 번 적은 것이다 — 손으로 세운 벽면은 파이프가
 * 뚫린 진짜 면과 겹치고, 방 바닥은 진짜 바닥과 겹친다. 스캔한 적이 없는 방을
 * 위한 대비일 뿐이라, 진짜가 들어오면 물러난다. 남겨 두면 복도에서 나가는
 * 모서리가 둘이 되어 어느 면으로 나가는지가 목록 순서에 달린다.
 *
 * 모서리의 법선은 파이프의 로컬 +Y를 그 면에 눕힌 것이다 — 아래턱을 그 쪽으로
 * 넘어서면 구멍 안으로 들어가는 것이다. 벽이면 '위로 넘어서면'이 되고, 바닥에
 * 뚫렸으면 '아래턱 반대쪽으로 넘어서면'이 된다. 같은 한 줄이다.
 */
function linkPipeToHost(pipe: Pipe): void {
  const shell = findPipeHost(pipe);
  if (shell === null) return;

  // 전에 이어 둔 게 있으면 걷어낸다. 파이프를 다시 뚫으면 자리가 바뀐다.
  for (const { surface, edge } of pipe.link) {
    const at = surface.edges.indexOf(edge);
    if (at >= 0) surface.edges.splice(at, 1);
  }
  pipe.link = [];

  const previous = pipe.host;
  const changed = previous !== shell.surface;
  pipe.host = shell.surface;

  // 전에 쓰던 면에 심어 둔 '아래로'를 걷는다. 그대로 두면 파이프가 옮겨 간
  // 뒤에도 그 면의 바퀴들이 계속 한쪽으로만 내려간다.
  //
  // 다른 파이프가 아직 그 면을 쓰고 있으면 걷지 않는다. 구멍이 여럿이라
  // 같은 벽을 둘이 나눠 쓰는 일이 실제로 생긴다.
  if (changed && previous !== null && !pipes.some((other) => other.host === previous)) {
    previous.drift = null;
    previous.hugEdges = true;
  }
  pipe.host.node.updateMatrixWorld();

  // 아래턱 위의 한 점과, 거기서 구멍 쪽으로 가는 방향을 면의 로컬 2D로 옮긴다.
  wallLocal.copy(pipe.corridor.node.position);
  pipe.host.node.worldToLocal(wallLocal);
  portalUp
    .set(0, 1, 0)
    .applyQuaternion(pipe.group.quaternion)
    .transformDirection(wallInverse.copy(pipe.host.node.matrixWorld).invert());

  const length = Math.hypot(portalUp.x, portalUp.z);
  if (length < 1e-6) return;
  const nx = portalUp.x / length;
  const nz = portalUp.z / length;

  const [corridorEdge, wallEdge] = linkSurfaces(
    pipe.corridor,
    { nx: 0, nz: 1, at: 0 },
    pipe.host,
    {
      nx,
      nz,
      at: wallLocal.x * nx + wallLocal.z * nz,
      alongCenter: -wallLocal.x * nz + wallLocal.z * nx,
      // 구멍 폭만큼만 열려 있다. 그 밖은 막힌 벽이다.
      halfWidth: PIPE_BORE / 2,
      // 아래턱을 넘어서는 것 = 구멍 안으로 들어가는 것이다. 구경만큼만 본다 —
      // 띠가 없으면 구멍보다 한참 떨어진 데를 기어가는 바퀴까지 '넘어섰다'로
      // 잡혀 허공에서 복도로 빨려 들어간다.
      band: PIPE_BORE,
    },
  );
  pipe.link = [
    { surface: pipe.corridor, edge: corridorEdge },
    { surface: pipe.host, edge: wallEdge },
  ];

  // 감지된 면이 들어왔으니 손으로 세운 것들은 물러난다. 한 번만 하면 된다 —
  // 파이프가 여럿이라, 매번 하면 나중에 이어진 모서리까지 같이 쓸어낸다.
  if (fallbackRetired) return;
  fallbackRetired = true;
  const retired = new Set<WalkSurface>([wallFace, roomFloor]);
  for (const surface of [...corridors, tableTop, ...tableSides]) {
    surface.edges = surface.edges.filter((edge) => !retired.has(edge.to));
  }
  wallFace.edges = [];
  roomFloor.edges = [];
  log('감지된 벽·바닥으로 간다 — 손으로 세운 벽면·방 바닥은 뺐다');
}

const wallDown = new THREE.Vector3();
const wallInverse = new THREE.Matrix4();

/**
 * 파이프가 뚫린 면이 벽이면 '아래로'라는 목적을 준다.
 *
 * 손으로 세운 벽면은 로컬 +Z가 아래를 향하도록 세워 두고 drift = 0을 줬다.
 * 감지된 벽은 자세를 런타임이 정하므로 그 요령이 통하지 않는다. 월드의 아래
 * 방향을 면 안으로 눕혀서 heading으로 적는다.
 *
 * 이게 없으면 바퀴가 구멍에서 나와 3m × 2.4m 벽 위를 목적 없이 떠돈다.
 * 실제로 그랬다 — 여덟 마리가 다 나왔는데 75초 동안 아무도 바닥에 못 닿았다.
 *
 * 바닥과 천장에는 '아래'가 없다. 월드 아래를 눕히면 거의 0이 되어 방향이
 * 수치 오차로 결정된다 — 바퀴 여덟 마리가 난수 방향으로 줄지어 간다. 그런
 * 면은 껍데기 기본값(목적 없이 가장자리 살피기) 그대로 둔다. 그게 나온 뒤의
 * 행동으로도 맞다.
 *
 * 매 프레임 다시 구한다. 면이 하나 더 들어오면 법선 판정이 뒤집힐 수 있고,
 * 뒤집히면 로컬 '아래'도 함께 돌아간다.
 *
 * 올라온 바퀴까지 다시 내려보내지는 않는다. 모서리를 넘을 때, 들어온 방향이
 * 그 면의 drift와 반대면 그 바퀴의 목적지는 지워지기 때문이다.
 */
function aimHostsDown(): void {
  for (const pipe of pipes) {
    const host = pipe.host;
    if (host === null) continue;
    host.node.updateMatrixWorld();
    wallInverse.copy(host.node.matrixWorld).invert();
    wallDown.set(0, -1, 0).transformDirection(wallInverse);

    // 면 안에 누운 길이가 0.3보다 짧으면 수평에서 17° 안쪽이다.
    if (wallDown.x * wallDown.x + wallDown.z * wallDown.z < 0.09) {
      host.drift = null;
      host.hugEdges = true;
      continue;
    }
    host.drift = Math.atan2(wallDown.x, wallDown.z);
  }
}


/** 껍데기 면에 깔아 둔 격자들. 손바닥 패널에서 껐다 켠다. */
const shellGrids: THREE.GridHelper[] = [];
/**
 * 기본은 꺼 둔다. 감지된 방의 면은 진짜 벽·바닥 위에 겹쳐 있어서, 켜 두면
 * 방 전체에 격자가 덮인다. 어디까지 걸을 수 있는지 보고 싶을 때만 켠다.
 */
let showGrids = false;

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
  crossing: PipeCrossing;
  surface: WalkSurface;
  /**
   * 어느 관에서 나온 놈인지.
   *
   * 자르는 평면과 스텐실 번호가 파이프마다 다르므로, 복도를 옮겨 타면
   * 복사본에게도 알려 줘야 한다 — 안 알려 주면 그 바퀴가 통째로 사라진다.
   */
  pipe: Pipe;
}

/** 몇 마리나 둘지. 드로우콜을 재 보려고 올려 둔 값이기도 하다. */
const ROACH_COUNT = 8;

/** 이 거리 안에 다른 바퀴가 있으면 서로 비킨다(m). 몸길이의 두 배쯤. */
const SEPARATION = 0.08;

const units: RoachUnit[] = [];

// 부품을 조합별로 묶어 그린다. 등록한 메시는 숨겨지고, 모양은 인스턴스가 낸다.
const roachBatch = makeInstanceBatch(scene);

for (let i = 0; i < ROACH_COUNT; i += 1) {
  const roach = makeRoach();
  // 관마다 고르게 나눈다. 여기서 정한 것은 resetRoaches가 다시 정한다.
  const pipe = pipes[i % pipes.length];

  // 복도 깊은 곳에 흩어 둔다. 줄 세워 놓으면 한눈에 '배치했구나' 싶어진다.
  scatterInLurk(roach, pipe);
  roach.setExitZ(forwardExitOf(pipe.corridor));
  roach.setBounds(
    pipe.corridor.boundHalfX,
    pipe.corridor.boundCenterZ,
    pipe.corridor.boundHalfZ,
    pipe.corridor.boundGapHalfWidth,
  );
  roach.setDrift(pipe.corridor.drift);
  roach.setHugEdges(pipe.corridor.hugEdges);

  // 바퀴를 두 벌로 나눈다. roach.root는 '바깥 복사본'이 되고, 같은 자세를
  // 따라가는 '안쪽 복사본'이 옆에 생긴다.
  const crossing = makePipeCrossing(roach.root);
  crossing.setPipe(pipe.index);
  units.push({ roach, crossing, surface: pipe.corridor, pipe });

  // 두 벌 모두 배칭에 넘긴다. 안쪽은 재질이 달라 따로 묶인다.
  roachBatch.register(roach.root);
  roachBatch.register(crossing.inside);
}

// 파이프는 여기서 놓지 않는다. 전에는 데스크톱 미리보기용으로 눈앞 1.3m에
// 하나 박아 두고 placePortal()을 바로 불렀다. 자리를 사람이 고르던 때라
// 미리보기에서 구멍을 보려면 그 수밖에 없었다.
//
// 이제는 자리를 코드가 고른다. 그러면 미리보기도 그 고르는 코드를 통과해야
// 한다 — 박아 두면 가짜 방 평면 위에 뚫는 길이 데스크톱에서 한 번도 안 돌고,
// 벽·바닥·천장 중 뭘 집는지, 아래턱을 어디로 두는지 볼 수가 없다.
// 렌더 루프의 tryPlacePipe가 가짜 방 평면이 들어온 첫 프레임에 뚫는다.

// [미리보기 전용] 첫 프레임까지의 기본 시점. 구멍이 뚫리면 aimPreviewCamera가
// 그 앞으로 데려간다. 세션에서는 헤드셋 포즈가 덮어쓴다.
camera.position.set(1.7, 1.9, 0.7);
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

/**
 * 가짜 방 평면을 먹일지. immersive-ar이 안 되는 기기에서만 켠다.
 *
 * 가짜 방은 헤드셋 없이 이 코드가 돌게 하려고 둔 발판이다. 그런데 헤드셋에서도
 * 세션에 들어가기 전까지는 frame이 없어서 그대로 돌았고, 가짜 평면으로 면을
 * 만들고 그 면을 진짜로 치고 대비용 벽면·방 바닥을 그래프에서 빼 버렸다.
 * 세션에 들어가면 가짜 평면은 사라지지만 빼 버린 건 돌아오지 않는다 —
 * 스캔한 적 없는 방에서는 바퀴가 포털에서 나와 갈 데가 없어진다.
 *
 * 지원 여부를 알기 전까지는 꺼 둔다. 그 몇 프레임이 틀리는 것보다 헤드셋에
 * 가짜 방이 한 프레임이라도 서는 편이 나쁘다.
 */
let useFakeRoom = false;

/** 패널이 한 번이라도 터졌는지. 그 뒤로는 손대지 않는다. */
let panelFailed = false;

/** 지금까지 짜부러진 마리 수와, 마지막으로 먹힌 때림의 세기. 패널에 적는다. */
let squashed = 0;
let lastSmash = '';

/** 화면 갱신율. 매 프레임 출렁여서 천천히 따라가게 둔다. */
let fps = 0;

/**
 * 잡힌 평면을 라벨별로 센 것. 'wall 4 · door 2'처럼.
 *
 * 스캔된 방은 라벨이 열 가지씩 나온다. 한 줄에 다 넣으면 글자가 깨알이 되니
 * 다섯씩 끊어 여러 줄로 돌려준다.
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
  for (let i = 0; i < parts.length; i += 5) rows.push(parts.slice(i, i + 5).join(' · '));
  return rows;
}

/** 손가락 끝이 이 거리 안으로 들어오면 건드린 것으로 친다(m). */
const TOUCH_RADIUS = 0.05;
/**
 * 손바닥이 면을 이만큼 마주 봐야 때린 것으로 친다(법선 내적).
 *
 * 0.5면 60°쯤. 손날로 치거나 비스듬히 스치는 것까지 받아 주면 다시 헐거워진다.
 */
const SMASH_FACING = 0.5;

/** 면에서 이만큼 떨어진 손가락은 아직 닿지 않은 것이다(m). */
const TOUCH_HEIGHT = 0.07;

/** 최근 최고 속력이 이보다 빨랐어야 내려친 것으로 친다(m/s). */
const SMASH_SPEED = 1.4;
/** 내려칠 때 손바닥이 면에서 이 거리 안이어야 한다(m). */
const SMASH_HEIGHT = 0.07;
/** 손바닥에 깔리는 범위(m). */
const SMASH_RADIUS = 0.09;

const tipLocal = new THREE.Vector3();
const palmLocal = new THREE.Vector3();
const palmVelocityLocal = new THREE.Vector3();
const surfaceQuat = new THREE.Quaternion();
const surfaceNormal = new THREE.Vector3();
let handsSeen = false;

/** 손가락 끝에 닿은 바퀴를 놀래킨다. */
function applyTouches(hands: TrackedHand[]): void {
  for (const hand of hands) {
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
function applySmashes(hands: TrackedHand[]): void {
  for (const hand of hands) {
    if (!hand.tracked) continue;

    // 때리는 건 손바닥으로만 친다.
    //
    // 처음에는 손가락 끝 다섯 개도 접촉점으로 넣었다. 손바닥 중심이 손가락보다
    // 한참 뒤에 있어서 그러지 않으면 안 맞는다고 봤는데, 그 때문에 손가락
    // 하나를 갖다 대는 것도 때린 게 됐다. 손바닥이 면을 보는지까지 따져도
    // 마찬가지였다 — 바닥의 벌레를 손가락으로 찌를 때도 손바닥은 아래를 본다.
    //
    // 내려칠 때는 손바닥이 벌레 위로 온다. 찌를 때는 손바닥이 한 뼘 뒤에 남는다.
    // 접촉점을 손바닥 하나로 되돌리고, 대신 닿았다고 보는 거리를 조금 넓혔다.
    for (const point of [hand.palm]) {
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

        // ── 손바닥이 면을 마주 봐야 한다 ──
        //
        // 접촉은 손바닥과 손가락 끝 여섯 점을 다 본다. 사람은 벌레를 손가락
        // 쪽으로 겨냥해 때리니까 그래야 맞는다. 그런데 그 여섯 점만 보면
        // 손가락 하나를 갖다 대는 것도 때린 것이 된다 — 헤드셋에서 실제로
        // 그렇게 죽었다.
        //
        // 때리는 것과 찌르는 것의 차이는 손의 자세다. 내려칠 때 손바닥은 면을
        // 마주 보고, 손가락으로 가리킬 때는 아니다. 손바닥 법선을 이미 읽고
        // 있으니(디버그 패널이 쓴다) 그걸로 가른다.
        node.getWorldQuaternion(surfaceQuat);
        surfaceNormal.set(0, 1, 0).applyQuaternion(surfaceQuat);
        const facing = hand.palmNormal.dot(surfaceNormal);
        if (facing > -SMASH_FACING) continue;

        // 속도는 방향만 바꾼다 — 위치처럼 원점을 빼면 안 된다.
        palmVelocityLocal.copy(hand.palmVelocity).applyQuaternion(surfaceQuat.invert());
        // 지금은 '면 쪽으로 가고 있다'만 본다. 세기는 최근 최고 속력으로 가른다.
        if (palmVelocityLocal.y > 0) continue;
        if (hand.peakSpeed < SMASH_SPEED) continue;

        unit.roach.squash();
        squashed += 1;
        // 때린 세기는 패널에 적는다. 기기에서 기준을 다시 맞출 때 쓴다.
        lastSmash = `${hand.peakSpeed.toFixed(1)}m/s · ${(-facing).toFixed(2)}`;
      }
    }
  }
}

const viewerPosition = new THREE.Vector3();
/** 자르는 평면이 놓일 자리(월드). 포털이 아니라 벽 위다. */
const portalPlanePoint = new THREE.Vector3();
/** 가짜 손을 눈앞에 세우는 데 쓴다. 미리보기 전용. */
const viewerQuaternion = new THREE.Quaternion();
/** 위 값을 면 로컬로 옮긴 것. 마리마다 면이 달라 매번 다시 만든다. */
const viewerLocal = new THREE.Vector3();
const viewerForward = new THREE.Vector3();
const toPortal = new THREE.Vector3();

// 데스크톱에서 놀라는 걸 확인하려면 누를 데가 있어야 한다. 미리보기 카메라는
// 가만히 있어서 '다가옴'이 영영 일어나지 않는다.
renderer.domElement.addEventListener('pointerdown', () => {
  // 미리보기 카메라는 움직이지 않아서 '다가옴'이 일어나지 않는다.
  // 첫 클릭은 바퀴를 불러내고, 그 뒤로는 놀래킨다.
  const asleep = pipes.filter((pipe) => pipe.placed && !pipe.emerged);
  if (asleep.length > 0) for (const pipe of asleep) beginEmerging(pipe);
  else for (const unit of units) unit.roach.scare(viewerPosition.x, viewerPosition.z);
});

// ---------------------------------------------------------------------------
// 8) 렌더 루프
//    requestAnimationFrame이 아니라 renderer.setAnimationLoop을 쓴다.
//    XR 세션 중에는 프레임 타이밍의 주인이 브라우저 창이 아니라 XRSession이고,
//    three.js가 세션 유무에 따라 둘을 알아서 갈아끼운다.
// ---------------------------------------------------------------------------
// setAnimationLoop의 콜백은 (시간, XRFrame)을 받는다. frame은 XR 세션 중에만
// 들어오고, 세션 밖에서는 undefined다.
let lastFrameTime = 0;

/**
 * 한 프레임의 '계산'. 그리는 건 아래 renderFrame이 한다.
 *
 * 둘로 나눈 이유는 renderFrame의 주석에 있다. 이름을 붙여 둔 건 tick 창구가
 * 이걸 손으로 돌리기 때문이다.
 */
function stepFrame(time: DOMHighResTimeStamp, frame?: XRFrame): void {
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
  const fake = frame === undefined && useFakeRoom;
  const shellFrame = frame ?? fakeRoomFrame;
  const shellSpace = fake ? fakeRoomSpace : renderer.xr.getReferenceSpace();

  // 평면 메시를 먼저 갱신한다. 책상을 올릴 가구가 이 메시를 읽는다 —
  // 뒤에 두면 늘 한 프레임 묵은 자세를 본다.
  // 가짜 방도 함께 먹인다. 세션 밖에서 안 돌면 '평면' 버튼이 무엇을 켜고
  // 끄는지 데스크톱에서 볼 수가 없다.
  if (shellSpace !== null) updatePlanes(shellFrame, shellSpace);
  if (shellSpace !== null) {
    const newShells = roomShell.sync(shellFrame, shellSpace, viewerPosition);
    if (roomShell.removed.length > 0) rescueFrom(roomShell.removed);
    // 평면이 늘었다. 파이프가 뚫린 면이 이제야 들어왔을 수 있다.
    //
    // 'pipeHost가 아직 null이면'으로 두면 안 된다 — 스캔한 적 없는 방에서는
    // 영영 null이라, 매 프레임 모서리를 다시 세우게 된다.
    if (newShells.length > 0) needsRelink = true;

    for (const shell of newShells) {
      addShellGrid(shell);
      // 미리보기 창구에서 읽을 수 있게 이름을 붙여 둔다.
      SURFACE_NAMES.set(shell.surface, `${shell.label}${SURFACE_NAMES.size}`);
      log(
        `껍데기 면 ${shell.label} ${shell.width.toFixed(2)}×${shell.depth.toFixed(2)}m` +
          `${shell.flipped ? ' (법선 뒤집음)' : ''}` +
          ` · 면 ${roomShell.surfaces.length}개 모서리 ${roomShell.edgeCount}개`,
      );
    }
    // 파이프가 뚫린 면은 평면이 들어온 뒤에야 알 수 있다. 찾을 때까지 매 프레임
    // 두드린다 — 찾으면 pipe.host가 차고, 그 뒤로는 바로 빠져나온다.

    aimHostsDown();
  }

  // 구멍을 뚫는다. 감지된 면이 하나라도 들어와 있어야 하므로 껍데기 갱신
  // 뒤이고, 바퀴가 면의 자세를 읽기 전이어야 하므로 바퀴 갱신 앞이다.
  {
    const before = placedCount;
    tryPlacePipes(viewer, time);
    // [미리보기 전용] 뚫린 자리가 난수다. 카메라를 첫 구멍 앞으로 데려간다.
    if (before === 0 && placedCount > 0 && frame === undefined) aimPreviewCamera();
  }

  // 아직 복도에 있고, 사람이 가까이서 그 구멍 쪽을 보고 있으면 이제 나온다.
  // 구멍마다 따로 본다 — 등 뒤의 구멍은 돌아설 때 깨어난다.
  viewer.getWorldDirection(viewerForward);
  for (const pipe of pipes) {
    if (!pipe.placed || pipe.emerged) continue;
    toPortal.subVectors(pipe.group.position, viewerPosition);
    const distance = toPortal.length();
    if (distance >= EMERGE_DISTANCE || distance <= 1e-3) continue;
    if (viewerForward.angleTo(toPortal.divideScalar(distance)) < EMERGE_VIEW_ANGLE) {
      beginEmerging(pipe);
    }
  }

  if (frame !== undefined) {
    const handSpace = renderer.xr.getReferenceSpace();
    if (handSpace !== null) handTracker.update(frame, handSpace, dt);
  }

  // ── 손 ──
  //
  // 세션 밖에서는 가짜 손을 먹인다. 손 추적은 XR에만 와서, 이게 없으면 손을
  // 쓰는 코드가 데스크톱에서 한 줄도 안 돈다 — 패널도, 건드리기도, 때리기도.
  // 때리기는 '얼마나 빨라야 때린 것인가'를 가르는 코드라 더더욱 돌려 봐야
  // 한다. 가짜 방 평면과 같은 발판이고, 같은 규칙으로 켠다.
  let hands = handTracker.hands;
  if (frame === undefined && useFakeRoom) {
    viewer.getWorldQuaternion(viewerQuaternion);
    updateFakeHands(viewerPosition, viewerQuaternion);
    hands = fakeHands;
  }

  applyTouches(hands);
  applySmashes(hands);

  if (dt > 0) fps += (1 / dt - fps) * Math.min(1, dt * 3);

  // 글자는 패널이 보일 때만 만든다. 늘 만들면 문자열과 배열이 매 프레임
  // 버려지고, VR에서는 그 쓰레기가 모였다 터질 때 프레임이 튄다. 보이기
  // 시작한 첫 프레임만 직전 내용을 쓰는데, 그건 눈에 안 보인다.
  // 패널은 renderer.render보다 앞에 있다. 여기서 터지면 그 프레임이 통째로
  // 안 그려지고, 매 프레임 터지면 AR에서는 패스스루만 남는다. 들여다보는
  // 도구가 작품을 지울 수 있으면 안 된다 — 터지면 패널만 끈다.
  if (!panelFailed) {
    try {
      if (debugPanel.group.visible) {
        // 렌더 비용은 직전 프레임 것이다. 이 줄이 renderer.render보다 앞이라
        // 그렇고, 한 프레임 묵은 숫자로 충분하다.
        const cost = renderer.info.render;
        debugPanel.setLines([
          `${fps.toFixed(0)} fps · 드로우콜 ${cost.calls} · 삼각형 ${cost.triangles}`,
          `평면 ${planeMeshes.size} · 껍데기 ${roomShell.surfaces.length}면` +
            ` · 모서리 ${roomShell.edgeCount}`,
          `짜부 ${squashed}마리${lastSmash === '' ? '' : ` (마지막 ${lastSmash})`}`,
          // 파이프가 어디에 뚫렸는지. 자리를 코드가 고르게 된 뒤로는, 헤드셋에서
          // 뭔가 이상할 때 제일 먼저 알아야 하는 값이 이것이다.
          `파이프 ${placedCount === 0 ? '아직' : pipes.filter((p) => p.placed).map((p) => p.hostLabel).join(' · ')}` +
            `${frameFailures > 0 ? ` · 프레임 터짐 ${frameFailures}회: ${lastFrameError}` : ''}`,
          ...planeSummary(),
        ]);
      }
      debugPanel.update(hands, viewerPosition);
    } catch (error) {
      panelFailed = true;
      debugPanel.group.visible = false;
      log(`디버그 패널을 껐다: ${error instanceof Error ? error.message : String(error)}`);
    }
  }


  // ── 서로 비키기 ──
  //
  // 같은 면 위에 있는 짝만 본다. 벽에 붙은 놈과 바닥에 있는 놈은 로컬 좌표가
  // 같아도 월드에서는 떨어져 있다. 여덟 마리면 짝이 스물여덟이라 그냥 다 센다.
  for (let i = 0; i < units.length; i += 1) {
    for (let j = i + 1; j < units.length; j += 1) {
      const a = units[i];
      const b = units[j];
      if (a.surface !== b.surface) continue;
      // 관처럼 좁은 데서는 비키지 않는다. 이유는 AVOID_MIN_HALF_X 주석에.
      if (a.surface.boundHalfX < AVOID_MIN_HALF_X) continue;
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

    unit.roach.update(dt, 1, viewerLocal);

    // ── 관 벽은 진짜 벽이다 ──
    //
    // 다른 면의 경계는 '되도록 넘지 않는' 성향이다. 가장자리를 따라가되 가끔
    // 넘어서 보는 그 성향이 주촉성의 핵심이고, 면과 면 사이를 넘어가는 길이기도
    // 하다. 그래서 경계는 조향일 뿐 울타리가 아니다.
    //
    // 복도에서만은 그게 통하지 않는다. 반폭이 4.2cm인데 바퀴 걸음이 0.2m/s다 —
    // 흩어 놓을 때 받은 방향이 옆쪽이면 조향이 돌려세우기 전에 이미 나가 있고,
    // 한 번 나가면 바깥에서 벽과 나란히 계속 걷는다. 축에서 20cm까지 나간 놈이
    // 있었다. 관 반지름의 세 배다.
    //
    // 옆으로는 넘을 곳이 없다 — 넘으면 관 밖, 즉 벽 속이다. 못 넘게 한다.
    if (corridors.has(unit.surface)) {
      const x = unit.roach.root.position.x;
      if (x > CORRIDOR_HALF_X) unit.roach.root.position.x = CORRIDOR_HALF_X;
      else if (x < -CORRIDOR_HALF_X) unit.roach.root.position.x = -CORRIDOR_HALF_X;
    }

    // 짜부러진 놈은 그 자리에 그대로 둔다.
    if (unit.roach.isSquashed()) continue;

    // 모서리를 넘었으면 다음 면으로 옮긴다.
    const next = transferIfCrossed(unit.roach, unit.surface);
    if (next !== unit.surface) {
      // 구멍에서 막 나왔다. 아래턱은 면 한가운데에 있어서, 모서리를 넘을 때
      // 쓰는 '새 면 안쪽' 기준이 구멍 위쪽을 가리킨다 — 그대로 두면 나온 바퀴가
      // 구멍 위 벽을 기어오른다. 손으로 세운 벽면은 사각형이 통째로 아래에
      // 있어서 이 문제가 없었다. 여기서는 방향을 못박는다.
      //
      // 바닥·천장에 뚫린 파이프에서는 drift가 null이라 이 줄이 통째로 건너
      // 뛰어진다. 그 면에는 '아래'가 없으니 방향을 못박을 것도 없다.
      if (unit.surface === unit.pipe.corridor && next === unit.pipe.host && next.drift !== null) {
        unit.roach.setHeading(next.drift);
        unit.roach.setDrift(next.drift);
      }

      // 다른 관으로 기어들어 갔으면 복사본에게도 알려 준다. 안 알려 주면
      // 바깥 복사본은 그 관의 평면에, 안쪽 복사본은 제 관의 평면에 잘려
      // 양쪽에서 빠진다 — 바퀴가 통째로 사라진다.
      const entered = pipes.find((pipe) => pipe.corridor === next);
      if (entered !== undefined && entered !== unit.pipe) {
        unit.pipe = entered;
        unit.crossing.setPipe(entered.index);
      }

      unit.surface = next;
    }
  }

  // 포털 평면을 바퀴 쪽에 알려 주고, 두 복사본의 자세를 맞춘다.
  if (placedCount > 0) {
    // 구멍이 뚫린 자리에 면들을 맞춘다.
    layOutSurfaces();
    if (needsRelink) {
      needsRelink = false;
      roomShell.rebuild();
      for (const pipe of pipes) {
        if (pipe.placed) linkPipeToHost(pipe);
      }
      // 나가는 문이 어디인지는 모서리를 이은 뒤에야 정해진다. 0번 말고는
      // 복도에 모서리가 하나도 없는 채로 태어나므로, 여기서 알려 주지 않으면
      // 그 관의 바퀴들은 '문'을 모른 채 벽만 따라 돈다.
      for (const unit of units) unit.roach.setExitZ(forwardExitOf(unit.surface));
    }
    for (const grid of surfaceGrids) grid.visible = frame === undefined;
  }

  for (const pipe of pipes) {
    if (!pipe.placed) {
      disablePipePlane(pipe.index);
      continue;
    }
    portalFacing.set(0, 0, 1).applyQuaternion(pipe.group.quaternion);
    // 자르는 평면은 구멍 원판이 아니라 면보다도 조금 뒤에 둔다.
    //
    // 구멍은 z-fighting을 피하려고 면에서 1cm 떠 있다. 그 자리에 평면을 두면
    // 진짜 벽을 기어가는 바퀴가 전부 그 뒤에 있게 되고, 면에 딱 맞추면 이번엔
    // 벽과 바닥이 만나는 모서리가 평면 위에 걸린다 — 하필 바퀴가 가장 오래
    // 머무는 자리다. 두 상수의 주석 참고.
    portalPlanePoint
      .copy(pipe.group.position)
      .addScaledVector(portalFacing, -(PORTAL_WALL_GAP + PORTAL_CLIP_DEPTH));
    setPipePlane(pipe.index, portalPlanePoint, portalFacing);
  }
  for (const unit of units) unit.crossing.sync();

  // 자세가 다 정해진 뒤에 행렬을 모은다. render보다 먼저여야 한다.
  roachBatch.sync();

  // 근접 페이드는 세션 밖에서도 돈다. 전에는 XR 안에서만 돌아서 데스크톱에서는
  // 한 번도 눈으로 볼 수 없었고, 그래서 잘못된 줄도 몰랐다. 머리 위치만
  // 있으면 되는 계산이라 미리보기 카메라로도 똑같이 돈다.
  for (const pipe of pipes) {
    if (pipe.placed) updatePipeFade(pipe, viewerPosition);
  }
}

/** 프레임이 터진 횟수. 한 번 터지면 보통 매 프레임 터진다. */
let frameFailures = 0;
/** 마지막으로 터진 내용. 손바닥 패널에 띄워서 세션 안에서 읽는다. */
let lastFrameError = '';

/**
 * 한 프레임. 계산이 터져도 renderer.render는 반드시 지나간다.
 *
 * 이게 없으면 계산 중에 예외 하나만 나도 헤드셋이 통째로 검게 된다. 패스스루가
 * 남는 게 아니다 — AR에서 우리가 안 그린 픽셀에 패스스루가 합성되는 건
 * renderer.render가 프레임버퍼를 투명으로 클리어해 줄 때의 이야기다. 거기까지
 * 못 가면 클리어도 안 되고, XR 레이어에 담긴 건 검정이다. 그리고 그 상태에서는
 * 콘솔도 DOM도 손바닥 패널도 안 보이니, 무엇이 터졌는지 알 길이 통째로 없다.
 *
 * 실제로 그렇게 됐다. 파이프가 스스로 자리를 고르게 바꾼 뒤 헤드셋에서 검은
 * 화면만 나왔고, 데스크톱 미리보기는 멀쩡해서 어디가 터지는지 짚을 수가 없었다.
 *
 * 그래서 계산과 그리기를 나눈다. 터지면 그 프레임의 계산만 버리고, 장면은
 * 직전 상태로 그려지고, 터진 내용은 손바닥 패널에 뜬다. 디버그 패널에 이미
 * 같은 울타리를 쳐 뒀는데(아래 panelFailed), 들여다보는 도구가 작품을 지울 수
 * 없어야 한다면 작품 자신도 자기를 지울 수 없어야 한다.
 */
function renderFrame(time: DOMHighResTimeStamp, frame?: XRFrame): void {
  try {
    stepFrame(time, frame);
  } catch (error) {
    frameFailures += 1;
    lastFrameError = error instanceof Error ? error.message : String(error);
    // 매 프레임 터지면 로그가 터진다. 처음 몇 개만 남긴다.
    if (frameFailures <= 3) {
      log(`[프레임 터짐 ${frameFailures}] ${lastFrameError}`);
      if (error instanceof Error && error.stack !== undefined) {
        log(error.stack.split('\n').slice(0, 3).join(' | '));
      }
    }
    // 세션 안에서 이걸 읽을 유일한 길이 손바닥 패널이다. 패널 갱신이
    // stepFrame 안에 있어서, 그 앞에서 터지면 패널은 묵은 내용을 들고 있다.
    if (!panelFailed) {
      try {
        debugPanel.setLines([`프레임 터짐 ${frameFailures}회`, lastFrameError]);
        debugPanel.update(handTracker.hands, viewerPosition);
      } catch {
        panelFailed = true;
      }
    }
  }

  renderer.render(scene, camera);
}

renderer.setAnimationLoop(renderFrame);

// ---------------------------------------------------------------------------
// 미리보기 창구
//
// 이 작품은 헤드셋에서만 제대로 도는데, 헤드셋 안에서는 콘솔도 DOM도 못 본다.
// 그래서 데스크톱 미리보기가 유일하게 계측할 수 있는 자리다 — 가짜 방 평면과
// 가짜 손이 그 자리를 만들고, 아래 창구들이 그걸 읽고 흔든다.
//
// immersive-ar이 되는 기기에서는 가짜 방도 가짜 손도 돌지 않으므로, 이 창구들은
// 거기서 아무것도 하지 않는다.
// ---------------------------------------------------------------------------
Object.assign(window, {
  // 미리보기 카메라를 아무 데나 놓고 아무 데나 보게 한다. 파이프 구경이
  // 14cm라 기본 자리에서는 점만 하다.
  view: (px = 0, py = 1.2, pz = -0.9, tx = 0, ty = 1.2, tz = -1.3) => {
    camera.position.set(px, py, pz);
    camera.lookAt(tx, ty, tz);
    return camera.position.toArray().map((c) => +c.toFixed(2));
  },
  /**
   * 프레임을 n번 직접 돌린다.
   *
   * 브라우저 창이 가려져 있으면 requestAnimationFrame이 초당 한 번으로
   * 묶인다. 바퀴가 구멍에서 나와 벽을 타고 내려오기까지는 수백 프레임이
   * 걸리므로, 그 상태로는 '나오는지'를 아예 확인할 수 없다 — 10초를 보려고
   * 10분을 기다리게 된다.
   *
   * 시각은 지어낸다. 루프는 들어온 시각의 차이만 보고 dt를 구하므로, 실제
   * 벽시계와 맞을 필요가 없다. 사람이 안 보는 동안 장면만 앞으로 돌린다.
   */
  tick: (n = 60, dt = 1 / 60) => {
    for (let i = 0; i < n; i += 1) renderFrame(lastFrameTime + dt * 1000);
    return `${n}프레임 (${(n * dt).toFixed(1)}초)`;
  },
  // 구멍 앞으로 카메라를 다시 데려간다. 뚫린 자리가 난수라서 필요하다.
  // 구멍 앞으로 카메라를 데려간다. 구멍마다 따로 깨어나므로, 번호를 받는다 —
  // look()만으로는 0번 말고는 영영 안 깨어난다.
  look: (which?: number) => {
    aimPreviewCamera(which === undefined ? undefined : pipes[which]);
    return camera.position.toArray().map((c) => +c.toFixed(2));
  },
  // 구멍들의 상태. 여러 개가 되고 나서 제일 먼저 보게 되는 표다.
  holes: () =>
    pipes.map((pipe) => ({
      번호: pipe.index,
      뚫림: pipe.placed,
      깨어남: pipe.emerged,
      면: pipe.hostLabel,
      숙주: pipe.host === null ? '없음' : (SURFACE_NAMES.get(pipe.host) ?? '?'),
      자리: pipe.spot.toArray().map((c) => +c.toFixed(2)),
      바퀴: units.filter((unit) => unit.pipe === pipe).length,
    })),
  // 구멍을 다른 자리로 다시 뚫는다. 자리가 난수라, 벽·바닥·천장 세 경우를
  // 보려면 여러 번 돌려 봐야 한다.
  repipe: () => {
    repickPipes();
    return '다음 프레임에 전부 다시 뚫는다';
  },
  // 파이프 하나를 어느 면에 뚫을지 직접 집는 창구. 난수에 맡기면 천장에 뚫린
  // 경우를 보려고 repipe를 열 번 돌려야 한다.
  //
  //   pipe(0, 2)       0번 파이프를 2번 껍데기 면의 가운데에
  //   pipe(1, 2, 0.3)  1번 파이프를 2번 면의 로컬 x = 0.3에
  pipe: (which = 0, index = 0, x = 0, z?: number) => {
    const pipe = pipes[which];
    const shell = roomShell.surfaces[index];
    if (pipe === undefined) return '그런 파이프 없음';
    if (shell === undefined) return '그런 면 없음';

    const node = shell.surface.node;
    node.updateMatrixWorld();
    spotPoint.set(x, 0, z ?? shell.surface.boundCenterZ);
    node.localToWorld(spotPoint);
    node.getWorldQuaternion(spotQuaternion);
    spotNormal.set(0, 1, 0).applyQuaternion(spotQuaternion).normalize();
    pickSillDir(node, spotSill);

    spotLabel = shell.label;
    placePipeAt(pipe, spotPoint, spotNormal, spotSill);
    resetRoaches();
    aimPreviewCamera(pipe);
    return {
      파이프: which,
      면: SURFACE_NAMES.get(shell.surface) ?? shell.label,
      자리: spotPoint.toArray().map((c) => +c.toFixed(2)),
      법선: spotNormal.toArray().map((c) => +c.toFixed(2)),
      아래턱쪽: spotSill.toArray().map((c) => +c.toFixed(2)),
    };
  },
  // 평면이 한 프레임 사라지는 일을 흉내 내는 창구.
  blink: (ms = 100) => {
    blinkFakeRoom(ms);
    return `${ms}ms 동안 평면 목록을 비운다`;
  },
  // 때리기를 미리보기에서 시험하는 창구. 세기를 가르는 값은 머리로
  // 맞출 수 없어서, 실제로 돌려 보고 정한다.
  //   slap(0, 2, true)         손바닥으로 빠르게      → 죽어야 한다
  //   slap(0, 0.2, true)       천천히 갖다 대기       → 살아야 한다
  //   slap(0, 2, false)        손바닥이 딴 데를 봄    → 살아야 한다
  //   slap(0, 2, true, true)   손가락만 빠르게 찌르기 → 살아야 한다
  slap: (which = 0, speed = 2, facing = true, finger = false) => {
    const unit = units[which];
    if (unit === undefined) return '그런 바퀴 없음';

    const node = unit.surface.node;
    node.updateMatrixWorld();
    const quat = node.getWorldQuaternion(new THREE.Quaternion());
    const normal = new THREE.Vector3(0, 1, 0).applyQuaternion(quat);
    const point = unit.roach.root.position.clone();
    node.localToWorld(point);
    point.addScaledVector(normal, 0.02);

    // 마주 보지 않는 경우는 면의 로컬 X축으로 둔다 — 법선과 늘 직각이다.
    const palmNormal = facing
      ? normal.clone().negate()
      : new THREE.Vector3(1, 0, 0).applyQuaternion(quat);

    // 찌르는 손은 손가락만 벌레에 닿고 손바닥은 한 뼘 뒤에 남는다.
    const palmPoint = finger ? point.clone().addScaledVector(normal, 0.1) : point;
    setFakeHand(
      'right',
      palmPoint,
      point,
      palmNormal,
      normal.clone().multiplyScalar(-speed),
      speed,
    );
    return SURFACE_NAMES.get(unit.surface) ?? '?';
  },
  unslap: () => {
    clearFakeHand();
    return units.map((u) => u.roach.isSquashed());
  },
  squashed: () => units.map((u) => u.roach.isSquashed()),
  // 손바닥 패널의 버튼을 눌러 보는 창구. 미리보기에는 진짜 손가락이
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
  // 껍데기 면들의 자리와 법선. 전부 방 안쪽을 봐야 한다.
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
        // 파이프가 걸린 벽에만 '아래로'가 심긴다. 파이프를 옮기면 걷혀야 한다 —
        // 안 걷으면 그 면의 바퀴들이 계속 한쪽으로만 내려간다.
        목적: s.surface.drift === null ? null : +s.surface.drift.toFixed(2),
      };
    }),
  // 바퀴 하나를 껍데기 면 위에 올려놓는다. 모서리를 실제로 넘는지
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
  // 껍데기 면들이 서로 어떻게 이어졌는지. 상자 방이면 벽-바닥 넷,
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
  // 책상 네 옆면의 원점 높이. 전부 책상 높이여야 한다.
  sides: () =>
    tableSides.map((side) => +side.node.getWorldPosition(new THREE.Vector3()).y.toFixed(3)),
  probe: () =>
    units.map((unit) => {
      const p = unit.roach.root.position;
      const s = unit.surface;
      return {
        관: unit.pipe.index,
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
  session.addEventListener('select', repickPipes);

  // 이 세션의 방에 맞춰 다시 뚫는다.
  resetPipes();
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
    resetPipes();

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
    // 여기서는 진짜 평면이 영영 오지 않는다. 가짜 방을 먹여 눈으로 볼 수 있게.
    useFakeRoom = true;
    return;
  }

  enterButton.disabled = false;
  enterButton.textContent = 'AR 시작';
}

void checkSupport();
