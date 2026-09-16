// 이미지 관련성 필터 테스트 — 무관한 사진이 걸러지는지 확인
import { downloadClipartImages } from '../src/clipart.js';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const jobs = [
  { query: '병원 상담', index: 1, filePath: path.join(__dirname, 'rel-1.jpg') },
  { query: '유튜브 촬영', index: 2, filePath: path.join(__dirname, 'rel-2.jpg') },
  { query: '노트북 분석', index: 3, filePath: path.join(__dirname, 'rel-3.jpg') },
];
await downloadClipartImages({ jobs, log: console.log });
