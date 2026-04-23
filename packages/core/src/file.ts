import type { Buffer } from 'node:buffer'
import writeFile from 'write-file-atomic'

/**
 * fs.promises.writeFile 在内部可能会分多次写入同一个文件句柄
 * 如果第三方工具在写入尚未完成时去读 pages|manifest.json，就可能拿到截断的 JSON，导致解析崩溃
 *
 * 实现原子写文件的函数，确保写入过程不会被中断
 */
export async function atomicWriteFile(
  targetPath: string,
  data: string | Buffer,
  options: BufferEncoding | { encoding?: BufferEncoding } = 'utf-8',
): Promise<void> {
  await writeFile(targetPath, data, options)
}
