import * as THREE from 'three';

// ---------------------------------------------------------------------------
// 손 읽기
//
// 컨트롤러는 포즈 하나지만 손은 관절 스물다섯 개다. frame.getJointPose로 하나씩
// 읽는다. 세션이 hand-tracking을 못 받았거나 손이 시야 밖이면 아무것도 안 온다.
//
// 여기서 필요한 건 셋이다.
//   · 손가락 끝 — 건드렸는지
//   · 손바닥과 그 속도 — 내려쳤는지
//   · 손바닥이 보는 쪽 — 디버그 패널을 띄울지
//
// 손바닥 관절은 따로 없다. 손목과 중지 중수골의 중점을 손바닥으로 친다.
// 속도는 포즈에 들어 있지 않아 프레임 간 차이로 직접 구한다.
//
// 손바닥의 방향도 관절 하나로는 안 나온다. 관절 포즈에 회전이 들어 있긴
// 하지만, 그 좌표계의 어느 축이 손바닥 밖을 향하는지는 기억에 기대고 싶지
// 않은 종류의 약속이다. 대신 손목·검지 중수골·새끼 중수골 세 점으로 기저를
// 직접 세운다. 세 점이면 평면이 정해지고, 거기엔 약속이 필요 없다.
// ---------------------------------------------------------------------------

/** 손바닥 평면을 정하는 세 점. 손목에서 두 중수골로 뻗는다. */
const PALM_JOINTS = [
  'wrist',
  'index-finger-metacarpal',
  'pinky-finger-metacarpal',
] as const satisfies readonly XRHandJoint[];

const FINGER_TIPS = [
  'thumb-tip',
  'index-finger-tip',
  'middle-finger-tip',
  'ring-finger-tip',
  'pinky-finger-tip',
] as const satisfies readonly XRHandJoint[];

export interface TrackedHand {
  handedness: 'left' | 'right';
  /** 이번 프레임에 읽혔는지. 손이 시야 밖이면 false. */
  tracked: boolean;
  /** 손가락 끝 다섯 개(월드). tracked가 false면 값이 낡았다. */
  tips: THREE.Vector3[];
  /** 손바닥 중심(월드). */
  palm: THREE.Vector3;
  /**
   * 손바닥이 보는 쪽(월드, 단위). 손등이 아니라 바닥에서 나오는 쪽이다.
   *
   * 손목에서 검지 중수골로, 손목에서 새끼 중수골로 뻗은 두 벡터의 외적이다.
   *
   * 부호는 기기에서 확인한 것이다. 왼손을 펴서 얼굴 쪽으로 돌리면 검지 쪽이
   * 오른쪽, 새끼 쪽이 왼쪽이니 오른손 법칙으로 외적이 얼굴을 향할 거라고 보고
   * 짰는데, Quest에서는 반대였다 — 패널이 손바닥이 아니라 손등에 떴다.
   * 중수골의 자리가 손목 중심이 아니라 손등 쪽으로 치우쳐 있어서인 듯하다.
   * 어느 쪽이든 추측으로 둘 수 없는 값이라, 본 대로 적는다.
   */
  palmNormal: THREE.Vector3;
  /** 손바닥 평면 위에서 손가락 쪽(월드, 단위). 패널의 위쪽으로 쓴다. */
  palmUp: THREE.Vector3;
  /** 손바닥 속도(월드, m/s). 프레임 차이로 구한 뒤 약간 다듬었다. */
  palmVelocity: THREE.Vector3;
  /**
   * 최근 0.2초쯤의 최고 속력(m/s).
   *
   * 때리는 동작은 '빠르다'와 '닿았다'가 같은 순간이 아니다. 손바닥은 닿기
   * 직전에 이미 느려지므로, 접촉 프레임의 속도만 보면 세게 쳐도 느린 값이
   * 나온다. 조금 전까지 얼마나 빨랐는지를 따로 기억한다.
   */
  peakSpeed: number;
}

export interface HandTracker {
  hands: TrackedHand[];
  /** 관절이 어디 있는지 눈으로 보려고 띄우는 점들. 디버그용. */
  debug: THREE.Group;
  update(frame: XRFrame, referenceSpace: XRReferenceSpace, dt: number): void;
}

function makeHand(handedness: 'left' | 'right'): TrackedHand {
  return {
    handedness,
    tracked: false,
    tips: FINGER_TIPS.map(() => new THREE.Vector3()),
    palm: new THREE.Vector3(),
    palmNormal: new THREE.Vector3(0, 1, 0),
    palmUp: new THREE.Vector3(0, 0, -1),
    palmVelocity: new THREE.Vector3(),
    peakSpeed: 0,
  };
}

const wristPoint = new THREE.Vector3();
const metacarpalPoint = new THREE.Vector3();
const newPalm = new THREE.Vector3();
const rawVelocity = new THREE.Vector3();
const palmPoints = PALM_JOINTS.map(() => new THREE.Vector3());
const towardIndex = new THREE.Vector3();
const towardPinky = new THREE.Vector3();

export function makeHandTracker(): HandTracker {
  const hands = [makeHand('left'), makeHand('right')];

  // 관절 자리에 찍는 작은 점들. 손 추적이 실제로 들어오는지 헤드셋에서
  // 바로 보려고 둔다. 손가락 끝 다섯 + 손바닥, 양손.
  const debug = new THREE.Group();
  const dotGeometry = new THREE.SphereGeometry(0.006, 6, 4);
  const tipMaterial = new THREE.MeshBasicMaterial({ color: 0x66ff99 });
  const palmMaterial = new THREE.MeshBasicMaterial({ color: 0xffaa33 });
  const dots = hands.map(() => ({
    tips: FINGER_TIPS.map(() => {
      const dot = new THREE.Mesh(dotGeometry, tipMaterial);
      debug.add(dot);
      return dot;
    }),
    palm: (() => {
      const dot = new THREE.Mesh(dotGeometry, palmMaterial);
      dot.scale.setScalar(2);
      debug.add(dot);
      return dot;
    })(),
  }));

  function readJoint(
    frame: XRFrame,
    referenceSpace: XRReferenceSpace,
    hand: XRHand,
    name: XRHandJoint,
    out: THREE.Vector3,
  ): boolean {
    const space = hand.get(name);
    if (space === undefined || frame.getJointPose === undefined) return false;

    const pose = frame.getJointPose(space, referenceSpace);
    if (pose === undefined || pose === null) return false;

    const p = pose.transform.position;
    out.set(p.x, p.y, p.z);
    return true;
  }

  return {
    hands,
    debug,

    update(frame, referenceSpace, dt) {
      // 직전 프레임에 잡혀 있었는지를 먼저 베껴 둔다.
      //
      // tracked를 바로 false로 밀어 놓고 아래에서 그 값을 보면, '방금 잡히기
      // 시작했다'가 매 프레임 참이 되어 속도가 늘 0으로 리셋된다. 속도를 구하는
      // 코드는 한 번도 돌지 않았다.
      const wasTracked = hands.map((hand) => hand.tracked);
      for (const hand of hands) hand.tracked = false;

      for (const inputSource of frame.session.inputSources) {
        const xrHand = inputSource.hand;
        if (xrHand === undefined) continue;

        const index = hands.findIndex((h) => h.handedness === inputSource.handedness);
        if (index < 0) continue;
        const hand = hands[index];

        // 손바닥: 손목과 중지 중수골의 중점.
        const haveWrist = readJoint(frame, referenceSpace, xrHand, 'wrist', wristPoint);
        const haveMeta = readJoint(
          frame,
          referenceSpace,
          xrHand,
          'middle-finger-metacarpal',
          metacarpalPoint,
        );
        if (!haveWrist || !haveMeta) continue;

        newPalm.addVectors(wristPoint, metacarpalPoint).multiplyScalar(0.5);

        if (!wasTracked[index] && dt > 0) {
          // 막 잡히기 시작했다. 직전 위치가 없으므로 속도는 0에서 시작한다.
          hand.palmVelocity.set(0, 0, 0);
          hand.peakSpeed = 0;
        } else if (dt > 0) {
          rawVelocity.subVectors(newPalm, hand.palm).divideScalar(dt);
          // 관절 포즈는 프레임마다 조금씩 떨린다. 그대로 미분하면 가만히 있어도
          // 속도가 튀어서 '내려쳤다'로 잡힌다. 약간 다듬는다.
          hand.palmVelocity.lerp(rawVelocity, 0.5);
          // 최고 속력은 다듬지 않은 값에서 잡고 천천히 식힌다. 다듬은 값에서
          // 잡으면 정점이 깎여서, 세게 친 것도 약하게 기록된다.
          hand.peakSpeed = Math.max(rawVelocity.length(), hand.peakSpeed - dt * 6);
        }

        hand.palm.copy(newPalm);

        // 손바닥 평면. 세 점이 다 안 잡히면 직전 값을 그대로 둔다.
        const havePalm = PALM_JOINTS.every((name, j) =>
          readJoint(frame, referenceSpace, xrHand, name, palmPoints[j]),
        );
        if (havePalm) {
          towardIndex.subVectors(palmPoints[1], palmPoints[0]);
          towardPinky.subVectors(palmPoints[2], palmPoints[0]);
          hand.palmNormal
            .crossVectors(towardIndex, towardPinky)
            .multiplyScalar(hand.handedness === 'left' ? -1 : 1)
            .normalize();
          // 손가락 쪽. 두 중수골의 중점이 손목에서 뻗은 방향이다. 둘 다
          // 손바닥 평면 위의 벡터라 그 평균도 평면 위에 있다 — 따로 눕힐
          // 필요가 없다.
          hand.palmUp.addVectors(towardIndex, towardPinky).normalize();
        }

        FINGER_TIPS.forEach((name, i) => {
          readJoint(frame, referenceSpace, xrHand, name, hand.tips[i]);
        });

        hand.tracked = true;
      }

      hands.forEach((hand, i) => {
        dots[i].palm.visible = hand.tracked;
        dots[i].palm.position.copy(hand.palm);
        dots[i].tips.forEach((dot, j) => {
          dot.visible = hand.tracked;
          dot.position.copy(hand.tips[j]);
        });
      });
    },
  };
}
