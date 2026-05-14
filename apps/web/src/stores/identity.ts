import { defineStore } from "pinia";

const MEMBER_ID_KEY = "sync-seat.memberId";
const NICKNAME_KEY = "sync-seat.nickname";

export interface LocalIdentity {
  memberId: string;
  nickname: string;
}

function generateUUID(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
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
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0"));
  return `${hex[0]}${hex[1]}${hex[2]}${hex[3]}-${hex[4]}${hex[5]}-${hex[6]}${hex[7]}-${hex[8]}${hex[9]}-${hex[10]}${hex[11]}${hex[12]}${hex[13]}${hex[14]}${hex[15]}`;
}

function generateNickname(): string {
  const adj: string[] = [
    "好动的", "呆萌的", "蹦跳的", "慵懒的", "狂奔的", "打嗝的", "熬夜的",
    "打盹的", "晃悠的", "哼哼的", "翻滚的", "发呆的", "挠墙的", "嘴馋的",
    "散步的", "抠脚的", "迷路的", "吃撑的", "傻笑的", "飞快的"
  ];
  const animal: string[] = [
    "猫咪", "熊猫", "兔子", "树懒", "拖鞋", "河豚", "考拉", "企鹅",
    "仓鼠", "柴犬", "海獭", "水豚", "羊驼", "橘猫", "二哈", "刺猬",
    "松鼠", "海豚", "狐狸", "小鹿"
  ];
  const a = adj[Math.floor(Math.random() * adj.length)];
  const b = animal[Math.floor(Math.random() * animal.length)];
  return `${a}${b}`;
}

export const useIdentityStore = defineStore("identity", {
  state: (): LocalIdentity => {
    let memberId = localStorage.getItem(MEMBER_ID_KEY);
    if (!memberId) {
      memberId = generateUUID();
      localStorage.setItem(MEMBER_ID_KEY, memberId);
    }
    let nickname = localStorage.getItem(NICKNAME_KEY);
    if (!nickname) {
      nickname = generateNickname();
      localStorage.setItem(NICKNAME_KEY, nickname);
    }
    return { memberId, nickname };
  },

  actions: {
    saveNickname(nickname: string) {
      const next = nickname.trim() || this.nickname;
      localStorage.setItem(NICKNAME_KEY, next);
      this.nickname = next;
    }
  }
});
