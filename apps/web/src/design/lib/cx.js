/** 클래스 이름 합치기: 거짓 값은 버린다. */
export function cx(...names) {
  return names.filter(Boolean).join(' ');
}
