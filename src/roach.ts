import * as THREE from 'three';

// ---------------------------------------------------------------------------
// 바퀴벌레 한 마리.
//
// 좌표계가 셋이다. 헷갈리면 전부 꼬이므로 먼저 적어 둔다.
//
//   땅 공간   root의 부모. 미터. 바퀴가 이 평면의 XZ를 돌아다닌다.
//   몸 공간   model의 안쪽. '바퀴 단위'(몸길이 ≈ 1). 관절과 발은 여기서 센다.
//   관절 공간 각 hip 그룹의 안쪽. 다리는 +X로 뻗는다.
//
// model의 스케일이 땅 공간과 몸 공간을 잇는다. 발 자국은 땅 공간에 박아 두고,
// 매 프레임 몸 공간으로 가져와서 관절을 역산한다.
// ---------------------------------------------------------------------------

/**
 * 실제 몸길이(m).
 *
 * 이질바퀴(Periplaneta americana) 성충이 34~53mm. 가운데쯤을 잡았다.
 * 아래 모형의 비율도 전부 이 종의 실측에 맞췄다 — 폭/길이 0.375,
 * 높이/길이 0.175, 더듬이는 몸길이의 1.2~1.5배.
 */
export const ROACH_LENGTH = 0.04;

/** 몸통에서 고관절까지의 높이(몸 공간). 곧 몸이 바닥에서 뜬 높이다. */
const HIP_Y = 0.05;

/**
 * 쉴 때 넓적다리를 위로 든 각. 무릎이 몸통보다 솟은 모양을 만든다.
 *
 * 이 값이 작으면 쉬는 자세에서 다리가 거의 쭉 뻗는다. 0.3일 때 뒷다리는
 * 이미 95% 뻗은 상태였고, 그러면 디디는 동안 발을 뒤로 보낼 여유가 없다.
 * IK가 '못 닿음'으로 잘라 버려서 발이 땅에 박힌 자리를 못 따라가고, 보기에는
 * 뒷발이 질질 끌린다. 굽혀 두면 그만큼 가동 범위가 생긴다.
 */
const FEMUR_PITCH = 0.9;

/** 발을 들어 올리는 높이(몸 공간). */
const STEP_HEIGHT = 0.1;

/**
 * 가장 빠를 때의 속도(m/s). 걸음새 세기를 이 값으로 정규화한다.
 *
 * 임의로 고른 값이 아니라 다리 기하에서 나온 상한이다. 보폭은 0.34 몸길이를
 * 넘을 수 없고(넘으면 디딤 끝에서 발이 다리 길이 밖으로 나가 끌린다),
 * 속도 = 보폭 × 주기 / π 이므로 주기 120 rad/s(19Hz)에서 0.5 m/s가 된다.
 * 몸길이의 12배/초다. 진짜 바퀴벌레는 20~50배까지 내지만 거기까지 가려면
 * 다리가 더 길어야 한다.
 */
const MAX_SPEED = 0.5;

/** 몸 중심에서 발까지의 대략적인 거리(m). 회전을 걸음으로 환산할 때 쓴다. */
const FOOT_RADIUS = 0.022;

/**
 * 한 걸음에 나아가는 거리(바퀴 단위). 느릴 땐 종종걸음, 빠를 땐 성큼.
 *
 * 상한은 다리가 닿는 범위에서 나온 값이다. 이보다 크게 잡으면 디딤 끝에서
 * 발이 다리 길이를 넘어가고, IK가 자르면서 발이 끌린다.
 */
// 느린 걸음에서도 보폭이 크게 줄지는 않는다 — 곤충은 보폭보다 주기로 속도를
// 조절한다. 아주 느릴 때만 종종걸음이 된다.
const MIN_STRIDE = 0.26;
const MAX_STRIDE = 0.34;

/** 이 거리 안에서 위협이 다가오면 놀란다(m). */
const SCARE_RADIUS = 0.35;

/** 놀라는 기준이 되는 접근 속도(m/s). 가만히 있는 건 위협이 아니다. */
const SCARE_APPROACH = 0.25;

/** 돌아다니는 영역의 반지름(m). 이 원의 둘레가 '벽'이다. */
const WANDER_RADIUS = 0.12;

/** 벽에서 이 거리 안에 들어오면 벽을 따라가기 시작한다(m). */
const EDGE_BAND = 0.035;

/** 벽을 따라갈 때 유지하려는 간격(m). */
const EDGE_HUG = 0.012;

/**
 * 가장자리를 따라가다 '넘어가 볼까' 하고 마음먹는 빈도(1/초).
 *
 * 주촉성만 두면 가장자리에 영영 붙어 있는다. 유지하는 간격이 EDGE_HUG인데
 * 모서리는 활동 범위 끝에 있어서, 붙어 있는 한 넘어간 판정이 날 수가 없다.
 * 미리보기에서 방 바닥의 네 변을 정면으로 들이받게 놓았더니 40초 동안 셋만
 * 넘어갔고, 그것도 돌아서기 전에 지나친 덕이지 넘으려고 넘은 게 아니다.
 * 그 상태로는 천장이나 건너편 벽에 사실상 못 간다.
 *
 * 4초에 한 번쯤. 더 잦으면 가장자리를 따라가는 맛이 없어지고, 더 뜸하면
 * 보는 동안 한 번도 안 올라간다.
 */
const EDGE_CLIMB_RATE = 0.25;

/** 넘어가기로 한 뒤 바깥을 향해 밀어붙이는 시간(초). */
const EDGE_CLIMB_TIME = 0.8;

/**
 * 범위를 이만큼 넘어서도 그대로면 그만둔다(m).
 *
 * 넘어갈 모서리가 있으면 범위를 넘어서는 순간 다른 면으로 옮겨 간다. 아직도
 * 여기 있다는 건 그 변이 막힌 벽이라는 뜻이다. 시간만으로 끊으면 그동안
 * 30cm까지 밀고 나가서, 책상 상판이라면 허공으로 걸어 나간 꼴이 된다.
 */
const EDGE_CLIMB_DEPTH = 0.02;

const IDENTITY = new THREE.Quaternion();

// 바퀴벌레는 반드르르하다. 거친 재질로 두면 플라스틱 장난감처럼 보인다.
// roughness를 낮춰 directional light의 하이라이트가 또렷하게 맺히게 한다 —
// 멀리서도 '젖은 듯한 광택'이 먼저 읽힌다.
const shell = new THREE.MeshStandardMaterial({ color: 0x3a2416, roughness: 0.3 });
const wingShell = new THREE.MeshStandardMaterial({ color: 0x2b190d, roughness: 0.22 });
const limb = new THREE.MeshStandardMaterial({ color: 0x241509, roughness: 0.6 });
const eye = new THREE.MeshStandardMaterial({ color: 0x0b0806, roughness: 0.15 });

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
const rand = (lo: number, hi: number): number => lo + Math.random() * (hi - lo);
/** 각도를 -π~π로 접는다. 두 각의 차를 다룰 때 필요하다. */
const wrapAngle = (a: number): number => ((((a + Math.PI) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)) - Math.PI;

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
  { z: 0.06, spread: -0.33, femur: 0.31, tibia: 0.36 },
  { z: -0.2, spread: -0.68, femur: 0.4, tibia: 0.5 },
];

interface Leg {
  hip: THREE.Group;
  femur: THREE.Group;
  knee: THREE.Group;
  /** 종아리 끝의 짧은 마디. 실제 곤충은 이 부분을 바닥에 눕혀 딛는다. */
  tarsus: THREE.Group;
  /** 이 다리만의 미세한 위상 어긋남. 삼각대가 기계처럼 딱 맞지 않게 한다. */
  phaseOffset: number;
  spec: LegSpec;
  /** 왼쪽 -1, 오른쪽 +1. */
  side: number;
  /** 앞 0, 가운데 1, 뒤 2. */
  index: number;
  /** 삼각대 구분. 같은 값끼리 동시에 움직인다. */
  tripod: number;
  /** 고관절 위치(몸 공간). */
  hipX: number;
  /** 쉴 때 발이 놓이는 자리(몸 공간, y는 0). */
  restFootX: number;
  restFootZ: number;
  /** 쉴 때의 고관절 yaw. IK 결과를 이 근처로 가둔다. */
  restYaw: number;

  /** 지금 발이 있는 자리(땅 공간, 미터). 디딘 동안에는 움직이지 않는다. */
  footX: number;
  footZ: number;
  footLift: number;
  /** 발을 떼고 있는 중인가. */
  swinging: boolean;
  /** 떼기 시작한 자리와 놓을 자리(땅 공간). */
  fromX: number;
  fromZ: number;
  toX: number;
  toZ: number;
  /** 떼기 시작한 시점의 위상. 진행률을 재는 데 쓴다. */
  swingStart: number;
}

interface Antenna {
  /** 뿌리부터 끝까지 이어진 마디들. 각 마디가 부모의 끝에 붙는다. */
  segments: THREE.Group[];
  /** 왼쪽 -1, 오른쪽 +1. */
  side: number;
}

export interface Roach {
  /** 땅 공간에서 움직이는 노드. 부모의 XZ 평면 위를 돌아다닌다. */
  root: THREE.Group;
  /**
   * 한 프레임 진행.
   * @param threat 보는 사람의 위치(땅 공간). 다가오면 놀란다. 없으면 null.
   */
  update(dt: number, speedScale: number, threat: THREE.Vector3 | null): void;
  /** 밖에서 강제로 놀래킨다. 위치는 땅 공간. */
  scare(x: number, z: number): void;
  /** 납작하게 짜부러뜨린다. 되돌아오지 않는다. */
  squash(): void;
  /** 이미 짜부러졌는지. 밖에서 더 건드릴 필요가 없다. */
  isSquashed(): boolean;
  /**
   * 되살린다. 자국도 같이 지운다.
   *
   * 때려서 죽은 것은 되돌아오지 않는다. 이건 판을 새로 까는 길이다 — 구멍을
   * 다시 뚫으면 바퀴도 관 속으로 되돌아가는데, 그때 시체가 자국을 끌고
   * 관으로 빨려 들어가면 곤란하다.
   */
  revive(): void;

  /** 손에 잡혔다. 걷기를 멈추고 쉬지 않고 버둥댄다. 자리는 밖에서 정한다. */
  hold(): void;
  /** 지금 잡혀 있는지. 떨어지는 동안에도 참이다 — 버둥대는 건 그대로다. */
  isHeld(): boolean;
  /** 땅에 닿았다. 놀란 채로 다시 걷기 시작한다. */
  land(): void;
  /**
   * 이 자리를 피해 간다. 같은 면 위의 다른 바퀴를 넘겨주면 서로 비킨다.
   * 한 프레임짜리 밀침이라 매 프레임 다시 불러야 한다.
   */
  avoid(x: number, z: number): void;
  /**
   * 다른 면으로 옮겨 놓는다. 모서리를 넘을 때 쓴다.
   * 위치와 방향은 모두 새 면의 로컬 기준이고, 발은 거기서 새로 디딘다.
   */
  placeOn(
    parent: THREE.Object3D,
    x: number,
    z: number,
    newHeading: number,
    fromPose?: THREE.Quaternion,
  ): void;
  /** 지금 향하고 있는 방향. 면을 넘길 때 그대로 넘겨준다. */
  getHeading(): number;
  /** 지금 면에 올라선 뒤로 걸은 거리(m). placeOn에서 0으로 돌아간다. */
  walkedSincePlaced(): number;
  /**
   * 향하는 방향을 못박는다.
   *
   * 모서리를 넘을 때 방향은 저절로 정해진다. 포털에서 나오는 순간만 예외다 —
   * 아래턱이 벽 한가운데에 있어서, 넘어갈 때 쓰는 '새 면 안쪽' 기준이 위쪽을
   * 가리킨다. 나온 바퀴가 포털 위 벽을 기어오른다.
   */
  setHeading(newHeading: number): void;
  /**
   * 이 로컬 z 너머는 '나가는 문'이라 경계 조향을 하지 않는다.
   * null이면 사방이 막힌 면이다.
   */
  setExitZ(z: number | null): void;
  /**
   * 이 면 위에서 결국 가고 싶어 하는 방향(heading). 약한 편향이라 돌아다니는
   * 성격은 그대로 두고, 길게 보면 그쪽으로 흘러간다. null이면 목적 없음.
   */
  setDrift(newHeading: number | null): void;
  /**
   * 돌아다닐 수 있는 범위. 면의 로컬 XZ에서 축에 정렬된 사각형이다.
   * x는 ±halfX, z는 centerZ ± halfZ. 면마다 다르므로 밖에서 정한다.
   *
   * @param gapHalfWidth -Z 변에 뚫려 있는 구멍의 반폭(x = 0 중심). 그 안쪽은
   *   막지 않는다. 벽면 위쪽이 그렇다 — 포털 폭 안이면 복도로 되돌아갈 수
   *   있고, 그 밖은 그냥 벽이다.
   */
  setBounds(halfX: number, centerZ: number, halfZ: number, gapHalfWidth: number): void;
  /**
   * 가장자리에 몸을 붙이고 따라갈지. 머물며 살피는 면에서만 켠다.
   * 지나가는 면에서 켜 두면 둘레만 돌다가 목적지에 닿지 않는다.
   */
  setHugEdges(on: boolean): void;
}

// ---------------------------------------------------------------------------
// 쉬는 자세 — 각도에서 발 위치를 구한다(정방향)
// ---------------------------------------------------------------------------

/** 쉴 때 발이 고관절에서 수평으로 얼마나 떨어지는지. */
function restReach(spec: LegSpec): number {
  const kneeHeight = HIP_Y + spec.femur * Math.sin(FEMUR_PITCH);
  // 종아리가 무릎 높이만큼 정확히 내려와야 발이 바닥에 닿는다.
  const tibiaPitch = -Math.asin(Math.min(0.98, kneeHeight / spec.tibia));
  return spec.femur * Math.cos(FEMUR_PITCH) + spec.tibia * Math.cos(tibiaPitch);
}

// ---------------------------------------------------------------------------
// 2링크 IK — 발 위치에서 각도를 구한다(역방향)
//
// 이게 이번 단계의 핵심이다. 전에는 각도를 흔들어서 발이 따라오게 했고, 그래서
// 발이 땅을 긁으며 미끄러졌다. 이제는 발이 있을 자리를 먼저 정하고 관절을
// 역산한다. 디딘 발은 땅 공간에 못 박혀 있으니 미끄러질 수가 없다.
//
//   고관절 ──f── 무릎
//      \           \ t
//       └─── L ────  발
//
// 세 변 f, t, L의 삼각형이다. 코사인 법칙으로 끼인각을 구하면 끝난다.
// ---------------------------------------------------------------------------
interface JointAngles {
  femurAngle: number;
  kneeAngle: number;
}

function solveLeg(spec: LegSpec, reach: number, rise: number, out: JointAngles): void {
  const f = spec.femur;
  const t = spec.tibia;

  // 닿을 수 있는 범위로 자른다. 벗어나면 다리를 쭉 펴거나 최대로 접는다.
  const L = clamp(Math.hypot(reach, rise), Math.abs(f - t) + 1e-4, f + t - 1e-4);

  // 무릎의 끼인각. 음수로 두면 무릎이 위로 솟고 발이 아래로 접힌다.
  // 양수를 고르면 무릎이 꺾여 내려간 '거꾸로 다리'가 된다 — 두 해 중 하나를
  // 고르는 것이 2링크 IK에서 늘 해야 하는 선택이다.
  const kneeAngle = -Math.acos(clamp((L * L - f * f - t * t) / (2 * f * t), -1, 1));

  // 넓적다리 각 = 목표를 향한 각 - 무릎이 접힌 만큼의 보정.
  const femurAngle =
    Math.atan2(rise, reach) - Math.atan2(t * Math.sin(kneeAngle), f + t * Math.cos(kneeAngle));

  out.femurAngle = femurAngle;
  out.kneeAngle = kneeAngle;
}

// ---------------------------------------------------------------------------
// 모양 (아직 대충)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 공유 자원
//
// 지오메트리와 재질은 마리마다 새로 만들지 않고 한 벌만 만들어 돌려 쓴다.
// 모양이 같으니 메모리 때문만이 아니다 — 인스턴싱으로 묶으려면 '같은 지오메트리,
// 같은 재질'이어야 한 번의 드로우콜로 들어간다. 마리마다 따로 만들면 풀이
// 마리 수만큼 쪼개져서 배칭이 아무 의미가 없어진다.
// ---------------------------------------------------------------------------
const geometryCache = new Map<string, THREE.BufferGeometry>();

function shared<T extends THREE.BufferGeometry>(key: string, make: () => T): THREE.BufferGeometry {
  const cached = geometryCache.get(key);
  if (cached !== undefined) return cached;
  const made = make();
  geometryCache.set(key, made);
  return made;
}

/** 다리 마디 하나. +X 방향으로 길게 누운 원통. */
function makeLimbGeometry(length: number, rootRadius: number, tipRadius: number): THREE.BufferGeometry {
  const geometry = new THREE.CylinderGeometry(tipRadius, rootRadius, length, 6, 1);
  // CylinderGeometry는 +Y로 서 있다. 눕히고, 뿌리가 원점에 오도록 민다.
  // 지오메트리를 돌려 두면 그룹의 회전을 순수하게 관절 각도로만 쓸 수 있다.
  geometry.rotateZ(-Math.PI / 2);
  geometry.translate(length / 2, 0, 0);
  return geometry;
}

function limbGeometry(length: number, rootRadius: number, tipRadius: number): THREE.BufferGeometry {
  return shared(`limb:${length}:${rootRadius}:${tipRadius}`, () =>
    makeLimbGeometry(length, rootRadius, tipRadius),
  );
}

function sphereGeometry(r: number, w: number, h: number): THREE.BufferGeometry {
  return shared(`sphere:${r}:${w}:${h}`, () => new THREE.SphereGeometry(r, w, h));
}

/**
 * 더듬이 한 쌍.
 *
 * 다리보다 이쪽이 '살아 있다'는 인상의 대부분을 만든다. 다리는 규칙적인데
 * 더듬이만 불규칙하게 흔들리기 때문이다. 마디마다 주파수와 위상을 다르게 줘서
 * 전체가 한 덩어리로 움직이지 않게 한다.
 */
function buildAntenna(material: THREE.Material, side: number): Antenna {
  // 합이 1.3 — 실제로 더듬이는 몸보다 길다. 처음엔 0.55로 만들었는데
  // 몸길이의 절반밖에 안 됐고, 그래서 바퀴벌레로 안 보였다.
  // 마디를 넷으로 늘린 건 길어진 만큼 휘는 곡선이 필요해서다.
  const lengths = [0.4, 0.35, 0.3, 0.25];
  const segments: THREE.Group[] = [];

  let parent: THREE.Group | null = null;

  lengths.forEach((length, i) => {
    const segment = new THREE.Group();
    segment.rotation.order = 'YXZ';
    segment.add(new THREE.Mesh(limbGeometry(length, 0.009 - i * 0.0015, 0.0075 - i * 0.0015), material));

    if (parent === null) {
      // 머리 앞쪽에서 비스듬히 위·바깥으로 나간다.
      segment.position.set(side * 0.045, 0.105, 0.5);
    } else {
      segment.position.x = lengths[i - 1]; // 앞 마디의 끝
      parent.add(segment);
    }

    segments.push(segment);
    parent = segment;
  });

  return { segments, side };
}

function buildBody(
  material: THREE.Material,
  wingMaterial: THREE.Material,
  legMaterial: THREE.Material,
  eyeMaterial: THREE.Material,
): THREE.Group {
  const body = new THREE.Group();

  // 바퀴벌레는 아주 납작하다. 그리고 몸 아랫면이 바닥(y=0)을 파고들면 안 된다.
  // 각 덩어리의 '중심 y − 세로 반지름'이 0보다 커야 한다.
  // 배 + 날개. 몸의 대부분을 차지하는 납작한 타원.
  // 폭 0.41 / 전체 길이 1.03 ≈ 0.40, 실측 0.375에 가깝다.
  const abdomen = new THREE.Mesh(sphereGeometry(0.3, 16, 12), material);
  abdomen.scale.set(0.68, 0.26, 1.3); // 폭 0.41, 세로 반지름 0.078, 길이 0.78
  abdomen.position.set(0, 0.105, -0.12); // 아랫면 0.027, 뒤끝 -0.51
  body.add(abdomen);

  // 앞가슴판. 머리를 덮는 방패다. 실측은 '폭이 길이의 2.5배'라
  // 앞뒤로 짧고 좌우로 넓다. 바퀴벌레를 위에서 봤을 때의 인상이 여기서 나온다.
  const pronotum = new THREE.Mesh(sphereGeometry(0.22, 16, 12), material);
  pronotum.scale.set(1, 0.34, 0.4); // 폭 0.44, 길이 0.176 → 2.5배
  pronotum.position.set(0, 0.115, 0.3);
  body.add(pronotum);

  // 머리. 앞가슴판 아래로 거의 숨는다.
  const head = new THREE.Mesh(sphereGeometry(0.11, 12, 10), material);
  head.scale.set(0.85, 0.55, 0.7);
  head.position.set(0, 0.09, 0.44);
  body.add(head);

  // 눈. 머리 양옆에 붙은 납작한 콩 모양. 작지만 이게 없으면 머리가
  // 그냥 덩어리로 보인다.
  for (const side of [1, -1]) {
    const eye = new THREE.Mesh(sphereGeometry(0.038, 8, 6), eyeMaterial);
    eye.scale.set(0.7, 1.1, 1.3);
    eye.position.set(side * 0.075, 0.105, 0.455);
    body.add(eye);
  }

  // 미병(꼬리털). 배 끝에서 뒤로 벌어진 짧은 한 쌍.
  // 뒤에서 본 실루엣을 끝맺는 역할이다.
  for (const side of [1, -1]) {
    const cercus = new THREE.Mesh(limbGeometry(0.16, 0.016, 0.004), legMaterial);
    cercus.position.set(side * 0.055, 0.09, -0.47);
    cercus.rotation.y = side > 0 ? -(Math.PI - 0.45) : Math.PI - 0.45; // 뒤·바깥으로
    cercus.rotation.z = -0.12;
    body.add(cercus);
  }

  // 딱지날개 한 쌍. 등을 덮는 얇은 판 두 장이 가운데서 겹친다.
  // 위에서 본 바퀴벌레의 인상은 앞가슴판 방패와 이 가운데 이음선, 둘이 거의
  // 전부다. 바깥쪽을 살짝 떨구면 등이 둥글게 말린 느낌이 난다.
  for (const side of [1, -1]) {
    const wing = new THREE.Mesh(sphereGeometry(0.3, 16, 12), wingMaterial);
    wing.scale.set(0.567, 0.05, 1.17); // 반폭 0.17, 두께 0.015, 반길이 0.35
    wing.position.set(side * 0.055, 0.175, -0.13); // 가운데서 겹치도록 안쪽으로
    wing.rotation.z = -side * 0.12; // 바깥 가장자리를 아래로
    body.add(wing);
  }

  return body;
}

/**
 * 접촉 그림자.
 *
 * AR에서는 실제 방의 조명 방향을 알 수 없어서 제대로 된 그림자를 드리울 수
 * 없다. 그런데 그림자가 아예 없으면 물체가 표면 위에 '떠' 보인다 — 바닥에
 * 놓인 느낌을 만드는 건 형태가 아니라 접지면의 어두움이다.
 *
 * 그래서 가운데가 진하고 가장자리로 흐려지는 얼룩 하나를 몸 밑에 깔아 둔다.
 * 방향은 없고 '여기 뭔가 닿아 있다'만 말한다. 흔히 쓰는 타협이다.
 */
let shadowGeometry: THREE.BufferGeometry | null = null;
let shadowMaterial: THREE.Material | null = null;

function makeContactShadow(): THREE.Mesh {
  // 두 번째 마리부터는 만들어 둔 것을 그대로 쓴다. 캔버스를 다시 그리지 않는
  // 것보다, 같은 지오메트리·재질이어야 인스턴싱으로 묶인다는 쪽이 중요하다.
  if (shadowGeometry !== null && shadowMaterial !== null) {
    const reused = new THREE.Mesh(shadowGeometry, shadowMaterial);
    reused.rotation.x = -Math.PI / 2;
    reused.position.y = 0.0005;
    reused.renderOrder = -1;
    return reused;
  }

  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;

  const ctx = canvas.getContext('2d');
  if (ctx !== null) {
    const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    gradient.addColorStop(0, 'rgba(0,0,0,0.5)');
    gradient.addColorStop(0.45, 'rgba(0,0,0,0.28)');
    gradient.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
  }

  const texture = new THREE.CanvasTexture(canvas);
  shadowMaterial = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    depthWrite: false, // 그림자가 깊이를 쓰면 다리가 그 위에서 잘린다
  });
  // PlaneGeometry(width, height)는 X-Y에 눕는다. rotation.x로 눕히면 width가
  // 몸의 좌우(X), height가 몸의 앞뒤(Z)가 된다. 몸은 앞뒤로 긴 타원이므로
  // height 쪽이 커야 한다 — 처음에 반대로 줘서 그림자가 옆으로 퍼져 있었다.
  shadowGeometry = new THREE.PlaneGeometry(ROACH_LENGTH * 0.7, ROACH_LENGTH * 1.3);
  const shadow = new THREE.Mesh(shadowGeometry, shadowMaterial);
  shadow.rotation.x = -Math.PI / 2; // 바닥에 눕힌다
  shadow.position.y = 0.0005; // 바닥과 겹쳐 z-fighting이 나지 않게
  shadow.renderOrder = -1; // 몸보다 먼저
  return shadow;
}

// ---------------------------------------------------------------------------
// 짜부러진 뒤에 남는 것
//
// 전에는 몸이 납작해지고 다리가 벌어지는 게 전부였다. 그건 '눌렸다'지
// '터졌다'가 아니다. 바퀴를 때려 본 사람이 기억하는 건 눌린 모양이 아니라
// 바닥에 남은 자국이고, 그 자국을 지워야 끝난다는 사실이다.
//
// 세 가지를 더한다.
//   얼룩  바닥에 번지는 젖은 자국. 몸보다 크고, 몸보다 오래 남는다.
//   내장  몸 밑에서 옆으로 밀려 나온 허연 덩어리. 어두운 몸에 대비되는
//         유일한 밝은 색이라, 4cm짜리 벌레에서도 이것만은 읽힌다.
//   알    배에서 쏟아진 알집의 알. 한 마리를 잡은 게 아니라는 뜻이다.
//
// 그리고 다리는 한참 떤다. 죽은 것과 죽어 가는 것의 차이가 거기 있다.
//
// 지오메트리와 재질은 전부 모두가 나눠 쓴다 — 접촉 그림자와 같은 이유로,
// 마리마다 복제하면 인스턴싱으로 묶이지 않는다. 같아 보이지 않게 하는 일은
// 얼룩을 저마다 다른 각도로 깔고, 덩어리 자리를 난수로 집어서 한다.
// ---------------------------------------------------------------------------

/** 얼룩과 내장이 다 퍼지는 데 걸리는 시간(초). 몸이 눌리는 것보다 느리다. */
const GORE_SPREAD = 0.5;
/** 짜부러진 뒤 다리가 떠는 시간(초). */
const TWITCH_TIME = 2.4;

/** 바닥 자국 무늬를 캔버스에 그린다. 딱 한 번 돈다. */
function paintSplat(): THREE.Texture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;

  const ctx = canvas.getContext('2d');
  if (ctx !== null) {
    const mid = size / 2;

    // 가운데 덩어리. 원 하나로 그리면 물방울처럼 동그래서 '흘렀다'가 안 된다.
    // 타원 여럿을 겹쳐 가장자리를 울퉁불퉁하게 만든다.
    ctx.fillStyle = 'rgba(26, 11, 7, 0.86)';
    for (let i = 0; i < 18; i += 1) {
      const angle = (i / 18) * Math.PI * 2;
      const reach = mid * (0.1 + Math.random() * 0.17);
      ctx.beginPath();
      ctx.ellipse(
        mid + Math.cos(angle) * reach,
        mid + Math.sin(angle) * reach,
        mid * (0.12 + Math.random() * 0.14),
        mid * (0.1 + Math.random() * 0.14),
        angle,
        0,
        Math.PI * 2,
      );
      ctx.fill();
    }

    // 둘레로 번진 묽은 테. 진물이 스며든 자리라 덩어리보다 연하고 넓다.
    ctx.fillStyle = 'rgba(40, 20, 12, 0.3)';
    for (let i = 0; i < 12; i += 1) {
      const angle = Math.random() * Math.PI * 2;
      const reach = mid * (0.3 + Math.random() * 0.12);
      ctx.beginPath();
      ctx.ellipse(
        mid + Math.cos(angle) * reach,
        mid + Math.sin(angle) * reach,
        mid * (0.1 + Math.random() * 0.1),
        mid * (0.08 + Math.random() * 0.1),
        angle,
        0,
        Math.PI * 2,
      );
      ctx.fill();
    }

    // 튄 방울. 때린 자리에서 사방으로 흩어진다. 이게 있어야 '맞았다'가 된다.
    ctx.fillStyle = 'rgba(22, 9, 6, 0.75)';
    for (let i = 0; i < 18; i += 1) {
      const angle = Math.random() * Math.PI * 2;
      const reach = mid * (0.3 + Math.random() * 0.52);
      const r = mid * (0.009 + Math.random() * 0.026);
      ctx.beginPath();
      // 날아간 방향으로 조금 길쭉하다. 많이 늘이면 햇살처럼 뻗어서,
      // 튄 자국이 아니라 그려 넣은 무늬로 보인다.
      ctx.ellipse(
        mid + Math.cos(angle) * reach,
        mid + Math.sin(angle) * reach,
        r,
        r * (1 + Math.random() * 0.7),
        angle + Math.PI / 2,
        0,
        Math.PI * 2,
      );
      ctx.fill();
    }
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

let goreAssets: {
  stainGeometry: THREE.BufferGeometry;
  blobGeometry: THREE.BufferGeometry;
  stainMaterial: THREE.Material;
  gutsMaterial: THREE.Material;
  eggMaterial: THREE.Material;
} | null = null;

function goreKit(): NonNullable<typeof goreAssets> {
  if (goreAssets !== null) return goreAssets;
  goreAssets = {
    // 얼룩은 몸보다 한참 넓다. 번진 테와 튄 방울까지 무늬 안에 있다.
    stainGeometry: new THREE.PlaneGeometry(ROACH_LENGTH * 2.3, ROACH_LENGTH * 2.3),
    // 덩어리는 전부 이 구 하나를 눌러 쓴다.
    blobGeometry: new THREE.SphereGeometry(1, 8, 6),
    stainMaterial: new THREE.MeshBasicMaterial({
      map: paintSplat(),
      transparent: true,
      // 얼룩이 깊이를 쓰면 그 위에 놓인 다리가 잘린다. 접촉 그림자와 같다.
      depthWrite: false,
    }),
    // 어두운 몸에서 유일하게 밝은 것. 젖은 것으로 보이게 거칠기를 낮춘다.
    gutsMaterial: new THREE.MeshStandardMaterial({ color: 0xc9b183, roughness: 0.22 }),
    eggMaterial: new THREE.MeshStandardMaterial({ color: 0xe6dcc2, roughness: 0.34 }),
  };
  return goreAssets;
}

interface Gore {
  /** 이 그룹의 visible로 통째로 켜고 끈다 — 메시 하나하나는 배칭이 숨겨 둔다. */
  group: THREE.Group;
  stain: THREE.Mesh;
  /**
   * 얼룩을 축마다 다르게 늘이는 비율.
   *
   * 무늬 한 장을 모두가 나눠 쓰니 그대로 깔면 여덟 마리가 같은 별 모양을
   * 남긴다. 각도를 돌리는 것만으로는 돌려 놓은 티가 나서, 한쪽으로 늘여
   * 둔다 — 튄 방향이 있는 것처럼 보인다.
   */
  stainAspect: { x: number; z: number };
  /** 터져 나온 것들. 다 퍼졌을 때의 크기를 각자 들고 있다. */
  bits: { node: THREE.Object3D; size: THREE.Vector3 }[];
}

/** 짜부러질 때 드러날 것들을 미리 만들어 숨겨 둔다. */
function buildGore(): Gore {
  const kit = goreKit();

  const group = new THREE.Group();
  group.visible = false;

  // 얼룩 무늬는 한 장을 모두가 나눠 쓴다. 저마다 다른 각도로 깔아서 같은
  // 자국이 반복되지 않게 한다 — 무늬를 마리마다 그리면 드로우콜이 는다.
  const spin = new THREE.Group();
  spin.rotation.y = Math.random() * Math.PI * 2;
  group.add(spin);

  const stainAspect = { x: 0.85 + Math.random() * 0.55, z: 0.85 + Math.random() * 0.55 };

  const stain = new THREE.Mesh(kit.stainGeometry, kit.stainMaterial);
  stain.rotation.x = -Math.PI / 2; // 바닥에 눕힌다
  stain.position.y = 0.0008; // 접촉 그림자(0.0005)보다 위
  stain.renderOrder = -1; // 몸보다 먼저
  spin.add(stain);

  const bits: Gore['bits'] = [];

  // 내장: 몸 밑에서 좌우로 밀려 나온 덩어리. 납작하게 눌려 있다.
  for (let i = 0; i < 7; i += 1) {
    const blob = new THREE.Mesh(kit.blobGeometry, kit.gutsMaterial);
    const side = i % 2 === 0 ? 1 : -1;
    blob.position.set(
      side * ROACH_LENGTH * (0.16 + Math.random() * 0.24),
      ROACH_LENGTH * 0.015,
      ROACH_LENGTH * (-0.45 + Math.random() * 0.6),
    );
    blob.rotation.y = Math.random() * Math.PI;
    // 축마다 비율을 따로 준다. 구를 그대로 눌러 놓으면 만두처럼 보인다 —
    // 밀려 나온 것은 눌린 쪽으로 퍼지고 아주 납작하다.
    const r = ROACH_LENGTH * (0.07 + Math.random() * 0.07);
    group.add(blob);
    bits.push({
      node: blob,
      size: new THREE.Vector3(r * (0.8 + Math.random() * 0.9), r * 0.22, r * (0.9 + Math.random())),
    });
  }

  // 알집에서 쏟아진 알. 배 뒤로 줄줄이 흘러나온다.
  // 한 마리를 잡은 게 아니라는 뜻이고, 이 작품에서 제일 하기 싫은 그림이다.
  for (let i = 0; i < 4; i += 1) {
    const egg = new THREE.Mesh(kit.blobGeometry, kit.eggMaterial);
    // 곧게 늘어놓으면 뿌려 둔 것처럼 보인다. 옆으로도 흩뜨린다.
    egg.position.set(
      (Math.random() - 0.5) * ROACH_LENGTH * 0.75,
      ROACH_LENGTH * 0.035,
      ROACH_LENGTH * (-0.55 - i * 0.14 - Math.random() * 0.22),
    );
    egg.rotation.y = (Math.random() - 0.5) * 1.6;
    const r = ROACH_LENGTH * 0.042;
    group.add(egg);
    bits.push({ node: egg, size: new THREE.Vector3(r * 0.75, r * 0.7, r * 1.7) });
  }

  // 다 퍼지기 전에는 점만 하다. 0으로 두면 첫 프레임에 행렬이 퇴화한다.
  for (const bit of bits) bit.node.scale.setScalar(1e-4);

  return { group, stain, bits, stainAspect };
}

// ---------------------------------------------------------------------------

export function makeRoach(): Roach {

  // root는 미터 단위로 돌아다니고, model이 바퀴 단위를 미터로 줄인다.
  // 둘을 나눠 두면 '땅 위의 위치'와 '몸의 모양'이 섞이지 않는다.
  const root = new THREE.Group();
  const model = new THREE.Group();
  model.scale.setScalar(ROACH_LENGTH);
  root.add(model);
  // root는 미터 단위이고 Y 회전만 하므로, 그림자를 여기 붙이면 몸이
  // 앞뒤로 숙이거나 좌우로 기울어도 바닥에 평평하게 붙어 있다.
  root.add(makeContactShadow());

  // 짜부러질 때 드러날 것들. root에 붙인다 — 미터 단위에 Y 회전만 하는
  // 좌표계라, 몸이 어떻게 눌리든 자국은 바닥에 평평하게 붙어 있다.
  const gore = buildGore();
  root.add(gore.group);

  // 몸통만 따로 쥐고 있는다. 걸을 때 이 그룹만 흔들 것이다 — 고관절까지 같이
  // 흔들면 발 자국을 몸 공간으로 되돌리는 계산이 어긋난다.
  const body = buildBody(shell, wingShell, limb, eye);
  model.add(body);

  const antennae = [buildAntenna(limb, 1), buildAntenna(limb, -1)];
  for (const antenna of antennae) body.add(antenna.segments[0]);

  const legs: Leg[] = [];

  for (const side of [1, -1]) {
    LEG_SPECS.forEach((spec, index) => {
      const hip = new THREE.Group();
      const hipX = side * 0.13;
      hip.position.set(hipX, HIP_Y, spec.z);
      model.add(hip);

      const femur = new THREE.Group();
      hip.add(femur);
      femur.add(new THREE.Mesh(limbGeometry(spec.femur, 0.035, 0.022), limb));

      const knee = new THREE.Group();
      knee.position.x = spec.femur;
      femur.add(knee);
      knee.add(new THREE.Mesh(limbGeometry(spec.tibia, 0.022, 0.009), limb));

      // 종아리 가시. 실제 바퀴벌레 다리는 억센 가시로 덮여 있고, 가까이서
      // 보면 이게 '벌레'라는 인상의 큰 부분을 차지한다. 뒤·아래로 눕혀 둔다.
      for (let k = 0; k < 3; k += 1) {
        const spine = new THREE.Mesh(shared('spine', () => new THREE.ConeGeometry(0.011, 0.055, 4)), limb);
        // ConeGeometry는 +Y로 선다. 눕혀서 마디 뒤쪽을 향하게 한다.
        spine.rotation.z = Math.PI * 0.5 + 0.5;
        spine.rotation.x = (k % 2 === 0 ? 1 : -1) * 0.6;
        spine.position.x = spec.tibia * (0.3 + k * 0.25);
        knee.add(spine);
      }

      // 발목. IK가 맞추는 건 종아리 끝까지고, 이 마디는 거기서부터 바닥에
      // 눕는다. 끝점 하나로 땅을 찍는 것과 면으로 딛는 것은 실루엣이 다르다.
      const tarsus = new THREE.Group();
      tarsus.position.x = spec.tibia;
      knee.add(tarsus);
      tarsus.add(new THREE.Mesh(limbGeometry(0.13, 0.009, 0.004), limb));

      // ───────────────────────────────────────────────────────────────
      // 삼각보행(tripod gait).
      //
      // 곤충은 다리 6개를 삼각대 두 벌로 나눠 번갈아 딛는다.
      //   A: 오른앞 · 왼가운데 · 오른뒤
      //   B: 왼앞   · 오른가운데 · 왼뒤
      // 앞뒤 번호와 좌우를 더해 홀짝으로 가르면 정확히 그 두 벌이 된다.
      // 다리별 위상 배열도 상태 기계도 필요 없다.
      // ───────────────────────────────────────────────────────────────
      const tripod = (index + (side > 0 ? 0 : 1)) % 2 === 0 ? 1 : -1;

      const reach = restReach(spec);
      const restFootX = hipX + side * Math.cos(spec.spread) * reach;
      const restFootZ = spec.z + Math.sin(spec.spread) * reach;

      legs.push({
        hip,
        femur,
        knee,
        tarsus,
        // ±0.1 안쪽의 고정된 어긋남. 매 프레임 흔들면 떨림으로 보이므로
        // 다리마다 한 번 정해 두고 계속 쓴다.
        phaseOffset: rand(-0.1, 0.1),
        spec,
        side,
        index,
        tripod,
        hipX,
        restFootX,
        restFootZ,
        restYaw: Math.atan2(-(restFootZ - spec.z), side * Math.cos(spec.spread) * reach),
        footX: 0,
        footZ: 0,
        footLift: 0,
        swinging: false,
        fromX: 0,
        fromZ: 0,
        toX: 0,
        toZ: 0,
        swingStart: 0,
      });
    });
  }

  // ── 상태 ──
  //
  // 돌아다니다가, 위협이 다가오면 '얼어붙고', 그 다음 '튄다'.
  // 얼어붙는 단계가 핵심이다. 바로 도망가게 하면 그냥 빠른 물체로 보이는데,
  // 0.2초쯤 완전히 멎었다가 터지듯 달리면 그제서야 벌레처럼 보인다.
  type State = 'wander' | 'startle' | 'flee' | 'groom' | 'squashed' | 'held';
  let state: State = 'wander';
  /** 지금 상태가 끝날 때까지 남은 시간. */
  let stateTimer = 0;
  /** 마지막으로 놀란 지점(땅 공간). 여기서 멀어지는 쪽으로 튄다. */
  let threatX = 0;
  let threatZ = 0;
  /** 직전 프레임의 위협까지 거리. 접근 속도를 재는 데 쓴다. */
  let prevThreatDistance = Infinity;
  /** 더듬이를 닦고 있는 쪽. +면 오른쪽. */
  let groomSide = 1;
  /** 그루밍 동작의 자체 시계. */
  let groomT = 0;
  /** 이 z를 넘으면 다른 면으로 나가는 문. 그쪽으로는 막지 않는다. */
  let exitZ: number | null = null;
  /** 결국 가고 싶은 방향. 없으면 순수한 방황. */
  let driftHeading: number | null = null;
  /** 활동 범위(사각형). 면마다 다르다 — 복도 바닥은 좁고 벽면은 바닥까지 길다. */
  let boundHalfX = WANDER_RADIUS;
  let boundCenterZ = 0;
  let boundHalfZ = WANDER_RADIUS;
  /** -Z 변에 뚫려 있는 구멍의 반폭. 이 안쪽에서는 막지 않는다. */
  let boundGap = 0;
  /** 가장자리를 따라갈지. 면이 정한다. */
  let hugEdges = false;
  /** 벽을 어느 쪽으로 돌지. 한 번 정하면 한참 유지한다. */
  let edgeSide = Math.random() < 0.5 ? 1 : -1;
  /** 지금 벽이 몸의 어느 쪽에 있는지. +면 오른쪽. 더듬이를 그쪽으로 뻗는다. */
  let wallOnRight = 0;
  /** 가장자리를 넘어가려고 밀어붙이는 중인 남은 시간(초). 0이면 아니다. */
  let climbLeft = 0;
  /** 이 면에 올라선 뒤로 걸은 거리(m). 모서리를 또 넘어도 되는지 가른다. */
  let walkedHere = 0;

  let heading = Math.random() * Math.PI * 2;
  /** 지금 내고 있는 속도(m/s). */
  let speed = 0;
  /** 돌아다니기가 정한 가고 싶은 속도. speed가 이걸 쫓아간다. */
  let targetSpeed = 0;
  let turnRate = 0;
  /** 이번 프레임의 회전 각속도(rad/s). 제자리 회전도 걸음을 유발해야 한다. */
  let turnSpeed = 0;
  let timer = 0;
  let phase = Math.random() * Math.PI * 2;
  let antT = Math.random() * Math.PI * 2;
  /** 직전 프레임의 속도. 가속도를 재서 몸을 숙이는 데 쓴다. */
  let prevSpeed = 0;
  /** 이번 프레임에 비켜야 할 방향의 합. 매 프레임 비운다. */
  let avoidX = 0;
  let avoidZ = 0;
  /** 짜부러지는 진행도. 0에서 1로 간다. */
  let squashT = 0;
  /** 얼룩과 내장이 퍼진 정도(0~1). */
  let goreT = 0;
  /** 짜부러진 뒤 흐른 시간(초). 다리 경련이 이걸로 잦아든다. */
  let twitchT = 0;
  /** 손에 잡힌 뒤 흐른 시간(초). 발버둥이 이걸로 돈다. */
  let heldT = 0;

  const angles: JointAngles = { femurAngle: 0, kneeAngle: 0 };

  // ── 모서리를 넘는 동안의 몸 자세 ──
  //
  // 발은 새 면에 먼저 디디고, 몸은 모서리를 중심으로 돌아서 따라온다.
  // 실제 곤충이 그렇게 넘어간다. 발이 이미 새 면에 박혀 있으므로 미끄러지지
  // 않고, 몸이 돌아가는 동안 다리가 늘어나며 모서리를 걸친다.
  //
  // pivot은 '아직 남아 있는 옛 면의 자세'다. 전환 순간 옛 면의 상대 자세로
  // 시작해서 0으로 녹는다.
  const pivot = new THREE.Quaternion();
  /** 전환이 시작될 때의 상대 자세. 매 프레임 여기서부터 절대 보간한다. */
  const pivotStart = new THREE.Quaternion();
  const headingQuat = new THREE.Quaternion();
  const inverseBody = new THREE.Quaternion();
  const footDelta = new THREE.Vector3();
  const Y_AXIS = new THREE.Vector3(0, 1, 0);
  let pivotLeft = 0; // 남은 전환 시간(초)

  const TRANSITION_TIME = 0.25;

  /** heading과 전환 회전을 합쳐 root의 자세를 만든다. */
  function applyPose(dt: number): void {
    if (pivotLeft > 0) {
      pivotLeft = Math.max(0, pivotLeft - dt);
      // 매번 '시작 자세에서 얼마나 왔는지'로 절대 보간한다. 직전 값에서
      // 조금씩 더 slerp하면 프레임레이트에 따라 수렴 속도가 달라진다.
      const done = 1 - pivotLeft / TRANSITION_TIME;
      pivot.copy(pivotStart).slerp(IDENTITY, done * done * (3 - 2 * done));
    }

    headingQuat.setFromAxisAngle(Y_AXIS, heading);
    // 면 안에서 heading으로 돌린 뒤, 모서리를 중심으로 남은 만큼 더 돌린다.
    root.quaternion.copy(pivot).multiply(headingQuat);
  }

  /** 몸 공간의 한 점을 땅 공간으로. root의 회전은 Y축뿐이라 손으로 푼다. */
  function toGroundX(bx: number, bz: number): number {
    return root.position.x + (Math.cos(heading) * bx + Math.sin(heading) * bz) * ROACH_LENGTH;
  }
  function toGroundZ(bx: number, bz: number): number {
    return root.position.z + (-Math.sin(heading) * bx + Math.cos(heading) * bz) * ROACH_LENGTH;
  }

  /** 발을 모두 쉬는 자리에 놓는다. */
  function plantAll(): void {
    for (const leg of legs) {
      leg.footX = toGroundX(leg.restFootX, leg.restFootZ);
      leg.footZ = toGroundZ(leg.restFootX, leg.restFootZ);
      leg.footLift = 0;
      leg.swinging = false;
    }
  }

  // ───────────────────────────────────────────────────────────────────────
  // 돌아다니기
  //
  // 물리도 속도 벡터도 없다. 방향각 하나를 적분할 뿐이다.
  // 벌레가 벌레로 보이는 건 다리가 아니라 '달리다 뚝 멈추고 한참 가만히
  // 있다가 또 달리는' 리듬에서 온다. 그래서 멈추는 구간이 가장 길다.
  // ───────────────────────────────────────────────────────────────────────
  function scare(x: number, z: number): void {
    if (state !== 'wander') return;
    state = 'startle';
    stateTimer = rand(0.12, 0.35);
    threatX = x;
    threatZ = z;
    // 즉시 멎는다. 감쇠를 거치지 않는 유일한 곳이다 — 놀란 벌레는 정말로
    // 한 프레임에 멈춘다. 가속과 달리 급제동은 발을 늘어뜨리지 않는다.
    targetSpeed = 0;
    speed = 0;
    turnRate = 0;
  }

  function beginFlee(): void {
    state = 'flee';
    stateTimer = rand(0.7, 1.5);
    // 위협 반대쪽. 정확히 반대로만 가면 기계처럼 보이니 조금 흩뜨린다.
    const away = Math.atan2(root.position.x - threatX, root.position.z - threatZ);
    heading = away + rand(-0.5, 0.5);
    targetSpeed = MAX_SPEED;
    turnRate = rand(-0.4, 0.4);
  }

  function behave(dt: number): void {
    if (state === 'startle') {
      // 아무것도 하지 않는다. 방향도 안 틀고 움직이지도 않는다.
      stateTimer -= dt;
      if (stateTimer <= 0) beginFlee();
      return;
    }

    if (state === 'groom') {
      stateTimer -= dt;
      groomT += dt;
      if (stateTimer <= 0) {
        state = 'wander';
        timer = rand(0.3, 1.0);
        // 닦던 앞다리를 제자리에 다시 내려놓는다.
        for (const leg of legs) {
          if (leg.index === 0 && leg.side === groomSide) {
            leg.footX = toGroundX(leg.restFootX, leg.restFootZ);
            leg.footZ = toGroundZ(leg.restFootX, leg.restFootZ);
            leg.footLift = 0;
            leg.swinging = false;
          }
        }
      }
      return;
    }

    if (state === 'flee') {
      stateTimer -= dt;
      heading += turnRate * dt;
      if (stateTimer <= 0) {
        state = 'wander';
        targetSpeed = 0;
        timer = rand(0.3, 0.9); // 숨 돌리고 다시 평소대로
      }
      return;
    }

    timer -= dt;

    if (timer <= 0) {
      if (targetSpeed > 0) {
        targetSpeed = 0; // 멈춤
        turnRate = 0; // 몸만 계속 도는 일이 없게. 멈추면 완전히 멈춘다.
        timer = rand(0.3, 1.2);

        // 멈춘 김에 종종 더듬이를 닦는다. 바퀴벌레는 멈춰 있는 동안 정말로
        // 가만히 있지 않는다. 우리 바퀴는 시간의 대부분을 서서 보내므로,
        // 그 시간이 비어 있으면 '멈춘 모형'으로 보인다.
        if (Math.random() < 0.25) {
          state = 'groom';
          stateTimer = rand(1.2, 2.5);
          groomSide = Math.random() < 0.5 ? 1 : -1;
          groomT = 0;
        }
      } else if (Math.random() < 0.3) {
        targetSpeed = rand(0.32, MAX_SPEED); // 가끔 확 달린다
        timer = rand(0.3, 0.8);
        turnRate = rand(-0.5, 0.5); // 달릴 때는 거의 직진
      } else {
        targetSpeed = rand(0.1, 0.2); // 평소 걸음. 몸길이의 2~5배/초
        timer = rand(0.5, 1.5);
        turnRate = rand(-1.2, 1.2);
      }
    }

    heading += turnRate * dt;

    // ── 서로 비키기 ──
    //
    // 가까운 이웃이 있으면 그 반대쪽으로 튼다. 겹치지 않게 하는 것이 일차
    // 목적이지만, 효과는 그것만이 아니다. 여럿이 같은 경계를 따라 돌면 한
    // 궤도에 줄줄이 늘어서는데, 서로 밀면 그 줄이 저절로 흐트러진다.
    if (avoidX !== 0 || avoidZ !== 0) {
      const want = Math.atan2(avoidX, avoidZ);
      // 피하는 힘이 셀수록(= 가까울수록) 많이 튼다.
      const urgency = Math.min(1, Math.hypot(avoidX, avoidZ));
      heading += wrapAngle(want - heading) * Math.min(1, dt * 6 * urgency);
      avoidX = 0;
      avoidZ = 0;
    }

    // 가고 싶은 방향이 있으면 아주 천천히 그쪽으로 끌린다.
    //
    // 레일이 아니라 성향이다. 돌아다니다 멈추고 벽을 따라가는 성격은 그대로
    // 두되, 길게 보면 결국 그쪽으로 흘러간다. 이게 없으면 바퀴가 원 둘레만
    // 돌다가 끝난다 — 나갈 이유가 없으니까.
    if (driftHeading !== null && speed > 0.005) {
      heading += wrapAngle(driftHeading - heading) * Math.min(1, dt * 1.5);
    }
  }

  /** 상태와 무관하게 매 프레임 도는 이동 처리. */
  function move(dt: number): void {
    // 목표 속도를 실제 속도가 쫓아간다. 감쇠율이 높아서 체감은 거의 즉발이지만,
    // 불연속이 사라지는 것이 중요하다. 전에는 속도가 0에서 최대로 한 프레임에
    // 튀는 바람에, 땅에 박힌 발이 다음 걸음 전에 쭉 끌려가 다리가 늘어났다.
    // 멈출 때도 마찬가지로, 이 감쇠가 있어야 걸음이 끝까지 마무리된다.
    speed += (targetSpeed - speed) * Math.min(1, dt * 14);
    if (Math.abs(speed - targetSpeed) < 0.002) speed = targetSpeed;

    const headingBefore = heading;

    // ── 주촉성: 벽에 몸을 붙이고 따라간다 ──
    //
    // 바퀴벌레는 열린 공간을 가로지르지 않는다. 상자에 넣으면 가장자리에
    // 붙어서 둘레를 돈다. 이게 질주 다음으로 특징적인 행동이고, 이걸 넣기
    // 전까지는 아무리 다리를 잘 움직여도 '벌레처럼 돌아다닌다'는 느낌이
    // 안 난다.
    //
    // 벽 쪽으로 밀지도, 중앙으로 되돌리지도 않는다. 벽의 '접선' 방향을
    // 목표 삼고, 간격이 틀어진 만큼만 법선 성분을 섞는다.
    //
    // ── 가장 가까운 변 하나만 '벽'으로 본다 ──
    //
    // 사각형에는 변이 넷이다. 넷을 한꺼번에 섞으면 구석에서 두 힘이 겹쳐
    // 대각선으로 밀려 나간다. 실제로 벌레가 더듬는 벽도 한 번에 하나다.
    // 그래서 넷 중 가장 가까운 변을 골라, 원일 때와 똑같이 처리한다.
    //
    // 구석에서는 고른 변이 바뀌면서 바깥 법선이 90° 꺾이는데, 조향에 속도
    // 제한(dt * 7)이 걸려 있어 꺾이는 게 아니라 돌아 나간다. 접선이
    // (-nz, nx) * edgeSide라 도는 방향(시계/반시계)도 저절로 이어진다.
    wallOnRight = 0;

    // 멈춰 있을 때는 조향하지 않는다. 안 그러면 벽 옆에 선 채로 각도만
    // 영원히 맞추느라 제자리에서 빙빙 돈다 — 멈춤이 멈춤이 아니게 된다.
    if (state !== 'startle' && speed > 0.005) {
      const offsetZ = root.position.z - boundCenterZ;

      // 나가는 문 쪽은 막지 않는다. 벽을 따라가다가도 문 근처에 오면
      // 조향을 놓아 줘서, 걸어 나갈 수 있게 한다.
      const atExit = exitZ !== null && root.position.z > exitZ - EDGE_BAND * 2;

      let gap = Infinity; // 가장 가까운 변까지 남은 거리. 음수면 넘어갔다.
      let nx = 0; // 그 변의 바깥 방향
      let nz = 0;
      const consider = (distance: number, ox: number, oz: number): void => {
        if (distance >= gap) return;
        gap = distance;
        nx = ox;
        nz = oz;
      };

      consider(boundHalfX - root.position.x, 1, 0);
      consider(boundHalfX + root.position.x, -1, 0);
      // +Z 변이 나가는 문이면 아예 변으로 세지 않는다.
      if (!atExit) consider(boundHalfZ - offsetZ, 0, 1);
      // -Z 변에 구멍이 뚫려 있으면 그 폭 안에서는 변이 없다.
      if (Math.abs(root.position.x) > boundGap) consider(boundHalfZ + offsetZ, 0, -1);

      // ── 가끔은 넘어간다 ──
      //
      // 가장자리를 따라가기만 하면 거기서 끝이다(EDGE_CLIMB_RATE 주석 참고).
      // 그래서 가끔 마음을 먹고 바깥을 곧장 향해 잠깐 밀어붙인다. 그 자리에
      // 모서리가 있으면 넘어가고, 막힌 벽이면 2cm쯤 들이받고 돌아선다 —
      // 벌레가 벽을 더듬다 올라타려다 미끄러지는 것과 같은 모양이다.
      const climbing = climbLeft > 0 && gap > -EDGE_CLIMB_DEPTH;
      // 넘어설 만큼 넘어섰는데 아직 이 면이다 = 넘어갈 데가 없었다.
      if (!climbing) climbLeft = 0;

      // 주촉성은 '머무르며 살피는' 면의 행동이고, 그런 면에서만 켠다.
      // 지나가는 면(복도 바닥, 벽면)에서 켜 두면 둘레만 돌다가 목적지에
      // 영영 닿지 않는다. 꺼 두면 경계는 '넘어가면 되돌리는' 선으로만 남는다.
      if (climbing) {
        climbLeft -= dt;
        const want = Math.atan2(nx, nz);
        heading += wrapAngle(want - heading) * Math.min(1, dt * 7);
      } else if (hugEdges && gap < EDGE_BAND) {
        // 접선. edgeSide가 도는 방향을 정한다.
        const tx = -nz * edgeSide;
        const tz = nx * edgeSide;
        // 간격이 EDGE_HUG보다 좁으면 안으로, 넓으면 바깥으로 당긴다.
        const correction = clamp((EDGE_HUG - gap) * 10, -1, 1);
        const want = Math.atan2(tx - nx * correction, tz - nz * correction);
        heading += wrapAngle(want - heading) * Math.min(1, dt * 7);

        // 벽이 몸의 왼쪽인지 오른쪽인지. 오른쪽 방향 벡터와 바깥 방향의 내적.
        wallOnRight = nx * Math.cos(heading) - nz * Math.sin(heading);

        // 가끔 도는 방향을 바꾼다. 늘 같은 쪽으로만 돌면 궤도처럼 보인다.
        if (Math.random() < dt * 0.15) edgeSide = -edgeSide;

        // 가끔은 돌지 말고 넘어가 본다.
        if (Math.random() < dt * EDGE_CLIMB_RATE) climbLeft = EDGE_CLIMB_TIME;
      } else if (gap < 0) {
        // 변을 넘어갔다. 그 변의 안쪽으로 되돌린다.
        const home = Math.atan2(-nx, -nz);
        heading += wrapAngle(home - heading) * Math.min(1, dt * 2);
      }
    }

    // 이번 프레임에 '실제로' 돈 각. turnRate만 보면 안 되는 게, 위의 복귀
    // 조향처럼 heading을 직접 건드리는 곳이 따로 있기 때문이다.
    turnSpeed = Math.abs(wrapAngle(heading - headingBefore)) / dt;

    root.position.x += Math.sin(heading) * speed * dt;
    root.position.z += Math.cos(heading) * speed * dt;
    walkedHere += speed * dt;
  }

  function senseThreat(dt: number, threat: THREE.Vector3 | null): void {
    if (threat === null) {
      prevThreatDistance = Infinity;
      return;
    }

    const distance = Math.hypot(threat.x - root.position.x, threat.z - root.position.z);
    // +면 다가오는 중. 바퀴벌레는 '가까이 있는 것'이 아니라 '갑자기 움직이는
    // 것'에 반응한다. 거리만 보면 가만히 선 사람 앞에서 영영 도망만 친다.
    const approach = prevThreatDistance === Infinity ? 0 : (prevThreatDistance - distance) / dt;
    prevThreatDistance = distance;

    if (distance < SCARE_RADIUS && approach > SCARE_APPROACH) scare(threat.x, threat.z);
  }

  /**
   * 손에 잡힌 자세.
   *
   * 걷는 코드를 통째로 건너뛴다. IK도 끈다 — 디딜 땅이 없고, 발이 어디 있어야
   * 하는지가 더는 질문이 아니다. 대신 온몸이 쉬지 않고 버둥거린다.
   *
   * 잡힌 벌레가 무서운 건 모양이 아니라 '멈추지 않는다'는 것이다. 걸을 때의
   * 다리는 규칙적이라 기계처럼 읽히는데, 여기서는 여섯이 제각기 다른 박자로
   * 허공을 긁어야 한다. 그래서 다리마다 위상과 주파수를 어긋나게 준다.
   *
   * 더듬이는 걷는 쪽 코드를 못 쓴다(그건 아래 update의 뒷부분에 있고, 잡힌
   * 동안에는 거기까지 가지 않는다). 짧게 다시 적는다 — 더듬이가 멈춘 채
   * 다리만 버둥대면 죽은 것을 흔드는 그림이 된다.
   */
  function poseHeld(dt: number): void {
    heldT += dt;

    model.scale.setScalar(ROACH_LENGTH);

    // 몸통: 손가락 사이에서 비틀린다. 주기가 다른 셋을 축마다 따로 줘서,
    // 되풀이되는 자세가 눈에 띄지 않게 한다.
    body.position.y = 0;
    body.rotation.set(
      Math.sin(heldT * 9.3) * 0.22,
      Math.sin(heldT * 5.1) * 0.26,
      Math.sin(heldT * 7.7) * 0.3,
    );

    // 몸 전체는 붙들린 자리를 축으로 느리게 몸부림친다.
    model.rotation.set(
      Math.sin(heldT * 3.1) * 0.3,
      Math.sin(heldT * 2.3) * 0.35,
      Math.sin(heldT * 2.7) * 0.4,
    );

    legs.forEach((leg, i) => {
      const t = heldT * (15 + i * 2.6) + i * 1.9;
      leg.hip.rotation.y = leg.restYaw + leg.side * (0.45 + Math.sin(t) * 0.5);
      leg.femur.rotation.z = -0.45 + Math.sin(t * 1.27 + 1) * 0.55;
      leg.knee.rotation.z = -0.8 + Math.sin(t * 0.91 + 2) * 0.75;
      leg.tarsus.rotation.z = Math.sin(t * 1.63) * 0.45;
    });

    for (const antenna of antennae) {
      antenna.segments.forEach((segment, i) => {
        const t = heldT * (12 + i * 3.4) + antenna.side * 1.7 + i * 2.1;
        if (i === 0) {
          // 걷는 쪽과 같은 약속이다 — 오른쪽은 -각, 왼쪽은 π+각.
          const spread = 1.0 + Math.sin(t) * 0.6;
          segment.rotation.y = antenna.side > 0 ? -spread : Math.PI + spread;
          segment.rotation.z = Math.sin(t * 1.3) * 0.55;
        } else {
          segment.rotation.y = Math.sin(t) * 0.5;
          segment.rotation.z = -0.25 + Math.sin(t * 1.3) * 0.45;
        }
      });
    }
  }

  /**
   * 짜부러진 자세.
   *
   * IK를 건너뛴다. 발이 어디 있어야 하는지가 더는 의미 없고, 다리는 눌려서
   * 바깥으로 벌어진 채 굳는다. 몸은 위아래로 눌리고 옆으로 퍼진다.
   */
  function poseSquashed(dt: number): void {
    squashT = Math.min(1, squashT + dt * 8);
    const t = squashT * squashT * (3 - 2 * squashT);

    model.scale.set(
      ROACH_LENGTH * (1 + 0.22 * t),
      ROACH_LENGTH * (1 - 0.8 * t),
      ROACH_LENGTH * (1 + 0.18 * t),
    );

    body.position.y = -0.03 * t;
    body.rotation.set(0, 0, 0);

    for (const leg of legs) {
      // 쉬는 방향보다 더 벌어진 채로 눌린다.
      leg.hip.rotation.y = leg.restYaw + leg.side * 0.35 * t;
      leg.femur.rotation.z = leg.femur.rotation.z * (1 - t) + -0.05 * t;
      leg.knee.rotation.z = leg.knee.rotation.z * (1 - t) + -0.1 * t;
      leg.tarsus.rotation.z = leg.tarsus.rotation.z * (1 - t);
    }

    // ── 터진 것들 ──
    //
    // 몸이 눌리는 것(0.12초)보다 느리게 퍼진다. 같이 가면 한 동작으로 보여서
    // '눌렸다'로 끝나는데, 자국이 뒤따라 번져야 '터졌다'가 된다.
    goreT = Math.min(1, goreT + dt / GORE_SPREAD);
    const g = goreT * (2 - goreT); // 처음에 확 밀려 나오고 천천히 멎는다
    // PlaneGeometry는 X-Y에 서 있고 X로 눕혀 뒀다. 그래서 로컬 x가 땅의 가로,
    // 로컬 y가 땅의 세로다 — z를 건드려도 아무 일도 일어나지 않는다.
    const spread = 0.3 + 0.7 * g;
    gore.stain.scale.set(gore.stainAspect.x * spread, gore.stainAspect.z * spread, 1);
    for (const bit of gore.bits) {
      bit.node.scale.set(bit.size.x * g, bit.size.y * g, bit.size.z * g);
    }

    // ── 경련 ──
    //
    // 눌린 자세로 바로 굳으면 소품이다. 죽은 것과 죽어 가는 것의 차이가 여기
    // 있고, 보는 사람이 손을 떼고도 한참 쳐다보게 되는 것도 이것 때문이다.
    //
    // 사인 하나면 규칙적인 떨림이라 기계처럼 보인다. 주기가 다른 둘을 곱하면
    // 떨다 멎다 다시 떠는 모양이 나온다.
    twitchT += dt;
    const left = 1 - twitchT / TWITCH_TIME;
    if (left > 0) {
      const amount = left * left * 0.3;
      legs.forEach((leg, i) => {
        const beat = Math.sin(twitchT * (22 + i * 4.3) + i) * Math.sin(twitchT * 6.5 + i * 2.1);
        leg.knee.rotation.z += beat * amount;
        leg.hip.rotation.y += beat * amount * 0.45;
      });
    }
  }

  function update(dt: number, speedScale: number, threat: THREE.Vector3 | null): void {
    if (dt <= 0) return;

    if (state === 'squashed') {
      poseSquashed(dt);
      avoidX = 0;
      avoidZ = 0;
      return;
    }

    if (state === 'held') {
      poseHeld(dt);
      avoidX = 0;
      avoidZ = 0;
      return;
    }

    senseThreat(dt, threat);
    behave(dt);
    move(dt);
    applyPose(dt);
    inverseBody.copy(root.quaternion).invert();

    // 제자리에서 돌기만 해도 발은 옮겨 디뎌야 한다. 몸 중심에서 발까지가
    // 대략 FOOT_RADIUS이므로, 각속도에 그걸 곱하면 발이 도는 속도가 나온다.
    // 이걸 빼먹으면 회전할 때 다리가 얼어붙은 채 몸만 돌아간다.
    const gaitSpeed = speed + turnSpeed * FOOT_RADIUS;
    const speedNorm = clamp((gaitSpeed * speedScale) / MAX_SPEED, 0, 1);

    // ── 걸음의 박자 ──
    //
    // 속도에 비례할 뿐 바닥값이 없다. 멈추면 위상도 멈추고, 그래서 다리도
    // 멈춘다. 전에는 바닥값이 있어서 가만히 선 채로 초당 한 번씩 발을 들었다 —
    // 제자리걸음하는 벌레는 없다.
    //
    // 다만 발이 공중에 있는 동안 위상이 멈추면 그 발은 영영 떠 있게 된다.
    // 그래서 누군가 발을 떼고 있는 동안에는 최소 박자를 보장해서, 하던 걸음을
    // 마치고 모두 땅에 닿은 뒤에 멎게 한다.
    // 걸음 주기를 '보폭'에서 거꾸로 구한다. 전에는 주기를 속도에 비례시켰는데,
    // 그러면 보폭 = 속도 × 반주기 가 속도와 무관한 상수가 되어 버린다.
    // 느리게 걷든 달리든 늘 같은 폭으로 성큼거렸고, 그 폭이 다리 범위를
    // 넘어서 발이 끌렸다. 보폭을 먼저 정하고 주기를 맞추면 둘 다 해결된다.
    const strideUnits = MIN_STRIDE + (MAX_STRIDE - MIN_STRIDE) * speedNorm;
    const anySwinging = legs.some((leg) => leg.swinging);
    const wantedRate =
      gaitSpeed > 0.001
        ? (Math.PI * gaitSpeed) / (strideUnits * ROACH_LENGTH)
        : anySwinging
          ? 9
          : 0;

    // 한 프레임에 위상이 π를 넘으면 디딤/뗌 판정이 반주기를 통째로 건너뛴다.
    // 평소엔 걸릴 일이 없지만 프레임이 한 번 끊기면 바로 걸린다. 잘라 둔다.
    const phaseRate = Math.min(wantedRate, 2.5 / dt);
    phase += dt * phaseRate;

    // 발을 앞으로 내놓을 거리. 주기는 회전까지 포함한 gaitSpeed로 정했지만,
    // 발을 '앞으로' 보내는 건 전진 성분뿐이다. 제자리에서 돌 때 발이 앞으로
    // 나가면 안 된다.
    const stride = phaseRate > 0 ? (speed * Math.PI) / phaseRate : 0;

    // 그루밍 동작의 당김 주기. 0에서 1 사이를 오간다.
    const groomPull = state === 'groom' ? Math.sin(groomT * 7) * 0.5 + 0.5 : 0;

    for (const leg of legs) {
      // 닦는 중인 앞다리는 IK를 건너뛰고 손으로 쓴 자세를 쓴다.
      // 발이 땅이 아니라 입을 향하므로, 발 위치에서 각도를 푸는 방식이
      // 애초에 들어맞지 않는다. 다섯 다리는 그대로 몸을 지탱한다.
      if (state === 'groom' && leg.index === 0 && leg.side === groomSide) {
        leg.hip.rotation.y = (leg.side > 0 ? -1 : 1) * (1.25 + groomPull * 0.18);
        leg.femur.rotation.z = 0.85 + groomPull * 0.25;
        leg.knee.rotation.z = -1.75 - groomPull * 0.35;
        leg.tarsus.rotation.z = 0.6;
        continue;
      }

      // sin이 양수인 반주기에 발을 뗀다. 삼각대마다 부호가 반대라
      // 한쪽이 뗄 때 다른 쪽이 딛는다. 다리마다 아주 조금씩 어긋나 있어서
      // 세 발이 동시에 '탁' 떨어지지 않는다.
      const legPhase = phase + leg.phaseOffset;
      const shouldSwing = Math.sin(legPhase) * leg.tripod > 0;

      if (shouldSwing && !leg.swinging) {
        // 막 뗐다. 지금 자리에서 출발해, 앞으로 반 보폭 나간 자리에 놓는다.
        // 디딤이 끝날 때쯤 발이 쉬는 자리에서 반 보폭 뒤에 와 있게 된다.
        leg.swinging = true;
        leg.swingStart = legPhase;
        leg.fromX = leg.footX;
        leg.fromZ = leg.footZ;
        leg.toX = toGroundX(leg.restFootX, leg.restFootZ) + Math.sin(heading) * stride * 0.5;
        leg.toZ = toGroundZ(leg.restFootX, leg.restFootZ) + Math.cos(heading) * stride * 0.5;
      } else if (!shouldSwing && leg.swinging) {
        // 내려놓았다. 이 순간부터 이 발은 땅에 박힌다.
        leg.swinging = false;
        leg.footX = leg.toX;
        leg.footZ = leg.toZ;
        leg.footLift = 0;
      }

      if (leg.swinging) {
        // 반주기 동안 0 → 1. 위상으로 직접 재면 프레임 길이와 무관하다.
        const t = clamp((legPhase - leg.swingStart) / Math.PI, 0, 1);
        const ease = t * t * (3 - 2 * t);
        leg.footX = leg.fromX + (leg.toX - leg.fromX) * ease;
        leg.footZ = leg.fromZ + (leg.toZ - leg.fromZ) * ease;
        // 올라갔다 내려오는 호. 속도가 0이면 거의 들지 않는다.
        leg.footLift = Math.sin(Math.PI * t) * STEP_HEIGHT * (0.25 + 0.75 * speedNorm);
      }

      // ── 땅 공간의 발 자국 → 몸 공간 → 관절 각도 ──
      //
      // 예전에는 heading의 sin/cos으로 2D 역회전만 했다. 모서리를 넘는 동안
      // 몸이 땅과 어긋난 자세로 돌아가므로 더 이상 그럴 수 없다. root의 자세
      // 전체의 역을 쓴다. 발을 들어 올린 높이도 땅의 법선 방향이라 같이 넣는다.
      footDelta.set(
        leg.footX - root.position.x,
        leg.footLift * ROACH_LENGTH,
        leg.footZ - root.position.z,
      );
      footDelta.applyQuaternion(inverseBody).divideScalar(ROACH_LENGTH);

      const vx = footDelta.x - leg.hipX;
      const vz = footDelta.z - leg.spec.z;

      // 다리가 놓인 평면의 방향. Y 회전 a는 +X를 (cos a, 0, -sin a)로 보낸다.
      let yaw = Math.atan2(-vz, vx);
      // 쉬는 방향에서 너무 벗어나면 다리가 서로 꼬인다. 각 차이로 자른다.
      yaw = leg.restYaw + clamp(wrapAngle(yaw - leg.restYaw), -0.8, 0.8);
      leg.hip.rotation.y = yaw;

      solveLeg(leg.spec, Math.hypot(vx, vz), footDelta.y - HIP_Y, angles);
      leg.femur.rotation.z = angles.femurAngle;
      leg.knee.rotation.z = angles.kneeAngle;

      // 발목은 앞 두 마디가 만든 각을 통째로 상쇄해서, 다리가 어떤 자세든
      // 땅과 거의 나란해진다. 발을 들었을 때만 살짝 아래로 늘어뜨린다.
      leg.tarsus.rotation.z =
        -(angles.femurAngle + angles.kneeAngle) - 0.08 - leg.footLift * 1.2;
    }

    // ── 몸통 흔들림 ──
    // 좌우 기울기는 걸음과 같은 주기다. 지금 딛고 있는 삼각대 쪽으로 몸이
    // 쏠린다. 위아래는 두 배 주기 — 한 걸음에 두 번, 삼각대가 번갈아 밀어내므로.
    // 쉴 때는 몸을 바닥 쪽으로 낮춘다. 바퀴벌레는 멈추면 납작 엎드린다.
    body.position.y = Math.sin(phase * 2) * 0.012 * speedNorm - (1 - speedNorm) * 0.012;
    body.rotation.z = Math.sin(phase) * 0.05 * speedNorm;
    // 달릴 때 앞을 살짝 숙이고, 그 위에 가감속을 얹는다.
    // 급정거하면 코가 처박히고 출발할 땐 들린다. 관성이 있는 것처럼 보이게
    // 하는 건 이 한 줄이고, 몸을 실제로 기울이는 것보다 훨씬 싸다.
    const accel = (speed - prevSpeed) / dt;
    prevSpeed = speed;
    body.rotation.x = speedNorm * 0.06 + clamp(accel * 0.25, -0.09, 0.09);

    // ── 더듬이 ──
    // 걸음 위상과 무관한 자기 박자로 흔든다. 다리는 규칙적인데 더듬이만
    // 어긋나야 살아 있는 것처럼 보인다. 멈춰 있을 때도 계속 움직인다.
    antT += dt * 2.6;
    for (const antenna of antennae) {
      antenna.segments.forEach((segment, i) => {
        const t = antT * (1 + i * 0.37) + antenna.side * 1.7 + i * 2.1;
        if (i === 0) {
          // 뿌리 마디는 크게 휘젓는다.
          //
          // 다리와 같은 변환이다. 마디는 +X로 뻗는데 더듬이는 앞(+Z)을 향해야
          // 하므로, '오른쪽에서 앞으로 잰 각'을 Y 회전으로 바꿔 준다.
          // 오른쪽은 -각, 왼쪽은 π+각. 이걸 빼먹으면 더듬이가 옆뒤를 가리킨다.
          // 닦이는 중인 더듬이는 앞다리 쪽으로 끌려 내려온다.
          const groomed = state === 'groom' && antenna.side === groomSide;

          // 벽을 따라갈 때는 벽 쪽 더듬이를 바깥으로 눕혀 벽을 훑는다.
          // spread가 작을수록 옆을 향한다. 반대쪽 더듬이는 조금 더 앞을 본다.
          const toWall = clamp(antenna.side * wallOnRight, 0, 1);
          const spread = groomed
            ? 1.45 - groomPull * 0.12
            : 1.0 - toWall * 0.45 + (1 - toWall) * 0.12 + Math.sin(t) * 0.3;
          segment.rotation.y = antenna.side > 0 ? -spread : Math.PI + spread;
          segment.rotation.z = groomed
            ? -0.3 - groomPull * 0.28
            : 0.45 + Math.sin(t * 0.8) * 0.25;
        } else if (state === 'groom' && antenna.side === groomSide) {
          // 아래쪽으로 말려 다리 끝을 지나간다.
          segment.rotation.y = 0;
          segment.rotation.z = -0.3 - groomPull * 0.2;
        } else {
          segment.rotation.y = Math.sin(t) * 0.22;
          segment.rotation.z = -0.25 + Math.sin(t * 1.3) * 0.18;
        }
      });
    }
  }

  function placeOn(
    parent: THREE.Object3D,
    x: number,
    z: number,
    newHeading: number,
    fromPose?: THREE.Quaternion,
  ): void {
    if (root.parent !== parent) parent.add(root); // add가 이전 부모에서 떼어낸다

    root.position.set(x, 0, z);
    heading = newHeading;

    // 넘어가려던 마음은 여기서 끝난다. 그대로 두면 새 면에서도 바깥을 향해
    // 밀어붙이는데, 그 '바깥'이란 방금 넘어온 모서리다 — 곧장 되돌아간다.
    climbLeft = 0;
    walkedHere = 0;

    if (fromPose === undefined) {
      pivotLeft = 0;
      pivot.identity();
    } else {
      // 새 면 기준으로 본 옛 면의 자세. 여기서 0으로 녹는다.
      pivotStart.copy(fromPose);
      pivot.copy(fromPose);
      pivotLeft = TRANSITION_TIME;
    }

    applyPose(0);
    inverseBody.copy(root.quaternion).invert();
    root.updateMatrixWorld();

    // 발 자국은 이전 면의 좌표였다. 새 면에서 다시 디딘다.
    plantAll();
    prevThreatDistance = Infinity;
  }

  plantAll();
  update(0.001, 1, null);

  return {
    root,
    update,
    scare,
    squash() {
      if (state === 'squashed') return;
      state = 'squashed';
      speed = 0;
      targetSpeed = 0;
      turnRate = 0;
      squashT = 0;
      goreT = 0;
      twitchT = 0;
      // 터진 것들을 드러낸다. 메시 하나하나는 배칭이 숨겨 두므로, 켜고 끄는
      // 것은 반드시 이 그룹이어야 한다.
      gore.group.visible = true;
      // 발 자국은 이제 쓰이지 않는다. 다리는 IK 대신 눌린 자세로 굳는다.
    },
    hold() {
      if (state === 'squashed' || state === 'held') return;
      state = 'held';
      heldT = 0;
      speed = 0;
      targetSpeed = 0;
      turnRate = 0;
    },
    isHeld() {
      return state === 'held';
    },
    land() {
      if (state !== 'held') return;
      state = 'wander';
      model.rotation.set(0, 0, 0);
      body.rotation.set(0, 0, 0);
      plantAll();
      // 떨어진 자리에서 가만히 있을 리가 없다. 놀란 채로 시작한다.
      scare(root.position.x, root.position.z + 0.2);
    },
    revive() {
      if (state !== 'squashed' && state !== 'held') return;
      state = 'wander';
      squashT = 0;
      gore.group.visible = false;
      model.scale.setScalar(ROACH_LENGTH);
      model.rotation.set(0, 0, 0);
      body.position.y = 0;
      body.rotation.set(0, 0, 0);
      plantAll();
    },
    isSquashed() {
      return state === 'squashed';
    },
    avoid(x, z) {
      const dx = root.position.x - x;
      const dz = root.position.z - z;
      const distance = Math.hypot(dx, dz);
      if (distance < 1e-5) {
        // 정확히 겹쳐 있으면 방향이 없다. 아무 쪽으로나 민다.
        avoidX += 1;
        return;
      }
      // 가까울수록 세게. 몸길이쯤 떨어지면 거의 0이 된다.
      const push = Math.max(0, 1 - distance / (ROACH_LENGTH * 1.6));
      avoidX += (dx / distance) * push;
      avoidZ += (dz / distance) * push;
    },
    placeOn,
    getHeading() {
      return heading;
    },
    walkedSincePlaced() {
      return walkedHere;
    },
    setHeading(newHeading) {
      heading = newHeading;
    },
    setExitZ(z) {
      exitZ = z;
    },
    setDrift(newHeading) {
      driftHeading = newHeading;
    },
    setBounds(halfX, centerZ, halfZ, gapHalfWidth) {
      boundHalfX = halfX;
      boundCenterZ = centerZ;
      boundHalfZ = halfZ;
      boundGap = gapHalfWidth;
    },
    setHugEdges(on) {
      hugEdges = on;
    },
  };
}
