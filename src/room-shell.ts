import * as THREE from 'three';
import { linkSurfaces, makeWalkSurface, type WalkSurface } from './walk-surface';

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

export interface RoomShell {
  /** 지금 살아 있는 면들. 평면이 사라지면 여기서도 빠진다. */
  surfaces: ShellSurface[];
  /** 껍데기 면끼리 이어진 모서리 수. 로그용. */
  edgeCount: number;
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
function clipToRect(halfX: number, halfZ: number, span: Span): boolean {
  span.min = -Infinity;
  span.max = Infinity;
  if (!clipAxis(localOrigin.x, localDir.x, halfX + JOIN_SLACK, span)) return false;
  return clipAxis(localOrigin.z, localDir.z, halfZ + JOIN_SLACK, span);
}

/** 월드 교선을 이 면의 로컬로 옮긴다. 결과는 localOrigin/localDir에 남는다. */
function localizeLine(shell: ShellSurface): void {
  shell.surface.node.updateMatrixWorld();
  inverseNode.copy(shell.surface.node.matrixWorld).invert();
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
  shell: ShellSurface,
  s0: number,
  s1: number,
): { nx: number; nz: number; at: number; alongCenter: number; halfWidth: number; band: number } | null {
  localizeLine(shell);

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

  let at = localOrigin.x * nx + localOrigin.z * nz;
  // 법선은 '바깥'을 향해야 한다. 면의 원점은 사각형 중심이므로, 중심에서
  // 모서리로 가는 쪽이 바깥이다.
  if (at < 0) {
    nx = -nx;
    nz = -nz;
    at = -at;
  }
  // 모서리가 사각형 중심을 지난다 = 다른 평면이 이 면을 가로질러 썰고 있다.
  // 상자 방에서는 나올 수 없는 모양이고, 그대로 쓰면 면 중앙을 넘는 순간
  // 바퀴가 옆 면으로 튄다.
  if (at < MIN_OFFSET) return null;

  const mid = (s0 + s1) / 2;
  const midX = localOrigin.x + localDir.x * mid;
  const midZ = localOrigin.z + localDir.z * mid;

  return {
    nx,
    nz,
    // 평면 끝이 아니라 활동 범위 끝에 둔다. 끝에 두면 범위가 먼저 막아서
    // 영영 못 넘는다. 손으로 세운 책상도 모서리와 범위를 같은 자리에 둔다.
    at: Math.max(0, at - EDGE_MARGIN),
    alongCenter: -midX * nz + midZ * nx,
    halfWidth: (s1 - s0) / 2,
    band: CROSS_BAND,
  };
}

/** 폴리곤을 감싸는 사각형. 평면의 로컬 XZ 기준이다. */
function boundingRect(plane: XRPlane): {
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

export function makeRoomShell(parent: THREE.Object3D): RoomShell {
  const byPlane = new Map<XRPlane, ShellSurface>();
  /** 평면의 모양이 언제 갱신됐는지. Quest는 스캔하면서 폴리곤을 다듬는다. */
  const shapeTimes = new Map<XRPlane, DOMHighResTimeStamp>();

  /** 사각형을 면의 자세와 범위에 반영한다. 모양이 다듬어지면 다시 부른다. */
  function applyRect(shell: ShellSurface): void {
    const rect = boundingRect(shell.plane);

    // 면의 원점을 사각형의 중심에 둔다. WalkSurface의 범위는 x에 대해
    // 대칭(±halfX)이라, 원점이 중심에 있지 않으면 표현할 수가 없다.
    // 위치는 부모(자세 노드)의 좌표계라 뒤집기와 무관하다.
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
      shell.flipped = flip;
    }
  }

  /**
   * 두 면이 만나면 모서리로 잇는다. 이었으면 true.
   *
   * 평면은 무한하지만 걸을 수 있는 건 사각형만큼이다. 그래서 교선을 구한
   * 뒤 양쪽 사각형으로 잘라, 둘 다 실제로 닿는 구간만 모서리로 남긴다.
   * 마주 보는 벽처럼 교선이 어느 쪽 사각형에도 닿지 않으면 여기서 걸린다.
   */
  function linkPair(a: ShellSurface, b: ShellSurface): boolean {
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

    localizeLine(a);
    if (!clipToRect(a.width / 2, a.depth / 2, spanA)) return false;
    localizeLine(b);
    if (!clipToRect(b.width / 2, b.depth / 2, spanB)) return false;

    const s0 = Math.max(spanA.min, spanB.min);
    const s1 = Math.min(spanA.max, spanB.max);
    if (s1 - s0 < MIN_OVERLAP) return false;

    // 둘 다 구해 놓고 잇는다. edgeSpecFor는 스크래치를 덮어쓰므로 하나를
    // 쓰는 동안 다른 하나를 만들 수 없다.
    const specA = edgeSpecFor(a, s0, s1);
    const specB = edgeSpecFor(b, s0, s1);
    if (specA === null || specB === null) return false;

    linkSurfaces(a.surface, specA, b.surface, specB);
    return true;
  }

  /**
   * 껍데기 면끼리의 모서리를 전부 다시 만든다.
   *
   * 고쳐 끼우지 않고 통째로 버린다. 면이 하나 늘면 법선 판정 기준점이 움직여
   * 다른 면이 뒤집힐 수 있고, 모양이 다듬어지면 사각형 중심도 함께 움직인다.
   * 어느 모서리가 영향을 받는지 따지는 것보다 다시 세우는 쪽이 짧다.
   *
   * 껍데기 면은 여기서 만든 모서리밖에 없으므로 통째로 비워도 안전하다.
   */
  function rebuildEdges(): number {
    const shells = [...byPlane.values()];
    for (const shell of shells) shell.surface.edges.length = 0;

    let count = 0;
    for (let i = 0; i < shells.length; i += 1) {
      for (let j = i + 1; j < shells.length; j += 1) {
        if (linkPair(shells[i], shells[j])) count += 1;
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
  }

  return {
    surfaces: [],
    edgeCount: 0,

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

      for (const plane of [...byPlane.keys()]) {
        if (detectedPlanes.has(plane)) continue;
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
}
