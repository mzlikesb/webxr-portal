import * as THREE from 'three';

// ---------------------------------------------------------------------------
// 포털 평면을 가로지르는 물체 그리기
//
// 한 물체가 동시에 '구멍으로만 보이는' 상태와 '그냥 보이는' 상태일 수는 없다.
// 스텐실 테스트는 재질마다 하나뿐이고, 몸의 절반은 벽 뒤, 절반은 방 안에 있다.
//
// 그래서 같은 물체를 두 벌 그린다. 각자 반쪽씩만 맡는다.
//
//            포털 평면
//                │
//   복도(벽 뒤)   │   방(이쪽)
//                │
//      안쪽 복사본 │ 바깥 복사본
//   스텐실 Equal  │  스텐실 없음
//   뒤쪽만 남김    │  앞쪽만 남김
//
// 둘이 평면에서 정확히 맞닿으므로 이음새가 보이지 않는다. 반을 자르는 일은
// 클리핑 평면이 한다 — 지오메트리를 건드리지 않고 프래그먼트 단위로 버린다.
//
// 쓰려면 renderer.localClippingEnabled = true 가 필요하다.
//
// ── 파이프가 여럿일 때 ──
//
// 파이프마다 평면이 다르고 스텐실 값도 달라야 한다. 한 벌을 모두가 나눠 쓰면
// 벽에 뚫린 구멍의 평면으로 천장 파이프 속의 바퀴를 자르게 된다.
//
// 그런데 바깥 복사본은 여전히 한 벌이면 된다. three.js의 클리핑 평면 배열은
// 교집합이다 — '모든 평면의 앞쪽'만 남는다. 그리고 방은 정확히 그 교집합이다:
// 방 안에 있는 바퀴는 모든 파이프의 평면보다 앞에 있고, 어느 관 속에 들어간
// 바퀴는 그 관의 평면 하나에서만 떨어진다. 그러니 모든 파이프의 앞면 평면을
// 한 배열에 모아 재질 하나에 걸면 N개가 한 번에 맞는다. 재질이 하나로 남아야
// 인스턴싱이 묶이므로, 이건 편의가 아니라 성능 조건이다.
//
// 안쪽 복사본은 그렇게 안 된다. '어느 한 관의 뒤쪽'은 합집합이고, 클리핑
// 평면으로는 합집합을 적을 수 없다. 그래서 안쪽만 파이프 수만큼 사본을 둔다.
// 바퀴 한 마리는 한 번에 한 관에만 있으므로, 자기 관의 사본을 끼워 쓴다.
//
// ── 평면 개수는 처음에 못 박힌다 ──
//
// 클리핑 평면의 '개수'는 셰이더에 상수로 박혀 컴파일된다. 런타임에 배열 길이를
// 바꾸면 그 프레임에 셰이더가 다시 컴파일돼 화면이 튄다. 그래서 preparePipes로
// 처음에 자리를 다 잡아 두고, 안 쓰는 파이프는 평면을 아주 먼 곳에 두어
// 아무것도 자르지 않게 한다.
// ---------------------------------------------------------------------------

/** 파이프 하나가 쓰는 자르는 평면 한 쌍과, 그 파이프 전용 재질 사본들. */
interface PipeSlot {
  /** 방 쪽 반공간만 남긴다. three.js의 클리핑은 법선이 가리키는 쪽을 살린다. */
  front: THREE.Plane;
  /** 같은 평면, 반대 방향. 둘이 합쳐 공간 전체를 빈틈없이 덮는다. */
  back: THREE.Plane;
  /** 원래 재질 → 이 파이프의 안쪽 복사본이 쓸 재질. */
  inside: Map<THREE.Material, THREE.Material>;
  /** 그 사본들의 원래 투명도. 페이드는 덮어쓰지 않고 여기에 곱한다. */
  baseOpacity: Map<THREE.Material, number>;
  /** 아직 뚫리지 않은 파이프. 안쪽 복사본을 그리지 않는다. */
  disabled: boolean;
}

const slots: PipeSlot[] = [];

/** 바깥 복사본이 쓰는 재질. 파이프가 몇이든 한 벌이다(위 주석 참고). */
const outsideVariants = new Map<THREE.Material, THREE.Material>();
/** 그 재질에 걸리는 자르는 평면들. 파이프마다 앞면 평면 하나씩. */
const outsideClip: THREE.Plane[] = [];

/**
 * 파이프 자리를 count개 잡아 둔다. 복사본을 만들기 전에 딱 한 번 부른다.
 *
 * 나중에 늘릴 수 없다 — 평면 개수가 셰이더에 박히기 때문이다(위 주석 참고).
 */
export function preparePipes(count: number): void {
  if (slots.length > 0) return;

  for (let i = 0; i < count; i += 1) {
    const front = new THREE.Plane(new THREE.Vector3(0, 0, 1), 1e4);
    const back = new THREE.Plane(new THREE.Vector3(0, 0, -1), 1e4);
    slots.push({
      front,
      back,
      inside: new Map(),
      baseOpacity: new Map(),
      disabled: true,
    });
    outsideClip.push(front);
  }
}

/**
 * 파이프 하나의 평면이 놓인 자리를 알려 준다. 파이프를 옮기면 다시 부른다.
 *
 * @param point 평면 위의 한 점(월드)
 * @param normal 방 쪽을 향하는 법선(월드)
 */
export function setPipePlane(
  index: number,
  point: THREE.Vector3,
  normal: THREE.Vector3,
): void {
  const slot = slots[index];
  if (slot === undefined) return;

  slot.front.setFromNormalAndCoplanarPoint(normal, point);
  slot.back.copy(slot.front).negate();
  slot.disabled = false;
}

/** 아직 뚫리지 않은 파이프. 아무것도 자르지 않고, 안쪽 복사본도 그리지 않는다. */
export function disablePipePlane(index: number): void {
  const slot = slots[index];
  if (slot === undefined) return;

  // 아주 먼 곳으로 밀어 두면 모든 점이 앞쪽이라 아무것도 잘리지 않는다.
  slot.front.normal.set(0, 0, 1);
  slot.front.constant = 1e4;
  slot.back.normal.set(0, 0, -1);
  slot.back.constant = 1e4;
  slot.disabled = true;
}

/** 파이프 index의 마스크가 스텐실에 찍는 값. 0은 '아무것도 없음'이라 피한다. */
export function pipeStencilRef(index: number): number {
  return index + 1;
}

/** 그 파이프가 흐려지는 만큼 그 안의 바퀴도 같이 흐려진다. */
export function setPipeInsideOpacity(index: number, k: number): void {
  const slot = slots[index];
  if (slot === undefined) return;

  for (const [material, base] of slot.baseOpacity) {
    material.opacity = base * k;
    material.visible = k > 0;
  }
}

function outsideVariantOf(material: THREE.Material): THREE.Material {
  const cached = outsideVariants.get(material);
  if (cached !== undefined) return cached;

  const copy = material.clone();
  copy.clippingPlanes = outsideClip;
  outsideVariants.set(material, copy);
  return copy;
}

function insideVariantOf(index: number, material: THREE.Material): THREE.Material {
  const slot = slots[index];
  const cached = slot.inside.get(material);
  if (cached !== undefined) return cached;

  const copy = material.clone();
  copy.clippingPlanes = [slot.back];
  copy.stencilWrite = true;
  copy.stencilRef = pipeStencilRef(index);
  copy.stencilFunc = THREE.EqualStencilFunc;
  // 파이프가 근접 페이드로 흐려질 때 같이 흐려져야 해서 transparent로 둔다.
  // 처음에 안 묶어 뒀더니 복도만 사라지고 그 안의 바퀴는 불투명하게 남아,
  // 허공에 바퀴만 떠 있는 그림이 됐다. 런타임에 transparent를 켜면 셰이더가
  // 다시 컴파일되므로 만들 때부터 켜 둔다.
  copy.transparent = true;

  slot.inside.set(material, copy);
  slot.baseOpacity.set(copy, copy.opacity);
  return copy;
}

/**
 * 구멍에서 이만큼 나왔으면 안쪽 복사본을 아예 끈다(m).
 *
 * 안쪽 복사본은 자기 관의 평면 뒤만 남긴다. 방에 나와 버린 바퀴는 통째로
 * 잘려서 픽셀 하나 안 그리는데, 드로우콜은 그대로 든다 — 파이프가 셋이 되자
 * 안쪽 재질이 세 벌이 되면서 51개였던 드로우콜이 113개가 됐다.
 *
 * 몸길이의 두 배로 잡는다. 이 거리는 바퀴 뿌리에서 재므로 몸 전체가 평면
 * 앞에 있어야 하고, matrixWorld가 한 프레임 묵었을 수 있다는 것까지 덮는다
 * (배칭이 행렬을 모으는 건 이 다음이다). 한 프레임에 3mm 움직이는 몸이다.
 */
const INSIDE_CULL_AT = 0.08;

const insidePoint = new THREE.Vector3();

/** 두 계층을 나란히 훑으며 자세를 옮긴다. 복제본이라 구조가 똑같다. */
function copyTransforms(from: THREE.Object3D, to: THREE.Object3D): void {
  to.position.copy(from.position);
  to.quaternion.copy(from.quaternion);
  to.scale.copy(from.scale);
  to.visible = from.visible;

  const children = from.children;
  for (let i = 0; i < children.length; i += 1) {
    const target = to.children[i];
    if (target !== undefined) copyTransforms(children[i], target);
  }
}

export interface PipeCrossing {
  /** 안쪽 복사본. 배칭에 등록하려면 바깥에서도 쥐고 있어야 한다. */
  inside: THREE.Object3D;
  /**
   * 지금 어느 파이프에 속하는지. 복도를 옮겨 타면 바꿔 준다.
   *
   * 바꾸지 않으면 다른 관에 들어간 바퀴가 통째로 사라진다 — 바깥 복사본은
   * 그 관의 평면에 잘리고, 안쪽 복사본은 엉뚱한 관의 평면에 잘려서 양쪽
   * 모두에서 빠진다.
   */
  setPipe(index: number): void;
  /** 매 프레임. 바깥 복사본의 자세를 안쪽 복사본에 그대로 옮긴다. */
  sync(): void;
}

/** @param outside 이미 씬에 들어 있는 물체. 이것이 '바깥 복사본'이 된다. */
export function makePipeCrossing(outside: THREE.Object3D): PipeCrossing {
  const inside = outside.clone(true);
  outside.parent?.add(inside);

  // 바깥: 자르기만 한다. 스텐실은 건드리지 않는다.
  outside.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (mesh.material === undefined) return;
    mesh.material = Array.isArray(mesh.material)
      ? mesh.material.map(outsideVariantOf)
      : outsideVariantOf(mesh.material);
  });

  // 안쪽: 반대쪽을 남기고, 그 파이프의 마스크가 찍어 둔 자리에만 그린다.
  // 파이프마다 재질이 다르므로 원래 재질을 기억해 두고 갈아 끼운다.
  const parts: { mesh: THREE.Mesh; original: THREE.Material }[] = [];
  inside.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (mesh.material === undefined || Array.isArray(mesh.material)) return;
    parts.push({ mesh, original: mesh.material });
    // 모든 파이프의 사본을 지금 만들어 둔다. 처음 갈아 끼울 때 만들면 그
    // 프레임에 셰이더가 컴파일되는데, 그 순간이 하필 바퀴가 관을 옮겨 타는
    // 순간이다 — 눈에 띄는 자리에서만 튀게 된다.
    for (let i = 0; i < slots.length; i += 1) insideVariantOf(i, mesh.material);
  });

  // 마스크(renderOrder -1)보다 반드시 나중에 그려야 스텐실이 이미 찍혀 있다.
  inside.traverse((node) => {
    node.renderOrder = 1;
  });

  let pipeIndex = -1;

  function setPipe(index: number): void {
    if (index === pipeIndex || slots[index] === undefined) return;
    pipeIndex = index;
    for (const part of parts) part.mesh.material = insideVariantOf(index, part.original);
  }

  setPipe(0);

  return {
    inside,
    setPipe,

    sync() {
      // 원본이 다른 면으로 옮겨 갔으면 복제본도 따라간다.
      //
      // copyTransforms는 '로컬' 변환만 옮긴다. 부모가 어긋나 있으면 복제본은
      // 엉뚱한 면 위에서 똑같은 자세로 움직인다 — 바퀴가 벽을 타고 내려가는
      // 동안 복제본만 복도 바닥에 남아 걸어 다녔다.
      if (outside.parent !== null && inside.parent !== outside.parent) {
        outside.parent.add(inside);
      }

      copyTransforms(outside, inside);

      // copyTransforms가 visible까지 옮기므로 그 뒤에 덮어써야 한다.
      // 그 파이프가 아직 안 뚫렸으면 안쪽 복사본은 그릴 이유가 없다.
      const slot = slots[pipeIndex];
      if (!outside.visible || slot.disabled) {
        inside.visible = false;
        return;
      }

      // 방으로 멀찍이 나온 놈도 그릴 이유가 없다(INSIDE_CULL_AT 주석 참고).
      outside.getWorldPosition(insidePoint);
      inside.visible = slot.front.distanceToPoint(insidePoint) < INSIDE_CULL_AT;
    },
  };
}
