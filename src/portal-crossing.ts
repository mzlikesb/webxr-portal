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
// ── 평면과 재질은 모두가 나눠 쓴다 ──
//
// 포털은 하나뿐이므로 자르는 평면도 한 쌍이면 된다. 그리고 재질을 물체마다
// 복제하면 인스턴싱으로 묶이지 않는다 — 같은 지오메트리라도 재질이 다르면
// 다른 드로우콜이다. 그래서 둘 다 모듈 수준에 하나씩 둔다.
// ---------------------------------------------------------------------------

/** 방 쪽 반공간만 남긴다. three.js의 클리핑은 법선이 가리키는 쪽을 살린다. */
const frontPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 1e4);
/** 같은 평면, 반대 방향. 둘이 합쳐 공간 전체를 빈틈없이 덮는다. */
const backPlane = new THREE.Plane(new THREE.Vector3(0, 0, -1), 1e4);

const outsideVariants = new Map<THREE.Material, THREE.Material>();
const insideVariants = new Map<THREE.Material, THREE.Material>();

let stencilRef = 1;
let disabled = true;

/**
 * 포털 평면이 놓인 자리를 알려 준다. 포털을 옮기면 다시 부른다.
 * @param point 평면 위의 한 점(월드)
 * @param normal 방 쪽을 향하는 법선(월드)
 */
export function setPortalPlane(point: THREE.Vector3, normal: THREE.Vector3): void {
  frontPlane.setFromNormalAndCoplanarPoint(normal, point);
  backPlane.copy(frontPlane).negate();
  disabled = false;
}

/** 포털이 아직 없을 때. 아무것도 자르지 않고, 안쪽 복사본은 그리지 않는다. */
export function disablePortalPlane(): void {
  // 아주 먼 곳으로 밀어 두면 아무것도 잘리지 않는다.
  frontPlane.constant = 1e4;
  backPlane.constant = 1e4;
  disabled = true;
}

/** 포털 마스크가 스텐실에 찍는 값. 복사본을 만들기 전에 정해야 한다. */
export function setPortalStencilRef(ref: number): void {
  stencilRef = ref;
}

/** 안쪽 복사본 재질의 원래 투명도. 페이드는 여기에 곱한다. */
const insideBaseOpacity = new Map<THREE.Material, number>();

/** 포털이 흐려지는 만큼 안쪽 복사본도 같이 흐려진다. */
export function setInsidePortalOpacity(k: number): void {
  for (const [material, base] of insideBaseOpacity) {
    material.opacity = base * k;
    material.visible = k > 0;
  }
}

function variantOf(
  material: THREE.Material,
  cache: Map<THREE.Material, THREE.Material>,
  configure: (m: THREE.Material) => void,
): THREE.Material {
  const cached = cache.get(material);
  if (cached !== undefined) return cached;

  const copy = material.clone();
  configure(copy);
  cache.set(material, copy);
  if (cache === insideVariants) insideBaseOpacity.set(copy, copy.opacity);
  return copy;
}

function replaceMaterials(
  object: THREE.Object3D,
  cache: Map<THREE.Material, THREE.Material>,
  configure: (m: THREE.Material) => void,
): void {
  object.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (mesh.material === undefined) return;

    mesh.material = Array.isArray(mesh.material)
      ? mesh.material.map((m) => variantOf(m, cache, configure))
      : variantOf(mesh.material, cache, configure);
  });
}

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

export interface PortalCrossing {
  /** 안쪽 복사본. 배칭에 등록하려면 바깥에서도 쥐고 있어야 한다. */
  inside: THREE.Object3D;
  /** 매 프레임. 바깥 복사본의 자세를 안쪽 복사본에 그대로 옮긴다. */
  sync(): void;
}

/** @param outside 이미 씬에 들어 있는 물체. 이것이 '바깥 복사본'이 된다. */
export function makePortalCrossing(outside: THREE.Object3D): PortalCrossing {
  const inside = outside.clone(true);
  outside.parent?.add(inside);

  // 바깥: 자르기만 한다. 스텐실은 건드리지 않는다.
  replaceMaterials(outside, outsideVariants, (m) => {
    m.clippingPlanes = [frontPlane];
  });

  // 안쪽: 반대쪽을 남기고, 포털 마스크가 찍어 둔 자리에만 그린다.
  //
  // 포털이 근접 페이드로 흐려질 때 같이 흐려져야 해서 transparent로 둔다.
  // 처음에 안 묶어 뒀더니 복도만 사라지고 그 안의 바퀴는 불투명하게 남아,
  // 허공에 바퀴만 떠 있는 그림이 됐다. 런타임에 transparent를 켜면 셰이더가
  // 다시 컴파일되므로 만들 때부터 켜 둔다.
  replaceMaterials(inside, insideVariants, (m) => {
    m.clippingPlanes = [backPlane];
    m.stencilWrite = true;
    m.stencilRef = stencilRef;
    m.stencilFunc = THREE.EqualStencilFunc;
    m.transparent = true;
  });

  // 마스크(renderOrder -1)보다 반드시 나중에 그려야 스텐실이 이미 찍혀 있다.
  inside.traverse((node) => {
    node.renderOrder = 1;
  });

  return {
    inside,

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
      // 포털이 없으면 안쪽 복사본은 그릴 이유가 없다.
      inside.visible = outside.visible && !disabled;
    },
  };
}
