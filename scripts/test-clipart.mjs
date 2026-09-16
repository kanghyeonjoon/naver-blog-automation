// 클립아트코리아 다운로드 흐름 단독 테스트
import { downloadClipartImages } from '../src/clipart.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const log = (msg) => console.log(msg);

const done = await downloadClipartImages({
  jobs: [
    { query: '병원 상담', index: 1, filePath: path.join(__dirname, 'ck-test-1.jpg') },
    { query: '의사 진료', index: 2, filePath: path.join(__dirname, 'ck-test-2.jpg') },
  ],
  log,
});
console.log('DONE:', done.length, '/ 2');
