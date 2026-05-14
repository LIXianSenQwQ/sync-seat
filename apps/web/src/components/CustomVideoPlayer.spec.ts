import { mount } from "@vue/test-utils";
import type { PlaybackState } from "@sync-seat/shared";
import { describe, expect, it, vi } from "vitest";
import CustomVideoPlayer from "./CustomVideoPlayer.vue";

function state(patch: Partial<PlaybackState> = {}): PlaybackState {
  return {
    playing: false,
    positionSeconds: 0,
    playbackRate: 1,
    stateUpdatedAt: new Date().toISOString(),
    version: 1,
    lastOperationId: null,
    lastMemberId: null,
    lastAction: null,
    ...patch
  };
}

function prepareVideo(video: HTMLVideoElement, duration = 100): void {
  Object.defineProperty(video, "duration", { configurable: true, value: duration });
  Object.defineProperty(video, "readyState", { configurable: true, value: 4 });
  video.play = vi.fn(async () => undefined);
  video.pause = vi.fn();
}

function prepareProgress(element: Element): void {
  Object.defineProperty(element, "setPointerCapture", { configurable: true, value: vi.fn() });
  Object.defineProperty(element, "releasePointerCapture", { configurable: true, value: vi.fn() });
  Object.defineProperty(element, "getBoundingClientRect", {
    configurable: true,
    value: () => ({ left: 0, width: 200, top: 0, height: 22, right: 200, bottom: 22 })
  });
}

describe("CustomVideoPlayer", () => {
  it("拖动中只更新控件 UI，不改 video.currentTime 且不发送同步事件", async () => {
    const wrapper = mount(CustomVideoPlayer, {
      props: {
        src: "/demo.mp4",
        syncMode: true,
        playbackState: state({ playing: true, positionSeconds: 10, version: 3 })
      }
    });
    const video = wrapper.find("video").element as HTMLVideoElement;
    const progress = wrapper.find(".player-progress");
    prepareVideo(video);
    prepareProgress(progress.element);
    video.currentTime = 10;
    await video.dispatchEvent(new Event("loadedmetadata"));

    await progress.trigger("pointerdown", { clientX: 100, pointerId: 1 });
    await progress.trigger("pointermove", { clientX: 160, pointerId: 1 });

    expect(video.currentTime).toBe(10);
    expect(wrapper.emitted("set-playback")).toBeUndefined();
  });

  it("松手后只发送一次 set-playback 意图并保留播放意图", async () => {
    const wrapper = mount(CustomVideoPlayer, {
      props: {
        src: "/demo.mp4",
        syncMode: true,
        playbackState: state({ playing: true, positionSeconds: 10, version: 7 })
      }
    });
    const video = wrapper.find("video").element as HTMLVideoElement;
    const progress = wrapper.find(".player-progress");
    prepareVideo(video);
    prepareProgress(progress.element);
    video.currentTime = 10;
    await video.dispatchEvent(new Event("loadedmetadata"));

    await progress.trigger("pointerdown", { clientX: 20, pointerId: 1 });
    await progress.trigger("pointerup", { clientX: 100, pointerId: 1 });

    const events = wrapper.emitted("set-playback");
    expect(events).toHaveLength(1);
    expect(events?.[0]?.[0]).toMatchObject({
      action: "seek",
      positionSeconds: 50,
      playing: true,
      playbackRate: 1,
      baseVersion: 7
    });
  });

  it("remote_apply 期间底层 pause/seeked/waiting 不会产生回声事件", async () => {
    const wrapper = mount(CustomVideoPlayer, {
      props: {
        src: "/demo.mp4",
        syncMode: true,
        playbackState: state({ playing: true, positionSeconds: 30, version: 2 })
      }
    });
    const video = wrapper.find("video").element as HTMLVideoElement;
    prepareVideo(video);
    video.currentTime = 0;
    await video.dispatchEvent(new Event("loadedmetadata"));
    await wrapper.setProps({ playbackState: state({ playing: true, positionSeconds: 70, version: 3, lastOperationId: "op-remote" }) });

    await video.dispatchEvent(new Event("waiting"));
    await video.dispatchEvent(new Event("pause"));
    await video.dispatchEvent(new Event("seeked"));

    expect(wrapper.emitted("set-playback")).toBeUndefined();
  });
});
