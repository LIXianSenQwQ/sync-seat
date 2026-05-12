const MEMBER_ID_KEY = "sync-seat.memberId";
const NICKNAME_KEY = "sync-seat.nickname";

export interface LocalIdentity {
  memberId: string;
  nickname: string;
}

/**
 * 读取或创建浏览器本地临时身份。
 *
 * @author 清羽
 */
export function getIdentity(): LocalIdentity {
  let memberId = localStorage.getItem(MEMBER_ID_KEY);
  if (!memberId) {
    memberId = crypto.randomUUID();
    localStorage.setItem(MEMBER_ID_KEY, memberId);
  }

  let nickname = localStorage.getItem(NICKNAME_KEY);
  if (!nickname) {
    nickname = `观影者${Math.floor(Math.random() * 900 + 100)}`;
    localStorage.setItem(NICKNAME_KEY, nickname);
  }

  return { memberId, nickname };
}

export function saveNickname(nickname: string): LocalIdentity {
  const identity = getIdentity();
  const next = nickname.trim() || identity.nickname;
  localStorage.setItem(NICKNAME_KEY, next);
  return { ...identity, nickname: next };
}
