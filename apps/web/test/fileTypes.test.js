import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extOf, kindOf, kindLabel, canPreview, formatSize, formatDate, sortEntries } from '../src/browser/fileTypes.js';

const f = (name, extra = {}) => ({ name, type: 'file', size: 1, mtimeMs: 0, ...extra });
const d = (name, extra = {}) => ({ name, type: 'dir', size: null, mtimeMs: 0, ...extra });

test('extOf / kindOf / kindLabel', () => {
  assert.equal(extOf('a.tar.gz'), 'gz');
  assert.equal(extOf('.gitignore'), 'gitignore');
  assert.equal(extOf('Makefile'), '');
  assert.equal(extOf('trailing.'), '');
  assert.equal(kindOf(f('사진.JPG')), 'image');
  assert.equal(kindOf(f('그림.svg')), 'text'); // svg 는 텍스트로 미리보기
  assert.equal(kindOf(d('folder.png')), 'other');
  assert.equal(kindLabel(f('보고서.pdf')), 'PDF 문서');
  assert.equal(kindLabel(f('a.mp4')), '동영상 (MP4)');
  assert.equal(kindLabel(f('a.xyz')), 'XYZ 파일');
  assert.equal(kindLabel(d('x')), '폴더');
  assert.equal(kindLabel({ name: 'l', type: 'other', link: true }), '링크 (열 수 없음)');
  assert.equal(canPreview(f('a.md')), true);
  assert.equal(canPreview(f('a.zip')), false);
});

test('formatSize uses decimal units like Finder', () => {
  assert.equal(formatSize(null), '--');
  assert.equal(formatSize(999), '999 바이트');
  assert.equal(formatSize(1000), '1 KB');
  assert.equal(formatSize(1_234_567), '1.2 MB');
  assert.equal(formatSize(123_456_789), '123 MB');
  assert.equal(formatSize(5e12), '5 TB');
});

test('formatDate relative days', () => {
  const now = new Date(2026, 10, 26, 15, 0).getTime();
  assert.match(formatDate(new Date(2026, 10, 26, 9, 5).getTime(), now), /^오늘 /);
  assert.match(formatDate(new Date(2026, 10, 25, 23, 59).getTime(), now), /^어제 /);
  assert.match(formatDate(new Date(2024, 2, 5, 12, 0).getTime(), now), /^2024년 3월 5일 /);
  assert.equal(formatDate(null), '--');
});

test('sortEntries: natural Korean order, folders last by size', () => {
  const list = [f('파일10.txt'), f('파일2.txt'), d('가나다'), f('Apple.txt', { size: 5 })];
  assert.deepEqual(
    sortEntries(list, { key: 'name', dir: 1 }).map((e) => e.name),
    ['가나다', '파일2.txt', '파일10.txt', 'Apple.txt'],
  );
  assert.deepEqual(
    sortEntries(list, { key: 'name', dir: -1 }).map((e) => e.name),
    ['Apple.txt', '파일10.txt', '파일2.txt', '가나다'],
  );
  assert.equal(sortEntries(list, { key: 'size', dir: 1 })[0].name, '가나다'); // 크기 없음 = -1
  assert.equal(sortEntries(list, { key: 'size', dir: -1 })[0].name, 'Apple.txt');
});
