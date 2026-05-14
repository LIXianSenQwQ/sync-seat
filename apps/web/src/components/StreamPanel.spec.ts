import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import StreamPanel from "./StreamPanel.vue";

const qualityOptions = [
  { label: "原画", value: "original" },
  { label: "标准", value: "standard" },
  { label: "流畅", value: "smooth" }
];

describe("StreamPanel", () => {
  it("观众分支显示画质选择且不再显示请求播放暂停按钮", async () => {
    const wrapper = mount(StreamPanel, {
      props: {
        isOwner: false,
        localVideoUrl: "",
        hostStreamQuality: "standard",
        hostStreamQualityOptions: qualityOptions,
        remoteStreamReady: true,
        hostStreamDiagnosticLabels: [],
        hasTerminalHostStreamError: false,
        roomStreaming: true
      }
    });

    expect(wrapper.text()).toContain("清晰度");
    expect(wrapper.text()).toContain("原画");
    expect(wrapper.text()).not.toContain("请求播放");
    expect(wrapper.text()).not.toContain("请求暂停");

    await wrapper.findAll("button").find((button) => button.text() === "流畅")?.trigger("click");

    expect(wrapper.emitted("update:hostStreamQuality")?.[0]?.[0]).toBe("smooth");
  });
});
