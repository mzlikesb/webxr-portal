import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    // 0.0.0.0으로 listen. adb reverse 경로에는 필요 없지만,
    // 맥의 LAN IP로 직접 붙어 보는 디버깅을 열어 둔다.
    host: true,
    // adb reverse는 포트 번호를 고정으로 매핑하므로, 포트가 밀려서
    // 5174로 뜨면 헤드셋에서 조용히 연결이 안 된다. 그래서 strictPort.
    port: 5173,
    strictPort: true,
  },
});
