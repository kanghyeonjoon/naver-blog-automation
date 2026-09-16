// 클립아트코리아 로그인 세션 재저장 (사용자가 직접 로그인)
import { saveClipartLoginSession } from '../src/clipart.js';
await saveClipartLoginSession((m) => console.log(m));
