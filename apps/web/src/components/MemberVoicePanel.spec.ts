import { mount } from "@vue/test-utils";
import type { RoomState } from "@sync-seat/shared";
import { describe, expect, it } from "vitest";
import MemberVoicePanel from "./MemberVoicePanel.vue";

const members: RoomState["members"] = [
  {
    memberId: "owner",
    nickname: "房主",
    joinedAt: new Date().toISOString(),
    connected: true,
    voiceJoined: false,
    muted: false
  },
  {
    memberId: "viewer",
    nickname: "观众",
    joinedAt: new Date().toISOString(),
    connected: true,
    voiceJoined: false,
    muted: false
  }
];

function mountPanel(isOwner: boolean) {
  return mount(MemberVoicePanel, {
    props: {
      members,
      ownerId: "owner",
      isOwner,
      memberProgressById: {
        owner: { positionSeconds: 65, durationSeconds: 300, playing: true, updatedAt: new Date().toISOString() },
        viewer: { positionSeconds: 125, durationSeconds: 300, playing: true, updatedAt: new Date().toISOString() }
      },
      serverClockLabel: "20:54:12",
      voiceJoined: false,
      voiceJoining: false,
      muted: false,
      volume: 1,
      voiceRelayError: "",
      nickname: "房主"
    }
  });
}

describe("MemberVoicePanel", () => {
  it("房主视角显示成员观看进度和服务器时间", () => {
    const wrapper = mountPanel(true);

    expect(wrapper.text()).toContain("服务器时间 20:54:12");
    expect(wrapper.text()).toContain("01:05");
    expect(wrapper.text()).toContain("02:05");
  });

  it("非房主视角不显示成员观看进度", () => {
    const wrapper = mountPanel(false);

    expect(wrapper.text()).toContain("服务器时间 20:54:12");
    expect(wrapper.text()).not.toContain("01:05");
    expect(wrapper.text()).not.toContain("02:05");
  });
});
