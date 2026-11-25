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
  /** 이 면 위에서 가고 싶어 하는 방향(heading). null이면 목적 없이 방황. */
  drift: number | null;
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
  return { node, exitZ: null, next: null, drift: null };
}

export interface Walker {
  root: THREE.Object3D;
  placeOn(parent: THREE.Object3D, x: number, z: number, newHeading: number): void;
  setExitZ(z: number | null): void;
  setDrift(newHeading: number | null): void;
}

/**
 * 모서리를 넘었으면 다음 면으로 옮기고 그 면을 돌려준다.
 * 안 넘었으면 지금 면을 그대로 돌려준다.
 */
export function transferIfCrossed(walker: Walker, current: WalkSurface): WalkSurface {
  const { exitZ, next } = current;
  if (exitZ === null || next === null) return current;
  if (walker.root.position.z <= exitZ) return current;

  // 규칙 덕분에 x와 heading을 그대로 넘긴다. z만 새 면의 시작으로 되돌린다.
  // 0이 아니라 살짝 안쪽에 놓는 건, 모서리에 정확히 걸쳐 두면 다음 프레임에
  // 다시 넘어간 것으로 보일 수 있어서다.
  walker.placeOn(next.node, walker.root.position.x, 0.002, walker.root.rotation.y);
  walker.setExitZ(next.exitZ);
  walker.setDrift(next.drift);
  return next;
}
