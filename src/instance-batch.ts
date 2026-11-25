import * as THREE from 'three';

// ---------------------------------------------------------------------------
// 같은 부품을 한 번에 그리기
//
// 메시 하나는 드로우콜 하나다. 바퀴 한 마리가 메시 쉰 개쯤이고 포털 복사본까지
// 치면 백 개, 네 마리면 사백 개가 넘는다. 헤드셋은 눈마다 따로 제출하므로 두
// 배가 된다. 그런데 서로 다른 '지오메트리 × 재질' 조합은 열몇 개뿐이다 —
// 넓적다리는 길이가 셋, 종아리가 셋, 몸통 덩어리 몇 개, 더듬이 마디 넷.
//
// 그래서 계층은 그대로 두되 메시를 직접 그리지 않는다. 계층은 '행렬을 계산하는
// 장치'로만 쓰고, 매 프레임 각 부품의 matrixWorld를 조합별 InstancedMesh에
// 채워 넣는다. 그러면 바퀴가 몇 마리든 드로우콜은 조합 수로 고정된다.
//
// 이 방식의 대가: 인스턴스마다 따로 컬링되지 않는다(전부 제출된다). 한 방
// 안의 바퀴 몇 마리에는 문제가 되지 않는다.
// ---------------------------------------------------------------------------

interface Member {
  mesh: THREE.Mesh;
  /** 등록될 때의 뿌리. 이게 안 보이면 이 부품도 그리지 않는다. */
  root: THREE.Object3D;
}

interface Pool {
  instanced: THREE.InstancedMesh;
  used: number;
}

export interface InstanceBatch {
  /** 이 노드 아래의 메시들을 배칭 대상으로 넘긴다. 원래 메시는 숨겨진다. */
  register(root: THREE.Object3D): void;
  /** 매 프레임 render 직전. 행렬을 모아 인스턴스에 채운다. */
  sync(): void;
  /** 지금 몇 개의 묶음으로 그려지는지. 드로우콜 수와 같다. */
  poolCount(): number;
}

export function makeInstanceBatch(scene: THREE.Scene): InstanceBatch {
  // render도 행렬을 갱신한다. sync가 render 직전에 이미 돌았으므로 중복이다.
  // 끄고 우리가 책임진다 — three.js가 이 경우를 위해 열어 둔 스위치다.
  scene.matrixWorldAutoUpdate = false;

  const group = new THREE.Group();
  // 인스턴스 행렬은 월드 행렬 그대로다. 이 그룹이 움직이면 전부 어긋난다.
  group.matrixAutoUpdate = false;
  scene.add(group);

  const members: Member[] = [];
  const pools = new Map<string, Pool>();

  function makeInstanced(mesh: THREE.Mesh, capacity: number): THREE.InstancedMesh {
    const material = mesh.material as THREE.Material;
    const instanced = new THREE.InstancedMesh(mesh.geometry, material, capacity);
    instanced.count = 0;
    // 인스턴스를 한 덩어리로 보는 바운딩이 없으므로 컬링을 끈다.
    instanced.frustumCulled = false;
    instanced.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // 포털 안쪽 복사본은 마스크보다 나중에 그려야 한다. 조합이 같으면
    // renderOrder도 같으므로 아무 멤버에서 가져와도 된다.
    instanced.renderOrder = mesh.renderOrder;
    group.add(instanced);
    return instanced;
  }

  function grow(pool: Pool, mesh: THREE.Mesh): void {
    // count는 지금 그리는 개수고 용량은 instanceMatrix.count다. 헷갈리면
    // 늘려도 용량이 그대로라 매 프레임 다시 늘리게 된다.
    const bigger = makeInstanced(mesh, pool.instanced.instanceMatrix.count * 2);
    bigger.instanceMatrix.array.set(pool.instanced.instanceMatrix.array);
    group.remove(pool.instanced);
    pool.instanced.dispose();
    pool.instanced = bigger;
  }

  function visibleUpTo(node: THREE.Object3D, root: THREE.Object3D): boolean {
    let current: THREE.Object3D | null = node;
    while (current !== null) {
      if (!current.visible) return false;
      if (current === root) return true;
      current = current.parent;
    }
    return true;
  }

  return {
    register(root) {
      root.traverse((node) => {
        const mesh = node as THREE.Mesh;
        if (mesh.isMesh !== true || Array.isArray(mesh.material)) return;
        members.push({ mesh, root });
      });

      // 원래 메시는 숨긴다. 모양은 인스턴스가 그리고, 이 메시들은 이제
      // 자세를 담아 두는 그릇일 뿐이다. 숨겨도 행렬은 계속 계산된다.
      for (const member of members) member.mesh.visible = false;
    },

    sync() {
      // 숨긴 메시의 행렬도 갱신되어야 한다. render가 해 주지만 그건 이 다음이고,
      // 우리는 지금 당장 필요하다.
      //
      // 그래서 scene.matrixWorldAutoUpdate를 꺼 두고(아래 참조) 여기서 한 번만
      // 돈다. 안 그러면 한 프레임에 계층 전체를 두 번 훑게 된다 — 바퀴가
      // 늘어날수록 그대로 두 배가 되는 비용이다.
      scene.updateMatrixWorld();

      for (const pool of pools.values()) pool.used = 0;

      for (const { mesh, root } of members) {
        if (!root.visible) continue;
        // 메시 자신은 숨겨 두었으므로 그 위만 본다.
        if (mesh.parent !== null && !visibleUpTo(mesh.parent, root)) continue;

        const material = mesh.material as THREE.Material;
        const key = `${mesh.geometry.uuid}|${material.uuid}`;

        let pool = pools.get(key);
        if (pool === undefined) {
          pool = { instanced: makeInstanced(mesh, 8), used: 0 };
          pools.set(key, pool);
        }
        if (pool.used >= pool.instanced.instanceMatrix.count) grow(pool, mesh);

        pool.instanced.instanceMatrix.array.set(mesh.matrixWorld.elements, pool.used * 16);
        pool.used += 1;
      }

      for (const pool of pools.values()) {
        pool.instanced.count = pool.used;
        if (pool.used > 0) pool.instanced.instanceMatrix.needsUpdate = true;
      }
    },

    poolCount() {
      return pools.size;
    },
  };
}
