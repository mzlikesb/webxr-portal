import * as THREE from 'three';

// ---------------------------------------------------------------------------
// 걸어 다닐 수 있는 면과 그 사이의 모서리
//
// 면 하나는 Object3D 하나다. 로컬 XZ 평면이 걷는 바닥이고 +Y가 바깥 법선이다.
// 바퀴벌레는 자기가 어떤 면 위에 있는지 모른다 — 늘 부모의 XZ를 걸을 뿐이다.
//
// ── 규칙: 면의 원점은 '들어오는 모서리' 위에, 로컬 X는 그 모서리와 나란히 ──
//
// 이 규칙 하나가 모서리 넘기를 거의 공짜로 만든다. 두 면이 이렇게 놓이면
// 월드에서 같은 점, 같은 X축을 공유하므로:
//
//   · 로컬 x 좌표가 그대로 보존된다
//   · heading 각도도 그대로 보존된다
//
// 90°가 꺾이는 일은 두 면의 Z축이 이미 흡수하고 있다. 앞 면에서 +Z가
// '구멍 밖으로'였다면 뒤 면에서 +Z는 '벽을 타고 아래로'다. 직진하던 바퀴는
// 각도를 바꾸지 않고도 벽을 타게 된다.
//
// 일반적인 두 면을 잇는 변환을 쓰려면 모서리 축을 기준으로 방향 벡터를
// 분해해야 하는데, 면을 이렇게 배치할 수 있는 한 그럴 이유가 없다.
// ---------------------------------------------------------------------------

export interface WalkSurface {
  node: THREE.Group;
  /** 로컬 z가 이 값을 넘으면 next로 넘어간다. null이면 사방이 막힌 면. */
  exitZ: number | null;
  next: WalkSurface | null;
  /** 로컬 z가 0보다 작아지면 돌아가는 면. 모서리는 양방향이다. */
  prev: WalkSurface | null;
  /** 되돌아가는 모서리가 실제로 뚫려 있는 반폭. 그 밖은 막힌 벽이다. */
  backHalfWidth: number;
  /** 이 면 위에서 가고 싶어 하는 방향(heading). null이면 목적 없이 방황. */
  drift: number | null;
  /** 돌아다닐 범위. 면의 로컬 XZ에서 (0, boundCenterZ)를 중심으로 한 원. */
  boundCenterZ: number;
  boundRadius: number;
  /** 이 z보다 뒤로는 면이 없다. null이면 원만으로 충분하다. */
  backLimitZ: number | null;
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
    exitZ: null,
    next: null,
    prev: null,
    backHalfWidth: 0,
    drift: null,
    boundCenterZ: 0,
    boundRadius: 0.12,
    backLimitZ: null,
  };
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
  setExitZ(z: number | null): void;
  setDrift(newHeading: number | null): void;
  setBounds(centerZ: number, radius: number): void;
  setBackLimit(z: number | null, halfWidth: number): void;
}

const fromWorld = new THREE.Quaternion();
const toWorld = new THREE.Quaternion();
const relativePose = new THREE.Quaternion();

function moveTo(
  walker: Walker,
  from: WalkSurface,
  to: WalkSurface,
  z: number,
  drift: number | null,
): WalkSurface {
  // 새 면에서 본 옛 면의 자세. 몸이 여기서부터 녹아 새 면에 눕는다.
  // 두 면의 '차이'만 담기므로 heading은 섞이지 않는다.
  from.node.getWorldQuaternion(fromWorld);
  to.node.getWorldQuaternion(toWorld);
  relativePose.copy(toWorld).invert().multiply(fromWorld);

  // 배치 규칙 덕분에 x와 heading을 그대로 넘긴다. z만 새 면 기준으로 바꾼다.
  walker.placeOn(to.node, walker.root.position.x, z, walker.getHeading(), relativePose);
  walker.setExitZ(to.exitZ);
  walker.setDrift(drift);
  walker.setBounds(to.boundCenterZ, to.boundRadius);
  walker.setBackLimit(to.backLimitZ, to.backHalfWidth);
  return to;
}

/**
 * 모서리를 넘었으면 옮기고 새 면을 돌려준다. 안 넘었으면 그대로.
 *
 * 모서리는 양방향이다. 앞 모서리(exitZ)를 넘으면 next로, 뒤 모서리(z < 0)를
 * 넘으면 prev로 간다. 배치 규칙이 대칭이라 같은 변환이 양쪽에 다 쓰인다 —
 * 바닥에서 벽을 타고 올라가는 것이 벽에서 바닥으로 내려오는 것의 역이다.
 */
export function transferIfCrossed(walker: Walker, current: WalkSurface): WalkSurface {
  const z = walker.root.position.z;

  if (current.exitZ !== null && current.next !== null && z > current.exitZ) {
    // 모서리에 정확히 걸쳐 두면 다음 프레임에 또 넘어간 것으로 보인다.
    // 살짝 안쪽에 놓는다.
    // 앞으로 가는 건 '나가는 길'이다. 그 면이 정한 방향을 따른다.
    return moveTo(walker, current, current.next, 0.002, current.next.drift);
  }

  if (current.prev !== null && z < 0) {
    // 뒤 모서리가 뚫려 있는 폭 안에서만 넘어간다. 벽면의 위쪽이 그렇다 —
    // 구멍 폭 안이면 복도로 이어지고, 그 밖은 벽이라 넘어갈 데가 없다.
    if (Math.abs(walker.root.position.x) > current.backHalfWidth) return current;

    const prevExit = current.prev.exitZ;
    if (prevExit === null) return current;
    // 되돌아가는 건 나가는 길이 아니다. 목적지를 지우지 않으면, 벽을 타고
    // 올라온 바퀴가 벽면의 '아래로' 성향에 붙들려 곧장 다시 내려간다.
    return moveTo(walker, current, current.prev, prevExit - 0.002, null);
  }

  return current;
}
