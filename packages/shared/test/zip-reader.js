// 테스트 전용 zip 해석기 (shared·agent·gateway 테스트에서 같이 쓴다)
import assert from 'node:assert/strict';
import zlib from 'node:zlib';

export /** 테스트용 zip 해석기: 중앙 디렉터리 → 로컬 헤더 → 압축 해제 → CRC·디스크립터 대조 */
function readZip(buf) {
  const eocd = buf.length - 22;
  assert.equal(buf.readUInt32LE(eocd), 0x06054b50, 'EOCD signature');
  let count = buf.readUInt16LE(eocd + 10);
  let cdSize = buf.readUInt32LE(eocd + 12);
  let cdStart = buf.readUInt32LE(eocd + 16);
  let zip64 = false;
  if (buf.readUInt32LE(eocd - 20) === 0x07064b50) {
    zip64 = true;
    const recAt = Number(buf.readBigUInt64LE(eocd - 20 + 8));
    assert.equal(buf.readUInt32LE(recAt), 0x06064b50, 'ZIP64 EOCD signature');
    count = Number(buf.readBigUInt64LE(recAt + 32));
    cdSize = Number(buf.readBigUInt64LE(recAt + 40));
    cdStart = Number(buf.readBigUInt64LE(recAt + 48));
    assert.equal(recAt, cdStart + cdSize);
  } else {
    assert.equal(cdStart + cdSize, eocd);
  }

  const out = [];
  let p = cdStart;
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50, 'central signature');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    let csize = buf.readUInt32LE(p + 20);
    let usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const attrs = buf.readUInt32LE(p + 38);
    let offset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    const extra = buf.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);
    if (extra.length) {
      assert.equal(extra.readUInt16LE(0), 0x0001);
      let q = 4;
      if (usize === 0xffffffff) (usize = Number(extra.readBigUInt64LE(q))), (q += 8);
      if (csize === 0xffffffff) (csize = Number(extra.readBigUInt64LE(q))), (q += 8);
      if (offset === 0xffffffff) (offset = Number(extra.readBigUInt64LE(q))), (q += 8);
    }
    assert.ok(flags & 0x0800, 'UTF-8 flag');
    p += 46 + nameLen + extraLen + commentLen;

    assert.equal(buf.readUInt32LE(offset), 0x04034b50, `local signature for ${name}`);
    const lNameLen = buf.readUInt16LE(offset + 26);
    const lExtraLen = buf.readUInt16LE(offset + 28);
    assert.equal(buf.subarray(offset + 30, offset + 30 + lNameLen).toString('utf8'), name);
    const dataAt = offset + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataAt, dataAt + csize);
    const data = method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw);
    assert.equal(data.length, usize, `size of ${name}`);
    assert.equal(zlib.crc32(data) >>> 0, crc, `crc of ${name}`);

    if (flags & 0x0008) {
      const d = dataAt + csize;
      assert.equal(buf.readUInt32LE(d), 0x08074b50, 'descriptor signature');
      assert.equal(buf.readUInt32LE(d + 4), crc);
      const local64 = lExtraLen > 0;
      const dc = local64 ? Number(buf.readBigUInt64LE(d + 8)) : buf.readUInt32LE(d + 8);
      const du = local64 ? Number(buf.readBigUInt64LE(d + 16)) : buf.readUInt32LE(d + 12);
      assert.deepEqual([dc, du], [csize, usize]);
    }
    out.push({ name, method, dir: Boolean(attrs & 0x10), data });
  }
  return { zip64, entries: out };
}
