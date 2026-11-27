import * as THREE from 'three';
import {
  linkSurfaces,
  makeWalkSurface,
  type SurfaceEdge,
  type WalkSurface,
} from './walk-surface';

// ---------------------------------------------------------------------------
// 감지된 평면을 걸을 수 있는 면으로
//
// 포털이 만드는 면들(복도 바닥, 벽면, 방 바닥)은 우리가 좌표를 직접 계산해서
// 세운 것이다. 방 껍데기는 그럴 필요가 없다 — 런타임이 이미 자세를 알려 준다.
//
// ── 평면의 좌표계를 그대로 쓴다 ──
//
// XRPlane의 polygon은 그 평면의 로컬 좌표계에 있고, 그 좌표계는 표면이 X-Z에
// 눕도록 잡혀 있다(모든 점의 y가 0). 즉 법선은 언제나 로컬 +Y다. 벽도
// 예외가 아니라, 좌표계 통째로 세워져 있을 뿐이다.
//
// 그런데 WalkSurface의 규약도 똑같이 '로컬 XZ가 바닥, +Y가 바깥 법선'이다.
// 그래서 orientSurface로 기저를 새로 만들 필요가 없다. 평면의 자세를 받는
// 노드를 하나 두고 그 자식으로 면을 달면, 자세가 공짜로 따라온다.
//
// ── +Y가 방 안쪽인지는 보장되지 않는다 ──
//
// 스펙은 법선이 로컬 +Y라고만 하고, 그게 방 안을 보는지 벽 속을 보는지는
// 말하지 않는다. 바닥에서 뒤집히면 바퀴가 바닥 아래에 매달리고, 벽에서
// 뒤집히면 벽 속을 걷는다.
//
// 방 안의 한 점을 기준으로 판정한다. 법선이 그 점을 등지고 있으면 로컬
// X축으로 180° 돌린다. 그러면 바닥은 위, 천장은 아래, 벽은 안쪽을 보게 되고,
// 라벨을 보지 않아도 셋이 한 규칙으로 풀린다.
//
// 그 기준점으로 처음에는 사람 머리를 썼다. 사람은 늘 방 안에 있으니까 —
// 그런데 그렇지가 않다. 미리보기 카메라를 방 밖에 세워 두자마자 가까운 벽의
// 판정이 뒤집혔고, 실제로도 문간에 서 있거나 벽에 몸을 붙이면(법선과
// 직각이라 내적이 0 근처다) 같은 일이 난다.
//
// 그래서 면들의 중심을 평균한 점을 쓴다. 상자 모양 방이면 여섯 면 중심의
// 평균이 정확히 방 중심이고, 사람이 어디 서 있든 상관없다. 평면은 몇 프레임에
// 걸쳐 하나씩 들어오므로, 새 면이 생길 때마다 전부 다시 판정한다 — 면이 하나뿐일
// 때는 평균이 자기 자신이어서 판정이 안 되니, 그때만 머리 위치로 물러난다.
//
// ── 모서리는 두 평면의 교선에서 나온다 ──
//
// 손으로 세운 면들은 모서리도 손으로 적었다. 어디서 만나는지 우리가 알고
// 있었기 때문이다. 감지된 평면은 몇 개가 어떤 자세로 들어올지 모르므로
// 기하에서 끌어내야 한다.
//
// 두 평면이 만나는 곳은 직선 하나다. 방향은 두 법선의 외적이고, 그 직선 위의
// 한 점은 두 평면 방정식을 풀면 나온다. 거기까지는 무한 평면 이야기라서,
// 양쪽 사각형으로 잘라 실제로 둘 다 닿는 구간만 남긴다. 상자 모양 방이면
// 여섯 면에서 벽-바닥 넷, 벽-천장 넷, 벽-벽 넷이 나온다.
//
// 손으로 세운 면도 같이 넣는다. 포털이 만드는 복도 바닥과 책상은 평면에서
// 나오지 않지만, 방과 만나는 자리는 똑같이 기하로 풀린다 — 복도 바닥과 벽
// 평면이 만나는 선이 곧 포털의 아래턱이고, 책상 옆면과 바닥 평면이 만나는
// 선이 곧 책상 발자국이다. 사각형으로 자르는 덕에 아래턱은 저절로 구멍
// 폭만큼만 열린다. 복도 바닥이 딱 그만큼 넓기 때문이다.
//
// 평면이 하나 더 들어오거나 모양이 다듬어지면 전부 다시 만든다. 기준점이
// 바뀌어 법선 판정이 뒤집힐 수 있고, 사각형 중심도 함께 움직이기 때문이다.
// 모서리 몇 개를 고쳐 끼우는 것보다 통째로 다시 세우는 쪽이 짧다.
//
// ── 평면 메시에 매달지 않는다 ──
//
// 디버그로 띄우는 반투명 평면 메시가 이미 같은 자세를 들고 있어서 거기에
// 자식으로 달면 노드를 아낄 수 있다. 하지만 그 메시는 포털을 확정하면
// visible = false가 되고, three.js의 visible은 자식까지 함께 끈다 — 그 면
// 위의 바퀴가 통째로 사라진다. 자세를 받는 노드를 따로 둔다.
// ---------------------------------------------------------------------------

/** 걸을 수 있는 방 껍데기로 볼 라벨. 가구 상판은 옆면이 없어서 뺀다. */
const SHELL_LABELS = new Set(['wall', 'floor', 'ceiling']);

/** 이보다 좁은 평면은 걸을 가치가 없다(m). 문틀 조각 같은 것들. */
const MIN_EXTENT = 0.4;

/**
 * 활동 범위를 평면 끝에서 이만큼 안으로 당긴다(m).
 *
 * 바퀴는 몸길이가 4cm다. 끝까지 허용하면 몸의 절반이 옆 평면 속에 박힌 채로
 * 보인다. 다만 너무 당기면 평면끼리 만나는 모서리에 닿지 못해 넘어갈 수가
 * 없으니, 몸 반쪽만큼만 둔다.
 */
const EDGE_MARGIN = 0.02;

/**
 * 면을 평면에서 이만큼 띄운다(m).
 *
 * 바퀴의 발이 평면과 정확히 같은 높이에 있으면, 포털을 자르는 평면이 벽 위에
 * 놓였을 때 발이 그 평면에 걸터앉아 프레임마다 잘렸다 말았다 한다. 평면
 * 오버레이와의 z-fighting도 같이 사라진다. 2mm는 눈에 안 보인다.
 */
const SURFACE_LIFT = 0.002;

/**
 * 평면이 목록에서 사라져도 이만큼은 기다린다(ms).
 *
 * 런타임이 detectedPlanes를 한 프레임 통째로 비우는 일이 있다. 헤드셋 로그에
 * '평면 0개'가 두 번 찍혔고, 그때마다 면 여섯 개가 전부 버려졌다가 다시
 * 만들어졌다. 면을 버리면 그 노드가 씬에서 떨어져 나가고, 그 위에 서 있던
 * 바퀴도 함께 딸려 나간다 — 화면에서 그냥 사라지는 것이다.
 *
 * 한 프레임 안 보이는 것과 정말 없어진 것은 기다려 보면 갈린다. 0.5초면
 * 딸꾹질은 다 넘기고, 진짜로 치운 평면도 금방 정리된다.
 */
const VANISH_GRACE = 500;

/**
 * 두 법선의 외적 길이가 이보다 짧으면 모서리를 만들지 않는다.
 *
 * 외적의 길이는 두 법선이 이루는 각의 sin이다. 0.1이면 6° 안쪽 — 마주 보는
 * 두 벽처럼 나란한 평면이다. 그런 평면도 교선은 있지만 저 멀리 어딘가다.
 */
const MIN_CROSS = 0.1;

/**
 * 사각형으로 자를 때 이만큼 너그럽게 본다(m).
 *
 * 상자 모양 방에서 두 평면은 서로의 사각형 '끝선'에서 만난다 — 바닥 사각형의
 * 경계선이 그대로 벽과의 교선이다. 딱 맞게 자르면 그 선이 들어오는지는 부동
 * 소수점 반올림이 정한다. 실제로 그랬다: 네 벽 중 둘만 바닥과 이어졌고, 반올림이
 * 반대로 떨어진 둘은 교선이 사각형 '밖'으로 판정돼 빠졌다.
 *
 * 스캔된 평면은 더 거칠다. 벽이 바닥 끝까지 안 내려오거나 몇 cm 지나치는 쪽이
 * 보통이고, 모서리가 그렇게 몇 cm로 사라지면 안 된다.
 */
const JOIN_SLACK = 0.05;

/** 양쪽 사각형이 함께 닿는 구간이 이보다 짧으면 모서리로 치지 않는다(m). */
const MIN_OVERLAP = 0.15;

/** 면 중심에서 모서리까지가 이보다 가까우면 버린다(m). 아래 주석 참고. */
const MIN_OFFSET = 0.05;

/**
 * 모서리를 활동 범위보다 이만큼 바깥에 둔다(m).
 *
 * 둘을 같은 자리에 두었더니 구석에서 바퀴가 면 사이를 끝없이 오갔다.
 * 가장자리를 따라가는 바퀴는 범위에서 EDGE_HUG(1.2cm)만큼 안쪽을 유지하는데,
 * 그 간격을 맞추는 조향이 '범위 쪽으로 살짝' 틀어져 있다 — 넘어가는 판정이
 * 보는 게 정확히 그 방향이다. 즉 붙어 다니는 내내 넘기 직전이고, 조향이
 * 떨리는 폭이 그 간격과 같은 크기다.
 *
 * 모서리를 1cm 더 바깥에 두면 붙어 다니는 것만으로는 닿지 않는다. 마음먹고
 * 넘을 때는 범위를 2cm 넘어설 때까지 밀어붙이므로(roach.ts의
 * EDGE_CLIMB_DEPTH) 그대로 넘어간다. 정면으로 들이받아 지나치는 경우도 그보다
 * 더 간다.
 */
const EDGE_OFFSET = 0.01;

/**
 * 모서리 바깥의 '띠' 두께(m). 이 띠 안에서만 넘어간다.
 *
 * 모서리는 평면 끝에서 EDGE_MARGIN만큼 안쪽에 있고, 활동 범위도 거기까지다.
 * 즉 띠에 들어가는 길은 범위를 넘어선 순간뿐이다 — 벽을 정면으로 들이받으면
 * 돌아서기까지 몇 cm를 더 가므로 그때 잡힌다. 넉넉히 둔다.
 */
const CROSS_BAND = 0.15;

export interface ShellSurface {
  plane: XRPlane;
  label: string;
  /** 평면의 자세를 그대로 받는 노드. 면 노드의 부모다. */
  pose: THREE.Group;
  surface: WalkSurface;
  /** 바운딩 사각형의 크기(m). 로그와 격자에 쓴다. */
  width: number;
  depth: number;
  /** 법선이 방 안쪽을 보도록 뒤집었는지. 한 번 정하면 유지한다. */
  flipped: boolean;
}

/**
 * 모서리를 만들 때 함께 보는 면.
 *
 * 평면에서 나온 면은 사각형이 폴리곤의 바운딩 박스이고, 활동 범위는 거기서
 * EDGE_MARGIN만큼 안쪽이다. 손으로 세운 면은 그런 게 없고 활동 범위가 곧
 * 걸을 수 있는 전부라, 사각형을 그대로 쓰고 여유도 두지 않는다.
 */
interface Joinable extends JoinRect {
  /** 모서리를 사각형 끝에서 이만큼 안으로 당긴다(m). */
  margin: number;
}

/**
 * 평면에서 나오지 않았지만 방과 이어져야 하는 면.
 *
 * 사각형을 활동 범위에서 읽지 않고 받아 적는다. 범위는 때에 따라 바뀌기
 * 때문이다 — 복도 바닥은 바퀴가 나오기를 기다리는 동안 안쪽 깊숙이 좁혀져
 * 있어서, 그때 읽으면 아래턱 선이 사각형 밖으로 떨어져 포털이 막힌다.
 */
export interface JoinRect {
  surface: WalkSurface;
  /** 걸을 수 있는 사각형(면의 로컬 XZ). 원점이 중심이 아닐 수 있다. */
  halfX: number;
  centerZ: number;
  halfZ: number;
}

export interface RoomShell {
  /** 지금 살아 있는 면들. 평면이 사라지면 여기서도 빠진다. */
  surfaces: ShellSurface[];
  /** 껍데기 면끼리 이어진 모서리 수. 로그용. */
  edgeCount: number;
  /** 이번 프레임에 사라진 면들. 그 위에 있던 바퀴를 구해야 한다. */
  removed: ShellSurface[];
  /**
   * 매 프레임. 새 평면에는 면을 만들고, 사라진 평면의 면은 치우고,
   * 남은 면들의 자세를 갱신한다.
   *
   * @param insidePoint 방 안의 한 점(월드). 법선 방향을 판정하는 기준.
   * @returns 이번 프레임에 새로 생긴 면들. 로그와 모서리 연결에 쓴다.
   */
  sync(
    frame: XRFrame,
    referenceSpace: XRReferenceSpace,
    insidePoint: THREE.Vector3,
  ): ShellSurface[];
  /**
   * 모서리를 다시 세운다. 손으로 세운 면이 움직였을 때 바깥에서 부른다 —
   * 포털을 놓으면 복도 바닥과 책상이 그 자리로 옮겨 가기 때문이다.
   */
  rebuild(): void;
}

const planeMatrix = new THREE.Matrix4();
const planeNormal = new THREE.Vector3();
const faceCenter = new THREE.Vector3();
const insideEstimate = new THREE.Vector3();
const towardInside = new THREE.Vector3();

const normalA = new THREE.Vector3();
const normalB = new THREE.Vector3();
const originA = new THREE.Vector3();
const originB = new THREE.Vector3();
const lineDir = new THREE.Vector3();
const linePoint = new THREE.Vector3();
const crossTermA = new THREE.Vector3();
const crossTermB = new THREE.Vector3();
const inverseNode = new THREE.Matrix4();
/** 교선을 어느 면의 로컬로 옮겨 둔 것. localizeLine이 채운다. */
const localOrigin = new THREE.Vector3();
const localDir = new THREE.Vector3();

/** 직선의 매개변수 구간. s는 미터다(방향 벡터가 단위라서). */
interface Span {
  min: number;
  max: number;
}

const spanA: Span = { min: 0, max: 0 };
const spanB: Span = { min: 0, max: 0 };

/** 한 축에 대해 구간을 좁힌다. 비면 false. */
function clipAxis(origin: number, dir: number, half: number, span: Span): boolean {
  // 축과 나란한 직선. 좁힐 게 없고, 사각형 안에 있는지만 본다.
  if (Math.abs(dir) < 1e-6) return Math.abs(origin) <= half;

  const a = (-half - origin) / dir;
  const b = (half - origin) / dir;
  span.min = Math.max(span.min, Math.min(a, b));
  span.max = Math.min(span.max, Math.max(a, b));
  return span.min <= span.max;
}

/**
 * 로컬 좌표의 직선을 면의 사각형으로 자른다.
 *
 * 교선은 그 평면 위에 있으므로 로컬 y는 0이다 — 보지 않는다.
 * 사각형을 JOIN_SLACK만큼 키워서 본다. 이유는 그 상수의 주석에 있다.
 */
function clipToRect(target: Joinable, span: Span): boolean {
  span.min = -Infinity;
  span.max = Infinity;
  if (!clipAxis(localOrigin.x, localDir.x, target.halfX + JOIN_SLACK, span)) return false;
  return clipAxis(
    localOrigin.z - target.centerZ,
    localDir.z,
    target.halfZ + JOIN_SLACK,
    span,
  );
}

/** 월드 교선을 이 면의 로컬로 옮긴다. 결과는 localOrigin/localDir에 남는다. */
function localizeLine(surface: WalkSurface): void {
  surface.node.updateMatrixWorld();
  inverseNode.copy(surface.node.matrixWorld).invert();
  localOrigin.copy(linePoint).applyMatrix4(inverseNode);
  localDir.copy(lineDir).transformDirection(inverseNode);
}

/**
 * 이 면에서 본 모서리를 SurfaceEdge 규약으로 적는다. 적을 수 없으면 null.
 *
 * @param s0 겹치는 구간의 시작(월드 직선의 매개변수)
 * @param s1 끝
 */
function edgeSpecFor(
  target: Joinable,
  s0: number,
  s1: number,
): Omit<SurfaceEdge, 'to'> | null {
  localizeLine(target.surface);

  // SurfaceEdge는 모서리를 '바깥 법선 + 거리'로 적고, 그 모서리를 따라가는
  // 축을 (-nz, nx)로 둔다. 지금 우리가 든 건 방향이니, 거꾸로 풀어 법선을
  // 얻는다: (-nz, nx) = (dx, dz) 이므로 nx = dz, nz = -dx.
  let nx = localDir.z;
  let nz = -localDir.x;
  const length = Math.hypot(nx, nz);
  // 교선이 이 면의 법선과 나란하다 — 그런 직선은 평면 위에 눕지 않는다.
  if (length < 1e-6) return null;
  nx /= length;
  nz /= length;

  // 법선은 '바깥'을 향해야 한다. 사각형 중심에서 모서리로 가는 쪽이 바깥이다.
  // 원점이 아니라 중심으로 재는 게 중요하다 — 손으로 세운 면은 원점이 사각형
  // 한쪽 끝에 있다. 복도 바닥의 원점은 아래턱 위에 있어서, 원점으로 재면
  // 거리가 0이고 어느 쪽이 바깥인지 알 수가 없다.
  const spread = localOrigin.x * nx + (localOrigin.z - target.centerZ) * nz;
  if (spread < 0) {
    nx = -nx;
    nz = -nz;
  }
  // 모서리가 사각형 중심을 지난다 = 다른 평면이 이 면을 가로질러 썰고 있다.
  // 그대로 쓰면 면 한가운데를 지나는 순간 바퀴가 옆 면으로 튄다.
  if (Math.abs(spread) < MIN_OFFSET) return null;

  // at은 사각형 중심이 아니라 면의 원점 기준이다 — SurfaceEdge의 규약이 그렇다.
  const at = localOrigin.x * nx + localOrigin.z * nz;

  const mid = (s0 + s1) / 2;
  const midX = localOrigin.x + localDir.x * mid;
  const midZ = localOrigin.z + localDir.z * mid;

  return {
    nx,
    nz,
    // 활동 범위에서 EDGE_OFFSET만큼 바깥. 평면 끝에 두면 범위가 먼저 막아
    // 영영 못 넘고, 범위와 같은 자리에 두면 붙어 다니다 저절로 넘는다.
    at: at - target.margin,
    alongCenter: -midX * nz + midZ * nx,
    halfWidth: (s1 - s0) / 2,
    band: CROSS_BAND,
  };
}

/** 폴리곤을 감싸는 사각형. 평면의 로컬 XZ 기준이다. */
export function boundingRect(plane: XRPlane): {
  centerX: number;
  centerZ: number;
  halfX: number;
  halfZ: number;
} {
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

  return {
    centerX: (minX + maxX) / 2,
    centerZ: (minZ + maxZ) / 2,
    halfX: (maxX - minX) / 2,
    halfZ: (maxZ - minZ) / 2,
  };
}

/** 라벨이 없는 기기를 위한 폴백. 벽/바닥/천장의 구분까지는 못 한다. */
function labelOf(plane: XRPlane): string {
  if (plane.semanticLabel !== undefined) return plane.semanticLabel;
  return plane.orientation === 'vertical' ? 'wall' : 'floor';
}

/**
 * @param parent 면 노드를 달 곳
 * @param extras 평면에서 나오지 않았지만 방과 이어져야 하는 면들. 포털이
 *               만드는 복도 바닥과 책상이 여기 들어온다.
 */
export function makeRoomShell(
  parent: THREE.Object3D,
  extras: JoinRect[] = [],
): RoomShell {
  const byPlane = new Map<XRPlane, ShellSurface>();
  /** 평면의 모양이 언제 갱신됐는지. Quest는 스캔하면서 폴리곤을 다듬는다. */
  const shapeTimes = new Map<XRPlane, DOMHighResTimeStamp>();
  /** 평면이 마지막으로 목록에 있던 시각. VANISH_GRACE 참고. */
  const lastSeen = new Map<XRPlane, number>();

  /** 사각형을 면의 자세와 범위에 반영한다. 모양이 다듬어지면 다시 부른다. */
  function applyRect(shell: ShellSurface): void {
    const rect = boundingRect(shell.plane);

    // 면의 원점을 사각형의 중심에 둔다. WalkSurface의 범위는 x에 대해
    // 대칭(±halfX)이라, 원점이 중심에 있지 않으면 표현할 수가 없다.
    // 위치는 부모(자세 노드)의 좌표계라 뒤집기와 무관하다.
    // y는 decideFlips가 채운다. 띄우는 방향이 뒤집기에 달려 있기 때문이다.
    shell.surface.node.position.set(rect.centerX, 0, rect.centerZ);

    shell.surface.boundHalfX = Math.max(0, rect.halfX - EDGE_MARGIN);
    shell.surface.boundCenterZ = 0;
    shell.surface.boundHalfZ = Math.max(0, rect.halfZ - EDGE_MARGIN);

    shell.width = rect.halfX * 2;
    shell.depth = rect.halfZ * 2;
  }

  /** 면 중심(월드). 노드의 회전과 무관하므로 행렬을 거치지 않고 직접 구한다. */
  function centerOf(shell: ShellSurface, out: THREE.Vector3): THREE.Vector3 {
    return out
      .copy(shell.surface.node.position)
      .applyQuaternion(shell.pose.quaternion)
      .add(shell.pose.position);
  }

  /**
   * 법선이 방 안쪽을 보도록 전부 다시 판정한다. 면이 새로 생기거나 모양이
   * 다듬어질 때 부른다 — 기준점이 면들의 평균이라 면이 늘면 기준점도 움직인다.
   *
   * 판정이 바뀌면 그 면에 서 있던 바퀴도 함께 뒤집힌다. 평면은 세션 초반 몇
   * 초 안에 다 들어오고 모서리로 이어 붙이기 전이라, 실제로 그럴 일은 없다.
   */
  function decideFlips(fallbackInside: THREE.Vector3): void {
    const shells = [...byPlane.values()];
    if (shells.length === 0) return;

    if (shells.length < 2) {
      insideEstimate.copy(fallbackInside);
    } else {
      insideEstimate.set(0, 0, 0);
      for (const shell of shells) insideEstimate.add(centerOf(shell, faceCenter));
      insideEstimate.divideScalar(shells.length);
    }

    for (const shell of shells) {
      planeNormal.set(0, 1, 0).applyQuaternion(shell.pose.quaternion);
      towardInside.subVectors(insideEstimate, centerOf(shell, faceCenter));

      const flip = planeNormal.dot(towardInside) < 0;
      // 로컬 X축으로 180°. +Y와 +Z가 뒤집히고 오른손 좌표계는 유지된다.
      shell.surface.node.rotation.set(flip ? Math.PI : 0, 0, 0);
      // 면을 평면에서 살짝 띄운다. 위치는 부모(자세 노드)의 좌표계라 뒤집기가
      // 안 먹으므로, 어느 쪽이 바깥인지를 여기서 직접 반영한다.
      shell.surface.node.position.y = flip ? -SURFACE_LIFT : SURFACE_LIFT;
      shell.flipped = flip;
    }
  }

  /** 이 모듈이 만든 모서리. 다시 세울 때 이것만 걷어낸다. */
  const madeEdges: { surface: WalkSurface; edge: SurfaceEdge }[] = [];

  /**
   * 두 면이 만나면 모서리로 잇는다. 이었으면 true.
   *
   * 평면은 무한하지만 걸을 수 있는 건 사각형만큼이다. 그래서 교선을 구한
   * 뒤 양쪽 사각형으로 잘라, 둘 다 실제로 닿는 구간만 모서리로 남긴다.
   * 마주 보는 벽처럼 교선이 어느 쪽 사각형에도 닿지 않으면 여기서 걸린다.
   */
  function linkPair(a: Joinable, b: Joinable): boolean {
    a.surface.node.updateMatrixWorld();
    b.surface.node.updateMatrixWorld();

    // 면의 법선과 원점(월드). matrixWorld의 두 번째 열이 로컬 +Y다 —
    // 뒤집은 면은 여기서 이미 뒤집혀 있다.
    normalA.setFromMatrixColumn(a.surface.node.matrixWorld, 1).normalize();
    normalB.setFromMatrixColumn(b.surface.node.matrixWorld, 1).normalize();
    originA.setFromMatrixPosition(a.surface.node.matrixWorld);
    originB.setFromMatrixPosition(b.surface.node.matrixWorld);

    lineDir.crossVectors(normalA, normalB);
    const lengthSq = lineDir.lengthSq();
    if (lengthSq < MIN_CROSS * MIN_CROSS) return false;

    // 교선 위의 한 점. n·x = h 두 개를 푼 닫힌 꼴이다. 양변에 nA를 내적해 보면
    // 두 번째 항이 떨어지고 첫 항이 lengthSq를 내놓아 hA가 남는다.
    const hA = normalA.dot(originA);
    const hB = normalB.dot(originB);
    crossTermA.crossVectors(normalB, lineDir).multiplyScalar(hA);
    crossTermB.crossVectors(lineDir, normalA).multiplyScalar(hB);
    linePoint.addVectors(crossTermA, crossTermB).divideScalar(lengthSq);

    // 이제부터 매개변수 s를 미터로 읽으려고 방향을 단위로 만든다. 위의 점은
    // 길이와 무관하므로 순서는 이래야 한다.
    lineDir.normalize();

    localizeLine(a.surface);
    if (!clipToRect(a, spanA)) return false;
    localizeLine(b.surface);
    if (!clipToRect(b, spanB)) return false;

    const s0 = Math.max(spanA.min, spanB.min);
    const s1 = Math.min(spanA.max, spanB.max);
    if (s1 - s0 < MIN_OVERLAP) return false;

    // 둘 다 구해 놓고 잇는다. edgeSpecFor는 스크래치를 덮어쓰므로 하나를
    // 쓰는 동안 다른 하나를 만들 수 없다.
    const specA = edgeSpecFor(a, s0, s1);
    const specB = edgeSpecFor(b, s0, s1);
    if (specA === null || specB === null) return false;

    const [forward, backward] = linkSurfaces(a.surface, specA, b.surface, specB);
    madeEdges.push({ surface: a.surface, edge: forward });
    madeEdges.push({ surface: b.surface, edge: backward });
    return true;
  }

  /** 모서리를 만들 때 함께 볼 면들. 평면에서 나온 것 + 손으로 세운 것. */
  function joinables(): Joinable[] {
    const list: Joinable[] = [];
    for (const shell of byPlane.values()) {
      list.push({
        surface: shell.surface,
        halfX: shell.width / 2,
        centerZ: 0,
        halfZ: shell.depth / 2,
        // 사각형은 평면 끝이고 범위는 거기서 EDGE_MARGIN 안쪽이다. 모서리는
        // 그 범위보다 EDGE_OFFSET 바깥에 둔다.
        margin: EDGE_MARGIN - EDGE_OFFSET,
      });
    }
    // 손으로 세운 면은 사각형이 곧 활동 범위다. 모서리만 그만큼 바깥으로.
    for (const extra of extras) list.push({ ...extra, margin: -EDGE_OFFSET });
    return list;
  }

  /**
   * 껍데기 면끼리의 모서리를 전부 다시 만든다.
   *
   * 고쳐 끼우지 않고 통째로 버린다. 면이 하나 늘면 법선 판정 기준점이 움직여
   * 다른 면이 뒤집힐 수 있고, 모양이 다듬어지면 사각형 중심도 함께 움직인다.
   * 어느 모서리가 영향을 받는지 따지는 것보다 다시 세우는 쪽이 짧다.
   *
   * 배열을 비우지 않고 우리가 만든 것만 골라 뺀다. 손으로 세운 면에는 손으로
   * 적은 모서리가 같은 배열에 들어 있다 — 책상 상판과 옆면이 그렇다.
   */
  function rebuildEdges(): number {
    for (const made of madeEdges) {
      const at = made.surface.edges.indexOf(made.edge);
      if (at >= 0) made.surface.edges.splice(at, 1);
    }
    madeEdges.length = 0;

    const targets = joinables();
    let count = 0;
    for (let i = 0; i < targets.length; i += 1) {
      for (let j = i + 1; j < targets.length; j += 1) {
        if (linkPair(targets[i], targets[j])) count += 1;
      }
    }
    return count;
  }

  function dispose(plane: XRPlane): void {
    const shell = byPlane.get(plane);
    if (shell === undefined) return;

    shell.pose.removeFromParent();
    byPlane.delete(plane);
    shapeTimes.delete(plane);
    lastSeen.delete(plane);
  }

  const shell: RoomShell = {
    surfaces: [],
    edgeCount: 0,
    removed: [],

    rebuild() {
      this.edgeCount = rebuildEdges();
    },

    sync(frame, referenceSpace, insidePoint) {
      const detectedPlanes = frame.detectedPlanes;
      if (detectedPlanes === undefined) return [];

      const added: ShellSurface[] = [];
      /**
       * 면 구성이 바뀌었는지. 그러면 법선 판정과 모서리를 다시 세운다.
       *
       * 사라진 평면도 여기 포함된다 — 남은 모서리가 치워 버린 면을 가리키고
       * 있으면 그 모서리를 넘는 바퀴가 씬에서 떨어져 나간다.
       */
      let reshaped = false;

      const now = performance.now();
      this.removed.length = 0;

      for (const plane of [...byPlane.keys()]) {
        if (detectedPlanes.has(plane)) {
          lastSeen.set(plane, now);
          continue;
        }
        // 아직 기다려 본다. 위 상수의 주석 참고.
        if (now - (lastSeen.get(plane) ?? now) < VANISH_GRACE) continue;

        const gone = byPlane.get(plane);
        if (gone !== undefined) this.removed.push(gone);
        dispose(plane);
        reshaped = true;
      }

      for (const plane of detectedPlanes) {
        const label = labelOf(plane);
        if (!SHELL_LABELS.has(label)) continue;

        const pose = frame.getPose(plane.planeSpace, referenceSpace);
        // 추적을 놓친 프레임. 자세를 모르면 세울 수도, 갱신할 수도 없다.
        if (pose === undefined || pose === null) continue;

        let shell = byPlane.get(plane);

        if (shell === undefined) {
          const rect = boundingRect(plane);
          if (rect.halfX * 2 < MIN_EXTENT || rect.halfZ * 2 < MIN_EXTENT) continue;

          const poseNode = new THREE.Group();
          parent.add(poseNode);

          shell = {
            plane,
            label,
            pose: poseNode,
            surface: makeWalkSurface(poseNode),
            width: 0,
            depth: 0,
            flipped: false,
          };

          // 방 껍데기는 '머물며 살피는' 면이다. 지나가는 길이 아니라,
          // 여기서 가장자리를 따라 돌아다닌다.
          shell.surface.hugEdges = true;
          shell.surface.drift = null;

          byPlane.set(plane, shell);
          shapeTimes.set(plane, plane.lastChangedTime);
          applyRect(shell);
          added.push(shell);
          reshaped = true;
        } else if (shapeTimes.get(plane) !== plane.lastChangedTime) {
          shapeTimes.set(plane, plane.lastChangedTime);
          applyRect(shell);
          reshaped = true;
        }

        planeMatrix.fromArray(pose.transform.matrix);
        shell.pose.position.setFromMatrixPosition(planeMatrix);
        shell.pose.quaternion.setFromRotationMatrix(planeMatrix);

        // scene.matrixWorldAutoUpdate가 꺼져 있어서 직접 갱신한다. 바퀴를
        // 올려놓거나 모서리를 넘길 때 matrixWorld를 읽는데, 그게 렌더보다
        // 먼저 돌기 때문이다.
        shell.pose.updateMatrixWorld(true);
      }

      if (reshaped) {
        // 순서가 중요하다. 뒤집기가 면의 법선을 바꾸므로 모서리는 그다음이다.
        decideFlips(insidePoint);
        this.edgeCount = rebuildEdges();
      }

      this.surfaces = [...byPlane.values()];
      return added;
    },
  };

  return shell;
}
