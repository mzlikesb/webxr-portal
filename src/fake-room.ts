import * as THREE from 'three';

// ---------------------------------------------------------------------------
// [미리보기 전용] 가짜 방 평면
//
// detectedPlanes는 XR 세션에만 온다. 그래서 방 껍데기 코드는 데스크톱에서
// 한 줄도 돌지 않고, 헤드셋을 쓰지 않으면 맞는지 틀렸는지 알 수조차 없다.
// 포털 페이드가 정확히 그렇게 오래 틀려 있었다 — XR 안에서만 돌아서.
//
// 그래서 런타임이 주는 것과 같은 모양의 평면 집합을 손으로 만든다. 방 껍데기
// 코드는 이게 가짜인 줄 모른다. 치수는 실제로 스캔된 방(3m × 3.16m × 2.4m)을
// 따랐고, -Z 벽을 미리보기용 가짜 포털이 걸린 z = -1.3에 맞춰 두었다.
//
// ── 일부러 뒤집어 둔 것들 ──
//
// 스펙은 평면의 법선이 로컬 +Y라고만 하고, 그게 방 안을 보는지 밖을 보는지는
// 말하지 않는다. 그래서 두 벽과 천장은 법선이 방 밖을 보도록 만들었다 —
// 뒤집기를 판정하는 코드가 실제로 돌아야 의미가 있다.
//
// 바닥의 폴리곤도 원점에서 벗어나게 두었다. 런타임이 주는 폴리곤이 평면 원점을
// 중심으로 한다는 보장이 없고, 그 경우 면의 원점을 사각형 중심으로 옮기는
// 코드가 필요해진다. 중심에 둔 폴리곤만으로 시험하면 그 길이 안 돈다.
// ---------------------------------------------------------------------------

/** 방 치수. 스캔된 방을 따랐다. */
const HALF_X = 1.5;
const HALF_Z = 1.58;
const HEIGHT = 2.4;
/** -Z 벽의 자리. 미리보기용 가짜 포털이 여기 걸려 있다. */
const BACK_Z = -1.3;
/** 바닥 사각형의 z 중심. 원점(0)에서 벗어나 있다 — 위 주석 참고. */
const FLOOR_CENTER_Z = BACK_Z + HALF_Z;

interface FakePlane {
  polygon: { x: number; y: number; z: number }[];
  semanticLabel: string;
  orientation: 'horizontal' | 'vertical';
  lastChangedTime: number;
  planeSpace: object;
  /** 이 평면의 월드 자세. 가짜 getPose가 돌려준다. */
  matrix: number[];
}

const planes: FakePlane[] = [];

/**
 * 평면 하나를 만든다.
 *
 * @param origin 평면 좌표계의 원점(월드)
 * @param normal 로컬 +Y가 가리킬 방향(월드). 방 안쪽이 아니어도 된다.
 * @param halfX 로컬 X 방향 반폭
 * @param halfZ 로컬 Z 방향 반폭
 * @param centerZ 사각형의 z 중심. 기본은 원점.
 */
function addPlane(
  label: string,
  origin: THREE.Vector3,
  normal: THREE.Vector3,
  halfX: number,
  halfZ: number,
  centerZ = 0,
): void {
  // 평면의 기저를 직접 세운다. 로컬 +Y가 법선, 로컬 +Z는 '위쪽'(벽) 또는
  // 월드 -Z(바닥·천장). 어느 축이 세로인지 스펙이 보장하지 않으므로,
  // 받는 쪽은 이걸 가정하지 않아야 한다.
  const up = new THREE.Vector3(0, 1, 0);
  const forward = new THREE.Vector3(0, 0, -1);
  const hint = Math.abs(normal.dot(up)) > 0.9 ? forward : up;

  const n = normal.clone().normalize();
  const f = hint.clone().addScaledVector(n, -hint.dot(n)).normalize();
  const r = new THREE.Vector3().crossVectors(n, f).normalize();

  const quaternion = new THREE.Quaternion().setFromRotationMatrix(
    new THREE.Matrix4().makeBasis(r, n, f),
  );

  planes.push({
    // 네 꼭짓점. 런타임도 사각형 방이면 이렇게 준다.
    polygon: [
      { x: -halfX, y: 0, z: centerZ - halfZ },
      { x: halfX, y: 0, z: centerZ - halfZ },
      { x: halfX, y: 0, z: centerZ + halfZ },
      { x: -halfX, y: 0, z: centerZ + halfZ },
    ],
    semanticLabel: label,
    orientation: Math.abs(n.y) > 0.9 ? 'horizontal' : 'vertical',
    lastChangedTime: 0,
    planeSpace: {},
    matrix: new THREE.Matrix4()
      .compose(origin, quaternion, new THREE.Vector3(1, 1, 1))
      .toArray(),
  });
}

const DOWN = new THREE.Vector3(0, -1, 0);
const UP = new THREE.Vector3(0, 1, 0);

// 바닥: 법선이 위(방 안쪽)를 본다. 뒤집지 않아야 한다.
//
// 폴리곤을 원점에서 밀어 두었다. 부호가 음수인 건 이 평면의 로컬 +Z가 월드
// -Z를 향하기 때문이다(위 addPlane의 힌트 참고). 받는 쪽이 어느 축이 어디를
// 향하는지 가정하지 않는지 보려고 일부러 이렇게 뒀다.
addPlane('floor', new THREE.Vector3(0, 0, 0), UP, HALF_X, HALF_Z, -FLOOR_CENTER_Z);

// 천장: 법선이 위(방 밖)를 본다. 뒤집어야 한다.
addPlane(
  'ceiling',
  new THREE.Vector3(0, HEIGHT, FLOOR_CENTER_Z),
  UP,
  HALF_X,
  HALF_Z,
);

// 네 벽. 둘은 안쪽, 둘은 밖을 보게 해서 두 경로를 다 지나게 한다.
const wallY = HEIGHT / 2;
// -Z 벽(포털이 걸린 벽): 안쪽(+Z)을 본다.
addPlane(
  'wall',
  new THREE.Vector3(0, wallY, BACK_Z),
  new THREE.Vector3(0, 0, 1),
  HALF_X,
  HEIGHT / 2,
);
// +Z 벽: 밖(+Z)을 본다 → 뒤집어야 한다.
addPlane(
  'wall',
  new THREE.Vector3(0, wallY, BACK_Z + HALF_Z * 2),
  new THREE.Vector3(0, 0, 1),
  HALF_X,
  HEIGHT / 2,
);
// -X 벽: 안쪽(+X)을 본다.
addPlane(
  'wall',
  new THREE.Vector3(-HALF_X, wallY, FLOOR_CENTER_Z),
  new THREE.Vector3(1, 0, 0),
  HALF_Z,
  HEIGHT / 2,
);
// +X 벽: 밖(+X)을 본다 → 뒤집어야 한다.
addPlane(
  'wall',
  new THREE.Vector3(HALF_X, wallY, FLOOR_CENTER_Z),
  new THREE.Vector3(1, 0, 0),
  HALF_Z,
  HEIGHT / 2,
);

// 걸러져야 하는 것들도 섞어 둔다. 라벨로 거르는 코드가 실제로 돌아야 한다.
// 기본 치수(1.24 x 0.72, 높이 0.72)와 일부러 다르게, 자리도 방 한가운데에서
// 비켜 둔다. 같게 두면 책상을 감지된 가구에 맞추는 코드가 아무 일도 안 한
// 채로 통과한다.
addPlane('table', new THREE.Vector3(0.5, 0.6, 0.5), UP, 0.75, 0.45);
addPlane('door', new THREE.Vector3(0.9, 1.0, BACK_Z), new THREE.Vector3(0, 0, 1), 0.45, 1.0);
// 너무 좁아서 걸을 가치가 없는 조각.
addPlane('wall', new THREE.Vector3(-1.2, 0.3, 1.0), DOWN, 0.15, 0.15);

const planeSet = new Set(planes);
const poseBySpace = new Map<object, { transform: { matrix: number[] } }>();
for (const plane of planes) {
  poseBySpace.set(plane.planeSpace, { transform: { matrix: plane.matrix } });
}

/**
 * XRFrame 대신 넘길 수 있는 가짜 프레임.
 *
 * 방 껍데기 코드가 쓰는 것만 들어 있다 — detectedPlanes와 getPose. 타입을
 * 맞추려고 캐스팅하는데, 실제 XRFrame의 나머지를 구현할 생각은 없기 때문이다.
 * 이 객체가 XR 세션에 들어가는 일은 없다.
 */
export const fakeRoomFrame = {
  detectedPlanes: planeSet,
  getPose: (space: object) => poseBySpace.get(space) ?? null,
} as unknown as XRFrame;

/** getPose에 넘길 가짜 기준 공간. 가짜 getPose는 이걸 보지 않는다. */
export const fakeRoomSpace = {} as unknown as XRReferenceSpace;
