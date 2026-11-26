import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkSegment,
  parseVirtualPath,
  normalizeVirtualPath,
  parentOf,
  basenameOf,
  normalizeNewName,
  joinVirtual,
  isAncestorOrSelf,
  PathError,
} from '../src/index.js';

const code = (fn) => {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof PathError, `expected PathError, got ${e}`);
    return e.code;
  }
  assert.fail('expected throw');
};

test('valid paths', () => {
  assert.deepEqual(parseVirtualPath('/'), []);
  assert.deepEqual(parseVirtualPath('/a'), ['a']);
  assert.deepEqual(parseVirtualPath('/사진/2024/a b.jpg'), ['사진', '2024', 'a b.jpg']);
  assert.deepEqual(parseVirtualPath('/a/b/'), ['a', 'b']);
  assert.deepEqual(parseVirtualPath('/.hidden/..foo/a..b'), ['.hidden', '..foo', 'a..b']);
  assert.deepEqual(parseVirtualPath('/ leading space'), [' leading space']);
  assert.deepEqual(parseVirtualPath('/console.txt/nullable/COM10'), ['console.txt', 'nullable', 'COM10']);
  assert.equal(normalizeVirtualPath('/a/b/'), '/a/b');
});

test('traversal and absolute forms are rejected', () => {
  assert.equal(code(() => parseVirtualPath('/..')), 'DOT_SEGMENT');
  assert.equal(code(() => parseVirtualPath('/a/../../etc')), 'DOT_SEGMENT');
  assert.equal(code(() => parseVirtualPath('/a/./b')), 'DOT_SEGMENT');
  assert.equal(code(() => parseVirtualPath('a/b')), 'NOT_ABSOLUTE');
  assert.equal(code(() => parseVirtualPath('')), 'NOT_ABSOLUTE');
  assert.equal(code(() => parseVirtualPath('C:\\Windows')), 'NOT_ABSOLUTE');
  assert.equal(code(() => parseVirtualPath('/C:/Windows')), 'INVALID_CHAR');
  assert.equal(code(() => parseVirtualPath('/C:')), 'INVALID_CHAR');
  assert.equal(code(() => parseVirtualPath('/..\\..\\Windows')), 'INVALID_CHAR');
  assert.equal(code(() => parseVirtualPath('/a\\b')), 'INVALID_CHAR');
  assert.equal(code(() => parseVirtualPath('//server/share')), 'EMPTY_SEGMENT');
  assert.equal(code(() => parseVirtualPath('/a//b')), 'EMPTY_SEGMENT');
  assert.equal(code(() => parseVirtualPath('/a/b//')), 'EMPTY_SEGMENT');
  assert.equal(code(() => parseVirtualPath(null)), 'NOT_A_STRING');
  assert.equal(code(() => parseVirtualPath(['/a'])), 'NOT_A_STRING');
});

test('windows-hostile names are rejected', () => {
  for (const name of ['CON', 'con', 'Nul', 'nul.txt', 'NUL.tar.gz', 'com1', 'LPT9.log', 'COM¹', 'conin$', 'CON .txt', 'aux']) {
    assert.equal(checkSegment(name), 'RESERVED_NAME', name);
  }
  assert.equal(checkSegment('a.'), 'TRAILING_DOT_OR_SPACE');
  assert.equal(checkSegment('a '), 'TRAILING_DOT_OR_SPACE');
  assert.equal(checkSegment('...'), 'TRAILING_DOT_OR_SPACE');
  assert.equal(checkSegment('file.txt:stream'), 'INVALID_CHAR'); // NTFS ADS
  for (const ch of ['<', '>', '"', '|', '?', '*', '\0', '\n', '\x1f', '\x7f']) {
    assert.equal(checkSegment(`a${ch}b`), 'INVALID_CHAR', JSON.stringify(ch));
  }
  assert.equal(checkSegment('a\uD800b'), 'INVALID_UNICODE');
  assert.equal(checkSegment('\uDC00'), 'INVALID_UNICODE');
  assert.equal(checkSegment('😀'), null);
});

test('length limits', () => {
  assert.equal(checkSegment('a'.repeat(255)), null);
  assert.equal(checkSegment('a'.repeat(256)), 'NAME_TOO_LONG');
  assert.equal(checkSegment('가'.repeat(85)), null); // 255 bytes
  assert.equal(checkSegment('가'.repeat(86)), 'NAME_TOO_LONG'); // 258 bytes > ext4
  assert.equal(code(() => parseVirtualPath('/' + 'a/'.repeat(64) + 'b')), 'PATH_TOO_DEEP');
  assert.equal(code(() => parseVirtualPath('/' + 'a'.repeat(1024))), 'PATH_TOO_LONG');
});

test('parent / basename', () => {
  assert.equal(parentOf('/'), null);
  assert.equal(parentOf('/a'), '/');
  assert.equal(parentOf('/a/b/'), '/a');
  assert.equal(basenameOf('/'), '');
  assert.equal(basenameOf('/a/b.txt'), 'b.txt');
});

test('new names are NFC-normalized', () => {
  const nfd = '한글.txt'.normalize('NFD');
  assert.notEqual(nfd, '한글.txt');
  assert.equal(normalizeNewName(nfd), '한글.txt');
  assert.equal(joinVirtual('/문서', nfd), '/문서/한글.txt');
  assert.equal(joinVirtual('/', 'a'), '/a');
  assert.equal(code(() => joinVirtual('/a', '..')), 'DOT_SEGMENT');
  assert.equal(code(() => joinVirtual('/a', 'b/c')), 'INVALID_CHAR');
});

test('isAncestorOrSelf', () => {
  assert.equal(isAncestorOrSelf('/', '/a'), true);
  assert.equal(isAncestorOrSelf('/a', '/a'), true);
  assert.equal(isAncestorOrSelf('/a', '/a/b'), true);
  assert.equal(isAncestorOrSelf('/A', '/a/b'), true);
  assert.equal(isAncestorOrSelf('/A', '/a/b', { caseInsensitive: false }), false);
  assert.equal(isAncestorOrSelf('/a', '/ab'), false);
  assert.equal(isAncestorOrSelf('/a/b', '/a'), false);
});
