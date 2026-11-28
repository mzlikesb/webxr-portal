import * as THREE from 'three';
import type { TrackedHand } from './hands';

// ---------------------------------------------------------------------------
// 던질 물건
//
// 손바닥으로 때리는 건 이미 된다. 그런데 바퀴를 본 사람이 제일 먼저 하는 건
// 손으로 때리는 게 아니라 '뭘 집는' 것이다 — 슬리퍼든 책이든, 손이 닿기 전에
// 눈이 먼저 바닥을 훑는다. 그 동작이 없으면 방에 아무리 벌레가 많아도 손밖에
// 쓸 게 없다.
//
// 그래서 바닥에 몇 개를 깔아 둔다. 집는 것도 던지는 것도 바퀴와 똑같은
// 손짓이다 — 엄지와 검지. 새 조작을 배울 것이 없다.
//
// ── 면 위에 올려놓지 않는다 ──
//
// 바퀴는 '지금 어느 면 위인가'를 들고 다닌다. 걸어 다녀야 하고 모서리를
// 넘어야 하기 때문이다. 물건은 걷지 않는다. 그래서 씬에 직접 매달고 월드
// 좌표로만 다룬다 — 면 로컬로 옮겼다 되돌리는 일이 통째로 빠진다.
// ---------------------------------------------------------------------------

/** 재질은 물건끼리 나눠 쓴다. 슬리퍼 두 짝이 드로우콜 두 벌일 이유가 없다. */
const soleMaterial = new THREE.MeshStandardMaterial({ color: 0x2f3338, roughness: 0.85 });
const strapMaterial = new THREE.MeshStandardMaterial({ color: 0x8a3b32, roughness: 0.6 });
const coverMaterial = new THREE.MeshStandardMaterial({ color: 0x6d5b3f, roughness: 0.7 });
const pageMaterial = new THREE.MeshStandardMaterial({ color: 0xd9d2c2, roughness: 0.9 });

export interface Prop {
  /** 씬에 바로 매단다. position이 곧 월드 좌표다. */
  node: THREE.Group;
  /** 이 거리 안의 바퀴를 친다(m). 물건의 실제 크기보다 조금 넉넉하다. */
  radius: number;
  /** 바닥에 놓였을 때 중심이 면에서 뜨는 높이(m). */
  rest: number;
  label: string;
  /** 지금 이 물건을 집고 있는 손. 아니면 null. */
  heldBy: TrackedHand | null;
  /** 손을 떠나 날아가는 중인지. */
  flying: boolean;
  /**
   * 면에 닿아 미끄러지는 중인지.
   *
   * 던진 슬리퍼는 닿은 자리에 서지 않는다. 그리고 이게 없으면 조금 짧게
   * 던진 것이 전부 빗나간다 — 실제로 0.8m 표적에 0.52m에서 멈췄다.
   */
  sliding: boolean;
  /** 그동안의 속도(월드, m/s). */
  flight: THREE.Vector3;
  /** 날아가는 동안의 회전(라디안/초). 축마다 다르게 줘서 제멋대로 구르게. */
  spin: THREE.Vector3;
  /** 직전 프레임의 자리(월드). 쥔 채로 휘두른 것도 맞히려고 들고 있는다. */
  previous: THREE.Vector3;
}

function makeProp(label: string, radius: number, rest: number): Prop {
  return {
    node: new THREE.Group(),
    radius,
    rest,
    label,
    heldBy: null,
    flying: false,
    sliding: false,
    flight: new THREE.Vector3(),
    spin: new THREE.Vector3(),
    previous: new THREE.Vector3(),
  };
}

/**
 * 슬리퍼 한 짝.
 *
 * 바닥 판과 발등 띠, 둘이면 슬리퍼로 읽힌다. 더 넣어도 25cm짜리 물건에서는
 * 보이지 않는다.
 */
function buildSlipper(side: number): Prop {
  // 반경은 슬리퍼의 실제 발자국에서 왔다. 25cm짜리가 중심에서 10cm만
  // 쓸고 간다고 하면 실제보다 좁게 잡는 것이다.
  const prop = makeProp('슬리퍼', 0.12, 0.018);

  // 바닥 판. 구를 눌러 쓴다 — 앞뒤로 길고 납작하고 모서리가 둥글어야 한다.
  const sole = new THREE.Mesh(new THREE.SphereGeometry(1, 14, 10), soleMaterial);
  sole.scale.set(0.045, 0.016, 0.125);
  prop.node.add(sole);

  // 발등 띠. 반지를 눕혀 앞쪽에 얹는다. 폭이 좁아야 띠로 보인다.
  const strap = new THREE.Mesh(new THREE.TorusGeometry(0.042, 0.009, 6, 16), strapMaterial);
  strap.rotation.y = Math.PI / 2;
  strap.scale.set(1, 0.75, 1);
  strap.position.set(0, 0.012, 0.045 * side);
  prop.node.add(strap);

  return prop;
}

/** 책 한 권. 표지와 책배, 둘이면 책으로 읽힌다. */
function buildBook(): Prop {
  const prop = makeProp('책', 0.11, 0.016);

  const cover = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.03, 0.21), coverMaterial);
  prop.node.add(cover);

  // 책배. 표지보다 아주 조금 작아서 테두리만 남는다.
  const pages = new THREE.Mesh(new THREE.BoxGeometry(0.142, 0.022, 0.202), pageMaterial);
  prop.node.add(pages);

  return prop;
}

/**
 * 바닥에 깔 물건들.
 *
 * 슬리퍼 두 짝과 책 한 권. 한 짝만 두면 '놓여 있다'가 아니라 '배치했다'로
 * 보이고, 종류가 하나뿐이면 집는 손이 늘 같은 것만 집는다.
 */
export function makeProps(): Prop[] {
  return [buildSlipper(1), buildSlipper(-1), buildBook()];
}
