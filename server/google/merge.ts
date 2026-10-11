/**
 * Three-way merge of the fields a Taskly item and its Google copy share.
 * `base` is what both sides agreed on at the last sync. A field changed on one
 * side wins; a field changed differently on both sides goes to the newer side.
 * Pure, so `node --test` can run it directly.
 */

type Fields = Record<string, string | boolean>

export type MergeResult<T extends Fields> = {
  /** The agreed values after this sync (the next base). */
  value: T
  /** Changes Taskly needs to match `value`. */
  toLocal: Partial<T>
  /** Changes the Google copy needs to match `value`. */
  toRemote: Partial<T>
  /** Fields both sides changed to different values. */
  conflicts: (keyof T)[]
}

export function threeWayMerge<T extends Fields>(
  base: T,
  local: T,
  remote: T,
  localIsNewer: boolean,
): MergeResult<T> {
  const value = { ...base }
  const conflicts: (keyof T)[] = []
  for (const key of Object.keys(base) as (keyof T)[]) {
    const localChanged = local[key] !== base[key]
    const remoteChanged = remote[key] !== base[key]
    if (localChanged && remoteChanged && local[key] !== remote[key]) {
      conflicts.push(key)
      value[key] = localIsNewer ? local[key] : remote[key]
    } else if (localChanged) {
      value[key] = local[key]
    } else if (remoteChanged) {
      value[key] = remote[key]
    }
  }
  return { value, toLocal: diff(local, value), toRemote: diff(remote, value), conflicts }
}

/** Keys of `next` whose values differ from `current`, with `next`'s values. */
export function diff<T extends Fields>(current: T, next: T): Partial<T> {
  const changes: Partial<T> = {}
  for (const key of Object.keys(next) as (keyof T)[]) {
    if (current[key] !== next[key]) changes[key] = next[key]
  }
  return changes
}

/**
 * Hide Google-side changes the person isn't allowed to make: those fields read
 * as unchanged (`base`), so the merge pushes Taskly's value back over them.
 * Returns the filtered values and the fields that were blocked.
 */
export function restrict<T extends Fields>(
  base: T,
  remote: T,
  allowed: readonly (keyof T)[],
): { remote: T; blocked: (keyof T)[] } {
  const filtered = { ...remote }
  const blocked: (keyof T)[] = []
  for (const key of Object.keys(base) as (keyof T)[]) {
    if (!allowed.includes(key) && remote[key] !== base[key]) {
      filtered[key] = base[key]
      blocked.push(key)
    }
  }
  return { remote: filtered, blocked }
}
