import { downloadClipartImages } from '../src/clipart.js';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const jobs = [
  { query: '회의실 상담', index: 1, filePath: path.join(__dirname, 'r2-1.jpg') },
  { query: '서류 검토', index: 2, filePath: path.join(__dirname, 'r2-2.jpg') },
  { query: '계약서 검토', index: 3, filePath: path.join(__dirname, 'r2-3.jpg') },
];
await downloadClipartImages({ jobs, log: console.log });
