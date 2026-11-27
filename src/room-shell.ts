import * as THREE from 'three';
import { makeWalkSurface, type WalkSurface } from './walk-surface';

// ---------------------------------------------------------------------------
// 감지된 평면을 걸을 수 있는 면으로
//
// 포털이 만드는 면들(복도 바닥, 벽면, 방 바닥)은 우리가 좌표를 직접 계산해서
// 세운 것이다. 방 껍데기는 그럴 필요가 없다 — 런타임이 이미 자세를 알려 준다.
//
// ── 평면의 좌표계를 그대로 쓴다 ──
//
// XRPlane의 polygon은 그 평면의 로컬 좌표계에 있고, 그 좌표계는 표면이 X-Z에
// 눕도록 잡혀 있다(모든 점의 y가 0). 즉 법선은 언제나 로컬 +Y다. 벽도
// 예외가 아니라, 좌표계 통째로 세워져 있을 뿐이다.
//
// 그런데 WalkSurface의 규약도 똑같이 '로컬 XZ가 바닥, +Y가 바깥 법선'이다.
// 그래서 orientSurface로 기저를 새로 만들 필요가 없다. 평면의 자세를 받는
// 노드를 하나 두고 그 자식으로 면을 달면, 자세가 공짜로 따라온다.
//
// ── +Y가 방 안쪽인지는 보장되지 않는다 ──
//
// 스펙은 법선이 로컬 +Y라고만 하고, 그게 방 안을 보는지 벽 속을 보는지는
// 말하지 않는다. 바닥에서 뒤집히면 바퀴가 바닥 아래에 매달리고, 벽에서
// 뒤집히면 벽 속을 걷는다.
//
// 방 안의 한 점을 기준으로 판정한다. 법선이 그 점을 등지고 있으면 로컬
// X축으로 180° 돌린다. 그러면 바닥은 위, 천장은 아래, 벽은 안쪽을 보게 되고,
// 라벨을 보지 않아도 셋이 한 규칙으로 풀린다.
//
// 그 기준점으로 처음에는 사람 머리를 썼다. 사람은 늘 방 안에 있으니까 —
// 그런데 그렇지가 않다. 미리보기 카메라를 방 밖에 세워 두자마자 가까운 벽의
// 판정이 뒤집혔고, 실제로도 문간에 서 있거나 벽에 몸을 붙이면(법선과
// 직각이라 내적이 0 근처다) 같은 일이 난다.
//
// 그래서 면들의 중심을 평균한 점을 쓴다. 상자 모양 방이면 여섯 면 중심의
// 평균이 정확히 방 중심이고, 사람이 어디 서 있든 상관없다. 평면은 몇 프레임에
// 걸쳐 하나씩 들어오므로, 새 면이 생길 때마다 전부 다시 판정한다 — 면이 하나뿐일
// 때는 평균이 자기 자신이어서 판정이 안 되니, 그때만 머리 위치로 물러난다.
//
// ── 평면 메시에 매달지 않는다 ──
//
// 디버그로 띄우는 반투명 평면 메시가 이미 같은 자세를 들고 있어서 거기에
// 자식으로 달면 노드를 아낄 수 있다. 하지만 그 메시는 포털을 확정하면
// visible = false가 되고, three.js의 visible은 자식까지 함께 끈다 — 그 면
// 위의 바퀴가 통째로 사라진다. 자세를 받는 노드를 따로 둔다.
// ---------------------------------------------------------------------------

/** 걸을 수 있는 방 껍데기로 볼 라벨. 가구 상판은 옆면이 없어서 뺀다. */
const SHELL_LABELS = new Set(['wall', 'floor', 'ceiling']);

/** 이보다 좁은 평면은 걸을 가치가 없다(m). 문틀 조각 같은 것들. */
const MIN_EXTENT = 0.4;

/**
 * 활동 범위를 평면 끝에서 이만큼 안으로 당긴다(m).
 *
 * 바퀴는 몸길이가 4cm다. 끝까지 허용하면 몸의 절반이 옆 평면 속에 박힌 채로
 * 보인다. 다만 너무 당기면 평면끼리 만나는 모서리에 닿지 못해 넘어갈 수가
 * 없으니, 몸 반쪽만큼만 둔다.
 */
const EDGE_MARGIN = 0.02;

export interface ShellSurface {
  plane: XRPlane;
  label: string;
  /** 평면의 자세를 그대로 받는 노드. 면 노드의 부모다. */
  pose: THREE.Group;
  surface: WalkSurface;
  /** 바운딩 사각형의 크기(m). 로그와 격자에 쓴다. */
  width: number;
  depth: number;
  /** 법선이 방 안쪽을 보도록 뒤집었는지. 한 번 정하면 유지한다. */
  flipped: boolean;
}

export interface RoomShell {
  /** 지금 살아 있는 면들. 평면이 사라지면 여기서도 빠진다. */
  surfaces: ShellSurface[];
  /**
   * 매 프레임. 새 평면에는 면을 만들고, 사라진 평면의 면은 치우고,
   * 남은 면들의 자세를 갱신한다.
   *
   * @param insidePoint 방 안의 한 점(월드). 법선 방향을 판정하는 기준.
   * @returns 이번 프레임에 새로 생긴 면들. 로그와 모서리 연결에 쓴다.
   */
  sync(
    frame: XRFrame,
    referenceSpace: XRReferenceSpace,
    insidePoint: THREE.Vector3,
  ): ShellSurface[];
}

const planeMatrix = new THREE.Matrix4();
const planeNormal = new THREE.Vector3();
const faceCenter = new THREE.Vector3();
const insideEstimate = new THREE.Vector3();
const towardInside = new THREE.Vector3();

/** 폴리곤을 감싸는 사각형. 평면의 로컬 XZ 기준이다. */
function boundingRect(plane: XRPlane): {
  centerX: number;
  centerZ: number;
  halfX: number;
  halfZ: number;
} {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;

  for (const point of plane.polygon) {
    minX = Math.min(minX, point.x);
    maxX = Math.max(maxX, point.x);
    minZ = Math.min(minZ, point.z);
    maxZ = Math.max(maxZ, point.z);
  }

  return {
    centerX: (minX + maxX) / 2,
    centerZ: (minZ + maxZ) / 2,
    halfX: (maxX - minX) / 2,
    halfZ: (maxZ - minZ) / 2,
  };
}

/** 라벨이 없는 기기를 위한 폴백. 벽/바닥/천장의 구분까지는 못 한다. */
function labelOf(plane: XRPlane): string {
  if (plane.semanticLabel !== undefined) return plane.semanticLabel;
  return plane.orientation === 'vertical' ? 'wall' : 'floor';
}

export function makeRoomShell(parent: THREE.Object3D): RoomShell {
  const byPlane = new Map<XRPlane, ShellSurface>();
  /** 평면의 모양이 언제 갱신됐는지. Quest는 스캔하면서 폴리곤을 다듬는다. */
  const shapeTimes = new Map<XRPlane, DOMHighResTimeStamp>();

  /** 사각형을 면의 자세와 범위에 반영한다. 모양이 다듬어지면 다시 부른다. */
  function applyRect(shell: ShellSurface): void {
    const rect = boundingRect(shell.plane);

    // 면의 원점을 사각형의 중심에 둔다. WalkSurface의 범위는 x에 대해
    // 대칭(±halfX)이라, 원점이 중심에 있지 않으면 표현할 수가 없다.
    // 위치는 부모(자세 노드)의 좌표계라 뒤집기와 무관하다.
    shell.surface.node.position.set(rect.centerX, 0, rect.centerZ);

    shell.surface.boundHalfX = Math.max(0, rect.halfX - EDGE_MARGIN);
    shell.surface.boundCenterZ = 0;
    shell.surface.boundHalfZ = Math.max(0, rect.halfZ - EDGE_MARGIN);

    shell.width = rect.halfX * 2;
    shell.depth = rect.halfZ * 2;
  }

  /** 면 중심(월드). 노드의 회전과 무관하므로 행렬을 거치지 않고 직접 구한다. */
  function centerOf(shell: ShellSurface, out: THREE.Vector3): THREE.Vector3 {
    return out
      .copy(shell.surface.node.position)
      .applyQuaternion(shell.pose.quaternion)
      .add(shell.pose.position);
  }

  /**
   * 법선이 방 안쪽을 보도록 전부 다시 판정한다. 면이 새로 생기거나 모양이
   * 다듬어질 때 부른다 — 기준점이 면들의 평균이라 면이 늘면 기준점도 움직인다.
   *
   * 판정이 바뀌면 그 면에 서 있던 바퀴도 함께 뒤집힌다. 평면은 세션 초반 몇
   * 초 안에 다 들어오고 모서리로 이어 붙이기 전이라, 실제로 그럴 일은 없다.
   */
  function decideFlips(fallbackInside: THREE.Vector3): void {
    const shells = [...byPlane.values()];
    if (shells.length === 0) return;

    if (shells.length < 2) {
      insideEstimate.copy(fallbackInside);
    } else {
      insideEstimate.set(0, 0, 0);
      for (const shell of shells) insideEstimate.add(centerOf(shell, faceCenter));
      insideEstimate.divideScalar(shells.length);
    }

    for (const shell of shells) {
      planeNormal.set(0, 1, 0).applyQuaternion(shell.pose.quaternion);
      towardInside.subVectors(insideEstimate, centerOf(shell, faceCenter));

      const flip = planeNormal.dot(towardInside) < 0;
      // 로컬 X축으로 180°. +Y와 +Z가 뒤집히고 오른손 좌표계는 유지된다.
      shell.surface.node.rotation.set(flip ? Math.PI : 0, 0, 0);
      shell.flipped = flip;
    }
  }

  function dispose(plane: XRPlane): void {
    const shell = byPlane.get(plane);
    if (shell === undefined) return;

    shell.pose.removeFromParent();
    byPlane.delete(plane);
    shapeTimes.delete(plane);
  }

  return {
    surfaces: [],

    sync(frame, referenceSpace, insidePoint) {
      const detectedPlanes = frame.detectedPlanes;
      if (detectedPlanes === undefined) return [];

      for (const plane of [...byPlane.keys()]) {
        if (!detectedPlanes.has(plane)) dispose(plane);
      }

      const added: ShellSurface[] = [];
      /** 면이 생겼거나 모양이 바뀌었는지. 그러면 법선을 다시 판정해야 한다. */
      let reshaped = false;

      for (const plane of detectedPlanes) {
        const label = labelOf(plane);
        if (!SHELL_LABELS.has(label)) continue;

        const pose = frame.getPose(plane.planeSpace, referenceSpace);
        // 추적을 놓친 프레임. 자세를 모르면 세울 수도, 갱신할 수도 없다.
        if (pose === undefined || pose === null) continue;

        let shell = byPlane.get(plane);

        if (shell === undefined) {
          const rect = boundingRect(plane);
          if (rect.halfX * 2 < MIN_EXTENT || rect.halfZ * 2 < MIN_EXTENT) continue;

          const poseNode = new THREE.Group();
          parent.add(poseNode);

          shell = {
            plane,
            label,
            pose: poseNode,
            surface: makeWalkSurface(poseNode),
            width: 0,
            depth: 0,
            flipped: false,
          };

          // 방 껍데기는 '머물며 살피는' 면이다. 지나가는 길이 아니라,
          // 여기서 가장자리를 따라 돌아다닌다.
          shell.surface.hugEdges = true;
          shell.surface.drift = null;

          byPlane.set(plane, shell);
          shapeTimes.set(plane, plane.lastChangedTime);
          applyRect(shell);
          added.push(shell);
          reshaped = true;
        } else if (shapeTimes.get(plane) !== plane.lastChangedTime) {
          shapeTimes.set(plane, plane.lastChangedTime);
          applyRect(shell);
          reshaped = true;
        }

        planeMatrix.fromArray(pose.transform.matrix);
        shell.pose.position.setFromMatrixPosition(planeMatrix);
        shell.pose.quaternion.setFromRotationMatrix(planeMatrix);

        // scene.matrixWorldAutoUpdate가 꺼져 있어서 직접 갱신한다. 바퀴를
        // 올려놓거나 모서리를 넘길 때 matrixWorld를 읽는데, 그게 렌더보다
        // 먼저 돌기 때문이다.
        shell.pose.updateMatrixWorld(true);
      }

      if (reshaped) decideFlips(insidePoint);

      this.surfaces = [...byPlane.values()];
      return added;
    },
  };
}
