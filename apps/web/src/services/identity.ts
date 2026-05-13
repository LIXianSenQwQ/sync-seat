const MEMBER_ID_KEY = "sync-seat.memberId";
const NICKNAME_KEY = "sync-seat.nickname";

export interface LocalIdentity {
  memberId: string;
  nickname: string;
}

/**
 * 生成 UUID v4。
 * crypto.randomUUID() 仅在安全上下文（HTTPS / localhost）可用，
 * 非安全上下文回退到 crypto.getRandomValues 或 Math.random。
 */
function generateUUID(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  // 回退：使用 crypto.getRandomValues（在所有上下文均可用）
  const getRandomValues =
    typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function"
      ? (arr: Uint8Array) => crypto.getRandomValues(arr)
      : (arr: Uint8Array) => {
          for (let i = 0; i < arr.length; i++) {
            arr[i] = Math.floor(Math.random() * 256);
          }
        };

  const bytes = new Uint8Array(16);
  getRandomValues(bytes);
  // 设置版本 4 与变体位
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0"));
  return `${hex[0]}${hex[1]}${hex[2]}${hex[3]}-${hex[4]}${hex[5]}-${hex[6]}${hex[7]}-${hex[8]}${hex[9]}-${hex[10]}${hex[11]}${hex[12]}${hex[13]}${hex[14]}${hex[15]}`;
}

/**
 * 读取或创建浏览器本地临时身份。
 *
 * @author 清羽
 */
export function getIdentity(): LocalIdentity {
  let memberId = localStorage.getItem(MEMBER_ID_KEY);
  if (!memberId) {
    memberId = generateUUID();
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
