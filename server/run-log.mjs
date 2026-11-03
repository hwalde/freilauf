// Freilauf — reading a run's raw terminal recording (`log.txt`).
//
// bin/fl-log-cap keeps that file small: at its high-water mark, the newest bytes
// replace it, and the new file opens with a header line counting what is gone.
// `runs.log_offset` stays what it always was, a position in everything the run
// ever printed, so this module is the one place that translates such a position
// into a position in the file. The count and the bytes come from one open file
// descriptor: a rotation during the read leaves the old file readable and whole.
//
// A file without a header (a small log, a run from before the cap, a session that
// still has its old `cat`) has dropped nothing and reads exactly as before.
import { openSync, readSync, fstatSync, closeSync } from 'node:fs'

const HEADER = /^\x1b_freilauf-log-dropped=(\d+)\x1b\\\n/
const HEADER_ROOM = 64

function withFile(path, fn) {
  const fd = openSync(path, 'r')
  try {
    const size = fstatSync(fd).size
    const buf = Buffer.alloc(Math.min(HEADER_ROOM, size))
    readSync(fd, buf, 0, buf.length, 0)
    const m = HEADER.exec(buf.toString('latin1'))
    return fn(fd, size, m ? Number(m[1]) : 0, m ? m[0].length : 0)
  } finally { closeSync(fd) }
}

function readRange(fd, from, to) {
  const buf = Buffer.alloc(Math.max(0, to - from))
  const n = buf.length ? readSync(fd, buf, 0, buf.length, from) : 0
  return buf.subarray(0, n)
}

/**
 * The bytes past `offset`, at most `maxBytes` and always the newest ones.
 * Returns `{ text, size, skipped, from }`: `size` and `from` are positions in
 * everything ever written, `skipped` counts what cannot be read any more.
 * Throws when the file cannot be read.
 *
 * A position past the end means the file was recreated (a retry, a log deleted
 * by hand), so reading starts over.
 */
export function readLogFrom(path, offset, maxBytes = 2_000_000) {
  return withFile(path, (fd, fileSize, dropped, headerLen) => {
    const size = dropped + fileSize - headerLen
    let pos = offset > size ? 0 : offset
    if (pos === size) return { text: '', size, skipped: 0, from: pos }
    const wanted = Math.max(pos, dropped, size - maxBytes)
    const skipped = wanted - pos
    let buf = readRange(fd, wanted - dropped + headerLen, fileSize)
    pos = wanted
    // A cut can land inside a UTF-8 character. The scanner derives the next
    // offset from the decoded length, so a replacement character would push it
    // past the real position, and past the end it reads as "file recreated".
    if (skipped) {
      let skip = 0
      while (skip < buf.length && (buf[skip] & 0xc0) === 0x80) skip++
      buf = buf.subarray(skip)
      pos += skip
    }
    return { text: buf.toString('utf8'), size, skipped, from: pos }
  })
}

/** The last `maxBytes` of the recording as text, without the header. Throws when unreadable. */
export function readLogTail(path, maxBytes) {
  return withFile(path, (fd, fileSize, _dropped, headerLen) =>
    readRange(fd, Math.max(headerLen, fileSize - maxBytes), fileSize).toString('utf8'))
}
