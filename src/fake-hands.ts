import * as THREE from 'three';
import type { TrackedHand } from './hands';

// ---------------------------------------------------------------------------
// [미리보기 전용] 가짜 손
//
// 손 추적은 XR 세션에만 온다. 그래서 손바닥 디버그 패널은 데스크톱에서 한 줄도
// 돌지 않고, 헤드셋을 쓰지 않으면 맞는지 틀렸는지 알 수가 없다 — 가짜 방
// 평면(fake-room.ts)을 만든 것과 똑같은 이유다.
//
// 왼손을 눈앞에 띄워 손바닥이 카메라를 보게 세운다. 패널이 뜰 조건이 이것뿐이라
// 이걸로 자리·방향·글자까지 다 확인된다. 오른손 검지 끝은 창구로 아무 데나
// 옮길 수 있어서, 버튼을 누르는 길도 여기서 밟힌다.
// ---------------------------------------------------------------------------

/** 왼손을 눈에서 이만큼 앞에 둔다(m). 손바닥을 들여다보는 거리쯤. */
const REACH = 0.35;
/** 그리고 이만큼 아래, 이만큼 왼쪽에. */
const DROP = 0.12;
const LEFT = 0.1;

/** 손을 치워 두는 자리. 여기 있으면 아무것도 건드리지 않는다. */
const AWAY = new THREE.Vector3(0, -99, 0);

function makeFake(handedness: 'left' | 'right'): TrackedHand {
  return {
    handedness,
    tracked: true,
    tips: Array.from({ length: 5 }, () => new THREE.Vector3().copy(AWAY)),
    palm: new THREE.Vector3().copy(AWAY),
    palmNormal: new THREE.Vector3(0, 0, 1),
    palmUp: new THREE.Vector3(0, 1, 0),
    palmVelocity: new THREE.Vector3(),
    peakSpeed: 0,
  };
}

export const fakeHands: TrackedHand[] = [makeFake('left'), makeFake('right')];

const forward = new THREE.Vector3();
const right = new THREE.Vector3();
const up = new THREE.Vector3();

/**
 * 왼손을 눈앞에 세운다. 매 프레임 부른다.
 *
 * @param viewerPosition 머리 위치(월드)
 * @param viewerQuaternion 머리 자세(월드)
 */
export function updateFakeHands(
  viewerPosition: THREE.Vector3,
  viewerQuaternion: THREE.Quaternion,
): void {
  forward.set(0, 0, -1).applyQuaternion(viewerQuaternion);
  right.set(1, 0, 0).applyQuaternion(viewerQuaternion);
  up.set(0, 1, 0).applyQuaternion(viewerQuaternion);

  const left = fakeHands[0];
  left.palm
    .copy(viewerPosition)
    .addScaledVector(forward, REACH)
    .addScaledVector(up, -DROP)
    .addScaledVector(right, -LEFT);
  // 손바닥은 눈을 본다. 패널이 뜨는 조건이 정확히 이것이다.
  left.palmNormal.copy(forward).negate();
  left.palmUp.copy(up);
}

/**
 * 손 하나를 통째로 아무 자리·자세·속도로 둔다.
 *
 * 때리기 판정은 손바닥이 면을 마주 보는지, 얼마나 빨랐는지로 가른다. 그건
 * 머리로 맞출 수 있는 값이 아니라 실제로 돌려 봐야 하는 값이다. 손가락 끝 다섯
 * 개도 같은 자리에 둔다 — 판정이 그 여섯 점을 다 보기 때문이다.
 */
export function setFakeHand(
  handedness: 'left' | 'right',
  point: THREE.Vector3,
  palmNormal: THREE.Vector3,
  velocity: THREE.Vector3,
  peakSpeed: number,
): void {
  const hand = fakeHands.find((h) => h.handedness === handedness);
  if (hand === undefined) return;

  hand.tracked = true;
  hand.palm.copy(point);
  for (const tip of hand.tips) tip.copy(point);
  hand.palmNormal.copy(palmNormal).normalize();
  hand.palmVelocity.copy(velocity);
  hand.peakSpeed = peakSpeed;
}

/**
 * 오른손 검지 끝을 아무 데나 둔다. 버튼을 누르는 길을 밟아 보려고 둔 창구다.
 *
 * 미리보기에는 진짜 손가락이 없으니 눌렀다 떼는 것도 여기서 한다 — 눌러 두고
 * 다음 프레임에 멀리 치우면 한 번 누른 것이 된다.
 */
export function setFakeFingertip(x: number, y: number, z: number): void {
  fakeHands[1].tips[1].set(x, y, z);
}

/** 오른손을 치운다. 때려 본 뒤 계속 거기 있으면 매 프레임 때리게 된다. */
export function clearFakeHand(): void {
  setFakeHand('right', AWAY, UP_AXIS, ZERO, 0);
}

const UP_AXIS = new THREE.Vector3(0, 1, 0);
const ZERO = new THREE.Vector3();
