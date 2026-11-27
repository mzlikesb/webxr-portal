import * as THREE from 'three';
import type { TrackedHand } from './hands';

// ---------------------------------------------------------------------------
// 손바닥 디버그 패널
//
// 세션 안에서는 2D DOM이 보이지 않는다. dom-overlay를 요청하지 않으므로 화면에
// 있는 건 three.js가 그리는 것뿐이고, 그래서 헤드셋을 쓴 채로는 지금 뭐가
// 잡혔는지 볼 방법이 없었다. 로그는 세션에서 나온 뒤에야 읽을 수 있다.
//
// 왼손을 뒤집어 손바닥을 보면 그 자리에 패널이 뜬다. 오른손 검지로 누른다.
//
// ── 왜 캔버스인가 ──
//
// 글자를 three.js로 그리려면 폰트 지오메트리나 SDF 아틀라스가 필요하다. 둘 다
// 이 작품이 지고 갈 짐은 아니다. 2D 캔버스에 통째로 그려서 텍스처로 붙이면
// 글자·둥근 모서리·색이 전부 공짜로 따라온다. 바뀔 때만 다시 그린다.
//
// ── 왜 머리를 보지 않고 손에 붙이나 ──
//
// lookAt으로 늘 머리를 향하게 하면 손을 기울여도 패널만 제자리라 손에서 떠
// 보인다. 손바닥 평면에 그대로 붙여 두면 손과 함께 기울고, 어차피 손바닥을
// 들여다볼 때만 보이니 글자는 늘 읽을 만한 각도다.
// ---------------------------------------------------------------------------

/** 패널의 실제 크기(m). 손바닥보다 조금 크다. */
const PANEL_WIDTH = 0.18;
const PANEL_HEIGHT = 0.12;

/** 캔버스 해상도. 패널 비율과 같아야 글자가 안 찌그러진다. */
const CANVAS_WIDTH = 576;
const CANVAS_HEIGHT = 384;

/** 손바닥에서 이만큼 띄운다(m). 손 안에 파묻히지 않게. */
const PALM_LIFT = 0.03;

/**
 * 손바닥이 머리를 이만큼 향해야 띄운다(법선과 시선의 내적).
 *
 * 0.6이면 약 53°. 너무 낮추면 팔을 내리고 걸어 다닐 때도 떠 있고, 너무
 * 높이면 정확히 정면으로 들어야만 떠서 성가시다.
 */
const FACING = 0.6;

/** 손가락 끝이 패널 면에서 이 거리 안이면 닿은 것으로 친다(m). */
const TOUCH_DEPTH = 0.025;

/** 글자 줄. 캔버스 픽셀 기준이다. */
const LINE_TOP = 20;
const LINE_STEP = 44;
const LINE_SIZE = 34;
/** 줄이 칸보다 길면 여기까지 줄인다(px). 그래도 넘치면 잘린다. */
const LINE_MIN_SIZE = 20;

/** 버튼 칸. 캔버스 픽셀 기준이다. */
const BUTTON_TOP = 250;
const BUTTON_HEIGHT = 92;
const BUTTON_GAP = 12;
const SIDE_MARGIN = 16;

export interface DebugButton {
  label: string;
  /** 토글 버튼이면 지금 켜져 있는지. 누르는 버튼이면 생략한다. */
  isOn?: () => boolean;
  press(): void;
}

export interface DebugPanel {
  group: THREE.Group;
  /**
   * 매 프레임. 왼손바닥을 보고 있으면 띄우고, 오른손 검지가 닿으면 누른다.
   *
   * @param viewerPosition 머리 위치(월드)
   */
  update(hands: TrackedHand[], viewerPosition: THREE.Vector3): void;
  /** 버튼 위에 적을 줄들. 매 프레임 바뀌어도 된다 — 달라질 때만 다시 그린다. */
  setLines(lines: string[]): void;
  /**
   * 버튼 가운데가 패널 로컬 어디인지(m).
   *
   * 미리보기에서 버튼을 눌러 보려고 연다. 바깥에서 픽셀을 되짚어 계산하면
   * 패널 크기를 바꿀 때마다 조용히 빗나간다 — 실제로 2px 차이로 빗나갔다.
   */
  buttonPoint(index: number, out: THREE.Vector3): THREE.Vector3;
}

const toViewer = new THREE.Vector3();
const panelRight = new THREE.Vector3();
const panelBasis = new THREE.Matrix4();
const fingerLocal = new THREE.Vector3();

export function makeDebugPanel(buttons: DebugButton[]): DebugPanel {
  const canvas = document.createElement('canvas');
  canvas.width = CANVAS_WIDTH;
  canvas.height = CANVAS_HEIGHT;
  const ctx = canvas.getContext('2d')!;

  const texture = new THREE.CanvasTexture(canvas);
  // 패널은 늘 비스듬히 보인다. 기본 필터로 두면 글자가 뭉개진다.
  texture.anisotropy = 4;
  texture.colorSpace = THREE.SRGBColorSpace;

  const group = new THREE.Group();
  group.visible = false;

  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(PANEL_WIDTH, PANEL_HEIGHT),
    new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      // 반투명 오버레이가 깊이 버퍼를 오염시켜 뒤를 가리지 않게.
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );
  // 포털 마스크(-1)보다 한참 뒤에 그린다. 패널은 늘 맨 위다.
  mesh.renderOrder = 10;
  group.add(mesh);

  let lines: string[] = [];
  /** 마지막으로 그린 내용. 달라질 때만 다시 그린다. */
  let drawn = '';
  /** 지금 손가락이 올라가 있는 버튼. 떼야 다음 누름이 먹는다. */
  let heldIndex = -1;

  /** 버튼 하나가 캔버스의 어느 칸인지. */
  function buttonRect(index: number): { x: number; width: number } {
    const usable = CANVAS_WIDTH - SIDE_MARGIN * 2 - BUTTON_GAP * (buttons.length - 1);
    const width = usable / buttons.length;
    return { x: SIDE_MARGIN + index * (width + BUTTON_GAP), width };
  }

  function roundRect(
    x: number,
    y: number,
    width: number,
    height: number,
    radius: number,
  ): void {
    ctx.beginPath();
    ctx.roundRect(x, y, width, height, radius);
  }

  function redraw(): void {
    ctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

    ctx.fillStyle = 'rgba(12, 14, 18, 0.88)';
    roundRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT, 28);
    ctx.fill();
    ctx.strokeStyle = 'rgba(120, 200, 255, 0.5)';
    ctx.lineWidth = 3;
    ctx.stroke();

    ctx.textBaseline = 'top';
    ctx.fillStyle = '#cfe6ff';
    const textLeft = SIDE_MARGIN + 10;
    const textWidth = CANVAS_WIDTH - textLeft * 2;
    lines.forEach((line, i) => {
      // 스캔된 방은 라벨이 열 가지씩 나온다. 칸에 안 맞으면 글자를 줄인다 —
      // 그냥 두면 오른쪽이 잘려서 마지막 라벨이 뭐였는지 알 수가 없다.
      let size = LINE_SIZE;
      ctx.font = `600 ${size}px system-ui, sans-serif`;
      while (size > LINE_MIN_SIZE && ctx.measureText(line).width > textWidth) {
        size -= 2;
        ctx.font = `600 ${size}px system-ui, sans-serif`;
      }
      ctx.fillText(line, textLeft, LINE_TOP + i * LINE_STEP);
    });

    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    buttons.forEach((button, i) => {
      const { x, width } = buttonRect(i);
      const on = button.isOn?.() ?? false;

      ctx.fillStyle = on ? 'rgba(90, 200, 255, 0.85)' : 'rgba(255, 255, 255, 0.12)';
      roundRect(x, BUTTON_TOP, width, BUTTON_HEIGHT, 18);
      ctx.fill();

      ctx.fillStyle = on ? '#07121c' : '#dceaff';
      ctx.font = '600 34px system-ui, sans-serif';
      ctx.fillText(button.label, x + width / 2, BUTTON_TOP + BUTTON_HEIGHT / 2);
    });
    ctx.textAlign = 'left';

    texture.needsUpdate = true;
  }

  /** 지금 그려야 할 내용을 한 줄로 요약한 것. 이게 같으면 다시 안 그린다. */
  function signature(): string {
    return lines.join('|') + '#' + buttons.map((b) => (b.isOn?.() ?? false)).join(',');
  }

  redraw();

  return {
    group,

    setLines(next) {
      lines = next;
    },

    buttonPoint(index, out) {
      const { x, width } = buttonRect(index);
      const u = x + width / 2;
      const v = BUTTON_TOP + BUTTON_HEIGHT / 2;
      return out.set(
        (u / CANVAS_WIDTH - 0.5) * PANEL_WIDTH,
        (0.5 - v / CANVAS_HEIGHT) * PANEL_HEIGHT,
        0,
      );
    },

    update(hands, viewerPosition) {
      const left = hands.find((hand) => hand.handedness === 'left');
      const right = hands.find((hand) => hand.handedness === 'right');

      // 손바닥이 머리를 향할 때만. 손등을 보고 있으면 내적이 음수다.
      toViewer.subVectors(viewerPosition, left?.palm ?? viewerPosition).normalize();
      const facing = left !== undefined && left.tracked && left.palmNormal.dot(toViewer) > FACING;

      group.visible = facing;
      if (!facing || left === undefined) {
        heldIndex = -1;
        return;
      }

      // 손바닥 평면에 그대로 붙인다. +Z가 손바닥 밖, +Y가 손가락 쪽.
      group.position.copy(left.palm).addScaledVector(left.palmNormal, PALM_LIFT);
      panelRight.crossVectors(left.palmUp, left.palmNormal).normalize();
      panelBasis.makeBasis(panelRight, left.palmUp, left.palmNormal);
      group.quaternion.setFromRotationMatrix(panelBasis);
      group.updateMatrixWorld(true);

      const next = signature();
      if (next !== drawn) {
        drawn = next;
        redraw();
      }

      // ── 오른손 검지로 누르기 ──
      //
      // 패널 로컬로 옮기면 판정이 2D가 된다. z는 면에서 얼마나 떨어졌는지고,
      // x/y가 어느 버튼인지다.
      if (right === undefined || !right.tracked) {
        heldIndex = -1;
        return;
      }

      // tips의 두 번째가 검지 끝이다(hands.ts의 FINGER_TIPS 순서).
      fingerLocal.copy(right.tips[1]);
      group.worldToLocal(fingerLocal);

      let hit = -1;
      if (Math.abs(fingerLocal.z) < TOUCH_DEPTH) {
        // 로컬 미터를 캔버스 픽셀로. y는 위가 +라 뒤집는다.
        const u = (fingerLocal.x / PANEL_WIDTH + 0.5) * CANVAS_WIDTH;
        const v = (0.5 - fingerLocal.y / PANEL_HEIGHT) * CANVAS_HEIGHT;
        if (v >= BUTTON_TOP && v <= BUTTON_TOP + BUTTON_HEIGHT) {
          buttons.forEach((_, i) => {
            const { x, width } = buttonRect(i);
            if (u >= x && u <= x + width) hit = i;
          });
        }
      }

      // 닿아 있는 동안 계속 눌리지 않게, 들어오는 순간에만 한 번.
      if (hit >= 0 && hit !== heldIndex) buttons[hit].press();
      heldIndex = hit;
    },
  };
}
