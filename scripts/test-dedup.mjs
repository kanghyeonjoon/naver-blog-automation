// 같은 검색어로 2회 다운로드 → 서로 다른 이미지가 나오는지 확인
import { downloadClipartImages } from '../src/clipart.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const log = (m) => console.log(m);
const q = '병원 상담';
for (const round of [1, 2]) {
  const fp = path.join(__dirname, `dedup-${round}.jpg`);
  if (fs.existsSync(fp)) fs.unlinkSync(fp);
  await downloadClipartImages({ jobs: [{ query: q, index: 1, filePath: fp }], log });
  console.log(`round${round} size:`, fs.existsSync(fp) ? fs.statSync(fp).size : 'none');
}
