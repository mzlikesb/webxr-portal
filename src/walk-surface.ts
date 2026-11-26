import * as THREE from 'three';

// ---------------------------------------------------------------------------
// 걸어 다닐 수 있는 면과 그 사이의 모서리
//
// 면 하나는 Object3D 하나다. 로컬 XZ 평면이 걷는 바닥이고 +Y가 바깥 법선이다.
// 바퀴벌레는 자기가 어떤 면 위에 있는지 모른다 — 늘 부모의 XZ를 걸을 뿐이다.
//
// ── 모서리는 면마다 '목록'이다 ──
//
// 처음에는 면마다 나가는 모서리 하나와 돌아가는 모서리 하나뿐이었고, 면들이
// next/prev로 일직선으로 엮여 있었다. 복도 → 벽 → 바닥까지는 그것으로 됐다.
//
// 책상이 그 모델을 깼다. 상판은 네 변 어디로든 내려갈 수 있고, 한쪽으로
// 올라가 반대쪽으로 내려오면 바닥으로 되돌아오는 '고리'가 생긴다. 일직선으로는
// 표현할 수 없다. 그래서 면은 모서리 목록을 들고, 모서리마다 넘어갈 면을
// 가리킨다 — 리스트가 아니라 그래프다.
//
// ── 방향은 모서리 축을 기준으로 분해해서 옮긴다 ──
//
// 전에는 면의 원점을 모서리 위에 두고 로컬 X를 모서리와 나란히 둬서, 넘어갈 때
// heading을 그냥 넘겼다. 한 면에 모서리가 하나일 때만 가능한 요령이다. 상판은
// 원점이 네 변 중 한 곳에만 있을 수 있으므로 더는 성립하지 않는다.
//
// 그래서 진짜 변환을 쓴다. 진행 방향을 모서리 축 성분과 그에 수직인 성분으로
// 나누고, 수직 성분만 새 면 안쪽으로 다시 세운다. 축 성분은 그대로 간다.
// 비스듬히 모서리를 넘으면 비스듬한 채로 넘어간다.
// ---------------------------------------------------------------------------

export interface SurfaceEdge {
  /**
   * 면의 로컬 XZ에서 모서리 바깥을 향하는 단위 법선.
   *
   * 축과 부호 대신 법선을 쓰는 이유: 책상은 벽과 나란하다는 보장이 없고,
   * 바닥에서 본 책상 발자국은 네 변짜리 사각형이다. 축에 정렬된 모서리로는
   * 그런 것을 적을 수 없다. 직선 하나는 법선과 거리로 적으면 방향을 안 탄다.
   */
  nx: number;
  nz: number;
  /** 그 법선 방향으로 이만큼을 넘으면 모서리를 넘은 것이다. */
  at: number;
  /** 모서리를 따라간 좌표의 중심. 모서리가 면의 원점을 지나지 않을 수 있다. */
  alongCenter: number;
  /**
   * 모서리가 실제로 뚫려 있는 반폭. 벽면 위쪽이 그렇다 — 구멍 폭 안이면
   * 복도로 이어지고 그 밖은 막힌 벽이다. Infinity면 전체가 열려 있다.
   */
  halfWidth: number;
  /**
   * 모서리 바로 바깥의 '띠' 두께. 이 띠 안에서만 넘어간다.
   *
   * 반평면으로만 판정하면, 책상 건너편 바닥에 있는 바퀴도 '가까운 쪽 옆면을
   * 넘어섰다'로 잡힌다. 한 프레임에 1cm도 못 가므로 얇은 띠면 실제로 건너는
   * 순간만 잡힌다. Infinity면 띠 없이 반평면 전체다.
   */
  band: number;
  to: WalkSurface;
}

export interface WalkSurface {
  node: THREE.Group;
  edges: SurfaceEdge[];
  /** 가장자리에 붙어 다닐지. 머물며 살피는 면에서만 켠다. */
  hugEdges: boolean;
  /** 이 면 위에서 가고 싶어 하는 방향(heading). null이면 목적 없이 방황. */
  drift: number | null;
  /** 돌아다닐 범위. 면의 로컬 XZ에서 (0, boundCenterZ)를 중심으로 한 원. */
  boundCenterZ: number;
  boundRadius: number;
  /** 이 z보다 뒤로는 면이 없다. null이면 원만으로 충분하다. */
  backLimitZ: number | null;
  /** 그 선에 뚫려 있는 문의 반폭. */
  backHalfWidth: number;
}

const normalAxis = new THREE.Vector3();
const forwardAxis = new THREE.Vector3();
const rightAxis = new THREE.Vector3();
const basis = new THREE.Matrix4();

/**
 * 면의 자세를 세운다.
 *
 * @param normal 면에서 바깥으로 나오는 방향(월드). 바퀴의 등이 향하는 쪽.
 * @param forwardHint 이 면 위에서 heading 0이 가리킬 방향(월드).
 *                    법선 성분은 버리므로 대충 줘도 된다.
 */
export function orientSurface(
  node: THREE.Object3D,
  normal: THREE.Vector3,
  forwardHint: THREE.Vector3,
): void {
  normalAxis.copy(normal).normalize();
  // 힌트에서 법선 성분을 빼면 면 위에 눕는다(그람-슈미트 한 단계).
  forwardAxis
    .copy(forwardHint)
    .addScaledVector(normalAxis, -forwardHint.dot(normalAxis))
    .normalize();
  rightAxis.crossVectors(normalAxis, forwardAxis).normalize();

  basis.makeBasis(rightAxis, normalAxis, forwardAxis);
  node.quaternion.setFromRotationMatrix(basis);
}

export function makeWalkSurface(parent: THREE.Object3D): WalkSurface {
  const node = new THREE.Group();
  parent.add(node);
  return {
    node,
    edges: [],
    hugEdges: false,
    drift: null,
    boundCenterZ: 0,
    boundRadius: 0.12,
    backLimitZ: null,
    backHalfWidth: 0,
  };
}

type EdgeSpec = Partial<Omit<SurfaceEdge, 'to'>> & Pick<SurfaceEdge, 'nx' | 'nz' | 'at'>;

function fillEdge(spec: EdgeSpec, to: WalkSurface): SurfaceEdge {
  return {
    alongCenter: 0,
    halfWidth: Infinity,
    band: Infinity,
    ...spec,
    to,
  };
}

/** 두 면을 한 모서리로 잇는다. 양쪽에 서로를 가리키는 모서리가 하나씩 생긴다. */
export function linkSurfaces(
  a: WalkSurface,
  aEdge: EdgeSpec,
  b: WalkSurface,
  bEdge: EdgeSpec,
): [SurfaceEdge, SurfaceEdge] {
  const forward = fillEdge(aEdge, b);
  const backward = fillEdge(bEdge, a);
  a.edges.push(forward);
  b.edges.push(backward);
  return [forward, backward];
}

export interface Walker {
  root: THREE.Object3D;
  placeOn(
    parent: THREE.Object3D,
    x: number,
    z: number,
    newHeading: number,
    fromPose?: THREE.Quaternion,
  ): void;
  getHeading(): number;
  setDrift(newHeading: number | null): void;
  setBounds(centerZ: number, radius: number): void;
  setBackLimit(z: number | null, halfWidth: number): void;
  setHugEdges(on: boolean): void;
}

const fromWorld = new THREE.Quaternion();
const toWorld = new THREE.Quaternion();
const relativePose = new THREE.Quaternion();

const crossPoint = new THREE.Vector3();
const edgeDir = new THREE.Vector3();
const forwardWorld = new THREE.Vector3();
const intoNext = new THREE.Vector3();
const nextNormal = new THREE.Vector3();
const nextInside = new THREE.Vector3();
const localPoint = new THREE.Vector3();
const localForward = new THREE.Vector3();

function applySurface(walker: Walker, surface: WalkSurface, drift: number | null): void {
  walker.setDrift(drift);
  walker.setBounds(surface.boundCenterZ, surface.boundRadius);
  walker.setBackLimit(surface.backLimitZ, surface.backHalfWidth);
  walker.setHugEdges(surface.hugEdges);
}

/**
 * 모서리를 넘었으면 옮기고 새 면을 돌려준다. 안 넘었으면 그대로.
 *
 * 넘어가는 쪽 면이 '가고 싶은 방향'을 가지고 있어도, 들어오는 방향이 그 면의
 * drift와 반대라면 지우는 편이 낫다. 벽을 타고 올라온 바퀴가 벽면의 '아래로'
 * 성향에 붙들려 곧장 다시 내려가는 핑퐁을 막기 위한 것이다.
 */
export function transferIfCrossed(walker: Walker, current: WalkSurface): WalkSurface {
  const position = walker.root.position;

  for (const edge of current.edges) {
    // 법선 방향으로 얼마나 넘어갔는지.
    const past = position.x * edge.nx + position.z * edge.nz - edge.at;
    if (past <= 0 || past > edge.band) continue;

    // 그 방향으로 가고 있을 때만 넘는다.
    //
    // 띠만으로 막으려 했더니, 프레임이 느릴 때 한 번에 띠를 통째로 건너뛰어
    // 모서리를 못 잡았다. 띠를 넓히면 이번엔 책상 건너편에 있는 바퀴까지
    // 걸린다. 진행 방향을 보면 둘 다 풀린다 — 넘어가는 건 그쪽으로 가고
    // 있을 때뿐이고, 멀리서 가만히 있거나 멀어지는 중이면 아니다.
    const h = walker.getHeading();
    if (Math.sin(h) * edge.nx + Math.cos(h) * edge.nz <= 0) continue;

    // 모서리를 따라간 좌표. 이 범위 밖이면 그 자리에 모서리가 없다.
    const along = -position.x * edge.nz + position.z * edge.nx;
    if (Math.abs(along - edge.alongCenter) > edge.halfWidth) continue;

    const next = edge.to;

    // ── 월드에서 모서리 축과 진행 방향을 잡는다 ──
    current.node.updateMatrixWorld();
    next.node.updateMatrixWorld();

    // 모서리 선의 방향 = 법선을 90° 돌린 것.
    edgeDir
      .set(-edge.nz, 0, edge.nx)
      .applyQuaternion(current.node.getWorldQuaternion(fromWorld))
      .normalize();

    // 지금 진행 방향(월드). 이 면 위에 누워 있다.
    const heading = walker.getHeading();
    forwardWorld
      .set(Math.sin(heading), 0, Math.cos(heading))
      .applyQuaternion(fromWorld)
      .normalize();

    // 모서리 축 성분과 그에 수직인 성분으로 나눈다.
    const along0 = forwardWorld.dot(edgeDir);
    const across = Math.sqrt(Math.max(0, 1 - along0 * along0));

    // 새 면에서 '모서리로부터 안쪽으로' 들어가는 방향.
    // 모서리 축과 새 면의 법선에 둘 다 수직인 방향이 둘인데, 새 면의 안쪽을
    // 향하는 쪽을 고른다. 기준점은 그 면의 활동 범위 중심이다.
    next.node.getWorldQuaternion(toWorld);
    nextNormal.set(0, 1, 0).applyQuaternion(toWorld);
    intoNext.crossVectors(edgeDir, nextNormal).normalize();

    crossPoint.copy(position);
    current.node.localToWorld(crossPoint);
    nextInside.set(0, 0, next.boundCenterZ);
    next.node.localToWorld(nextInside);
    if (intoNext.dot(nextInside.sub(crossPoint)) < 0) intoNext.negate();

    // 새 진행 방향 = 모서리를 따르던 만큼 + 가로지르던 만큼(새 면 안쪽으로).
    forwardWorld.copy(edgeDir).multiplyScalar(along0).addScaledVector(intoNext, across);

    // ── 새 면의 로컬로 옮긴다 ──
    localPoint.copy(crossPoint);
    next.node.worldToLocal(localPoint);
    localForward.copy(forwardWorld).applyQuaternion(toWorld.clone().invert());

    // 모서리에 정확히 걸쳐 두면 다음 프레임에 또 넘어간 것으로 보인다.
    // 진행 방향으로 2mm 밀어 안쪽에 놓는다.
    const newHeading = Math.atan2(localForward.x, localForward.z);
    const nudgeX = localPoint.x + Math.sin(newHeading) * 0.002;
    const nudgeZ = localPoint.z + Math.cos(newHeading) * 0.002;

    // 새 면에서 본 옛 면의 자세. 몸이 여기서부터 녹아 새 면에 눕는다.
    relativePose.copy(toWorld).invert().multiply(fromWorld);

    walker.placeOn(next.node, nudgeX, nudgeZ, newHeading, relativePose);

    // 넘어온 방향이 그 면의 drift와 거꾸로면 목적지를 지운다.
    let drift = next.drift;
    if (drift !== null) {
      const want = Math.sin(drift) * Math.sin(newHeading) + Math.cos(drift) * Math.cos(newHeading);
      if (want < 0) drift = null;
    }
    applySurface(walker, next, drift);

    return next;
  }

  return current;
}
