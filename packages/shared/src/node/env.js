// 설정값 정리. env 파일의 `KEY=` 처럼 비어 있는 값은 "설정 안 함"으로 본다.
// (그대로 두면 `env.X ?? 기본값` 이 빈 문자열을 쓰고, path.resolve('') 가 현재 폴더가 되는 사고가 난다)

/**
 * @param {Record<string, string | undefined>} env
 * @returns {Record<string, string>}
 */
export function withoutEmpty(env) {
  return Object.fromEntries(Object.entries(env).filter(([, v]) => typeof v === 'string' && v.trim() !== ''));
}
