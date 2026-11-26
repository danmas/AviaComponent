/** Текущая схема, в которую пишутся новые события. */
export const CONTRACT_VERSION = 1 as const;

/** Версии, которые чтение обязано принимать. Старая схема не переписывается. */
export const READABLE_VERSIONS = [1, 2] as const;

export type ReadableVersion = (typeof READABLE_VERSIONS)[number];

export function isReadableVersion(version: number): version is ReadableVersion {
  return version === 1 || version === 2;
}
