import * as THREE from 'three';

// ---------------------------------------------------------------------------
// 바퀴벌레 한 마리.
//
// 모형은 '바퀴 단위'로 만든다 — 몸길이가 대략 1인 좌표계. 마지막에 한 번
// 스케일해서 실제 크기(4.5cm)로 줄인다. 이렇게 해 두면 숫자를 읽기 쉽고,
// 나중에 MR로 옮길 때도 스케일 한 줄만 건드리면 된다.
// ---------------------------------------------------------------------------

/** 실제 몸길이(m). 집바퀴 성충이 이 정도. */
export const ROACH_LENGTH = 0.045;

/** 몸통에서 고관절까지의 높이. 이 값이 곧 '몸이 바닥에서 뜬 높이'가 된다. */
const HIP_Y = 0.05;

/** 넓적다리를 위로 든 각. 무릎이 몸통보다 높이 솟은 모양을 만든다. */
const FEMUR_PITCH = 0.3;

/** 다리 한 쌍의 설계값. 앞·가운데·뒤 세 쌍이 좌우로 복제된다. */
interface LegSpec {
  /** 몸통 앞뒤 위치. +가 앞. */
  z: number;
  /**
   * 쉴 때 다리가 뻗는 방향. 몸통 오른쪽(+X)에서 잰 각이고 +가 앞쪽이다.
   * 앞다리는 앞으로, 뒷다리는 뒤로 뻗는다 — 실제 바퀴벌레가 그렇다.
   */
  spread: number;
  femur: number;
  tibia: number;
}

const LEG_SPECS: LegSpec[] = [
  { z: 0.3, spread: 0.82, femur: 0.28, tibia: 0.3 },
  { z: 0.06, spread: -0.33, femur: 0.34, tibia: 0.4 },
  { z: -0.2, spread: -0.68, femur: 0.44, tibia: 0.56 },
];

/**
 * 발이 바닥에 닿는 무릎 각을 '한 번' 푼다.
 *
 * 런타임 IK가 아니다. 쉬는 자세는 고정이고, 걸을 때의 변형은 이 값을 기준으로
 * 더하고 빼기만 한다. 그래서 프레임마다 풀 이유가 없다.
 *
 *        무릎
 *        /  \            넓적다리는 FEMUR_PITCH만큼 위로 들려 있다.
 *   고관절    \           그러면 무릎 높이가 HIP_Y + femur·sin(pitch)로 정해진다.
 *   ─────────  발         종아리는 그 높이만큼 정확히 내려와야 바닥에 닿는다.
 */
function solveKneeAngle(spec: LegSpec): number {
  const kneeHeight = HIP_Y + spec.femur * Math.sin(FEMUR_PITCH);

  // 종아리의 '절대' 기울기. 무릎 높이만큼 내려와야 하므로 음수다.
  // 종아리가 짧아서 못 닿으면 최대한 눕힌다(비율을 1 아래로 자른다).
  const tibiaPitch = -Math.asin(Math.min(0.98, kneeHeight / spec.tibia));

  // knee 그룹은 fem 그룹의 자식이라 각도가 더해진다. 원하는 절대 기울기를
  // 만들려면 넓적다리가 이미 준 각을 빼야 한다.
  return tibiaPitch - FEMUR_PITCH;
}

interface Leg {
  hip: THREE.Group;
  femur: THREE.Group;
  knee: THREE.Group;
  spec: LegSpec;
  kneeAngle: number;
  /** 왼쪽 -1, 오른쪽 +1. */
  side: number;
  /** 앞 0, 가운데 1, 뒤 2. */
  index: number;
}

export interface Roach {
  root: THREE.Group;
  legs: Leg[];
  /**
   * 자세를 한 프레임 진행한다.
   * @param speedNorm 0이면 제자리, 1이면 전력 질주.
   */
  pose(speedNorm: number, dt: number): void;
}

/** 다리 마디 하나. +X 방향으로 길게 누운 원통. */
function limbGeometry(length: number, rootRadius: number, tipRadius: number): THREE.BufferGeometry {
  const geometry = new THREE.CylinderGeometry(tipRadius, rootRadius, length, 6, 1);
  // CylinderGeometry는 +Y로 서 있다. 눕히고, 뿌리가 원점에 오도록 민다.
  // 지오메트리 자체를 돌려 두면 그룹의 회전을 순수하게 관절 각도로만 쓸 수 있다.
  geometry.rotateZ(-Math.PI / 2);
  geometry.translate(length / 2, 0, 0);
  return geometry;
}

function buildBody(material: THREE.Material): THREE.Group {
  const body = new THREE.Group();

  // 형태는 아직 대충이다. 지금 단계의 목표는 움직임이고, 깎는 건 나중 일이다.
  const abdomen = new THREE.Mesh(new THREE.SphereGeometry(0.3, 16, 12), material);
  abdomen.scale.set(0.72, 0.34, 1.25);
  abdomen.position.set(0, 0.07, -0.1);
  body.add(abdomen);

  const pronotum = new THREE.Mesh(new THREE.SphereGeometry(0.22, 16, 12), material);
  pronotum.scale.set(1, 0.42, 0.95);
  pronotum.position.set(0, 0.09, 0.28);
  body.add(pronotum);

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.11, 12, 10), material);
  head.scale.set(1, 0.8, 0.85);
  head.position.set(0, 0.06, 0.46);
  body.add(head);

  return body;
}

export function makeRoach(): Roach {
  const shell = new THREE.MeshStandardMaterial({ color: 0x3a2416, roughness: 0.45 });
  const limb = new THREE.MeshStandardMaterial({ color: 0x241509, roughness: 0.7 });

  const root = new THREE.Group();
  root.add(buildBody(shell));

  const legs: Leg[] = [];

  for (const side of [1, -1]) {
    LEG_SPECS.forEach((spec, index) => {
      // hip → femur → knee. three.js의 그룹 계층이 그대로 관절이 된다.
      // 각 그룹은 회전만 담당하고, 길이는 자식의 위치가 담당한다.
      const hip = new THREE.Group();
      hip.position.set(side * 0.13, HIP_Y, spec.z);
      root.add(hip);

      const femur = new THREE.Group();
      hip.add(femur);
      femur.add(new THREE.Mesh(limbGeometry(spec.femur, 0.035, 0.022), limb));

      const knee = new THREE.Group();
      knee.position.x = spec.femur; // 넓적다리 끝
      femur.add(knee);
      knee.add(new THREE.Mesh(limbGeometry(spec.tibia, 0.022, 0.009), limb));

      legs.push({ hip, femur, knee, spec, kneeAngle: solveKneeAngle(spec), side, index });
    });
  }

  root.scale.setScalar(ROACH_LENGTH);

  // 모든 다리가 같은 위상을 공유한다. 걸음새 전체가 이 숫자 하나에서 나온다.
  let phase = Math.random() * Math.PI * 2;

  function pose(speedNorm: number, dt: number): void {
    // 빠를수록 자주 젓는다. 6은 멈춰 있을 때도 미세하게 떠는 기본 박자.
    phase += dt * (6 + speedNorm * 26);

    for (const leg of legs) {
      // ───────────────────────────────────────────────────────────────
      // 삼각보행(tripod gait).
      //
      // 곤충은 다리 6개를 삼각대 두 벌로 나눠 번갈아 딛는다.
      //   A: 오른앞 · 왼가운데 · 오른뒤
      //   B: 왼앞   · 오른가운데 · 왼뒤
      // 앞뒤 번호와 좌우를 더해 홀짝으로 가르면 정확히 그 두 벌이 된다.
      // 다리별 위상 배열도, 상태 기계도 필요 없다 — 사인파 하나의 부호만
      // 뒤집으면 끝이다.
      // ───────────────────────────────────────────────────────────────
      const tripod = (leg.index + (leg.side > 0 ? 0 : 1)) % 2 === 0 ? 1 : -1;
      const swing = Math.sin(phase) * tripod;

      // 빠를수록 보폭이 커진다. 멈춰 있어도 0은 아니라서 살짝 떤다.
      const amplitude = 0.1 + 0.32 * speedNorm;
      const spread = leg.spec.spread + swing * amplitude;

      // 오른쪽은 +X에서 재고, 왼쪽은 거울이다.
      // Y축 회전 a는 +X를 (cos a, 0, -sin a)로 보낸다. 다리가 (cos s, 0, sin s)를
      // 향하길 원하므로 오른쪽은 a = -s. 왼쪽은 X를 뒤집은 방향이라 a = π + s.
      leg.hip.rotation.y = leg.side > 0 ? -spread : Math.PI + spread;

      // 앞으로 나가는 반주기(swing > 0)에만 발을 든다. 나머지 반주기는 땅을
      // 짚는다. 상태 기계 대신 max(0, ...) 하나로 가른다.
      const lift = Math.max(0, swing) * 0.45 * speedNorm;

      leg.femur.rotation.z = FEMUR_PITCH + lift;
      // 든 만큼 무릎을 펴서 발이 바닥을 파고들지 않게 한다.
      leg.knee.rotation.z = leg.kneeAngle - lift * 0.2;
    }
  }

  pose(0, 0);

  return { root, legs, pose };
}
