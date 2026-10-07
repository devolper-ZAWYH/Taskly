import { AVATAR_SIZE, type AvatarType } from "@/lib/types"

/**
 * Center-crop an image file to a square and shrink it (default 256px), so a
 * multi-megabyte phone photo uploads as a few dozen KB. WebP where the
 * browser can encode it, JPEG otherwise.
 */
export async function resizeToSquare(
  file: File,
  size = AVATAR_SIZE,
): Promise<{ contentType: AvatarType; data: string }> {
  const bitmap = await createImageBitmap(file)
  const side = Math.min(bitmap.width, bitmap.height)
  const canvas = document.createElement("canvas")
  canvas.width = size
  canvas.height = size
  const context = canvas.getContext("2d")
  if (!context) throw new Error("Canvas unavailable")
  context.imageSmoothingQuality = "high"
  context.drawImage(
    bitmap,
    (bitmap.width - side) / 2,
    (bitmap.height - side) / 2,
    side,
    side,
    0,
    0,
    size,
    size,
  )
  bitmap.close()

  const encode = (type: string) =>
    new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, 0.85))
  let blob = await encode("image/webp")
  if (!blob || blob.type !== "image/webp") blob = await encode("image/jpeg")
  if (!blob) throw new Error("Could not encode image")

  const buffer = new Uint8Array(await blob.arrayBuffer())
  let binary = ""
  for (const byte of buffer) binary += String.fromCharCode(byte)
  return { contentType: blob.type as AvatarType, data: btoa(binary) }
}
