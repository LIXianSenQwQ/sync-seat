import { mount } from "@vue/test-utils";
import type { PlaybackState } from "@sync-seat/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  afterEach(() => {
    document.body.className = "";
  });

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

  it("暂停态点击播放时使用房间权威暂停位置而不是本地残留时间", async () => {
    const wrapper = mount(CustomVideoPlayer, {
      props: {
        src: "/demo.mp4",
        syncMode: true,
        playbackState: state({ playing: false, positionSeconds: 30, version: 5 })
      }
    });
    const video = wrapper.find("video").element as HTMLVideoElement;
    prepareVideo(video);
    video.currentTime = 44;
    await video.dispatchEvent(new Event("loadedmetadata"));

    await wrapper.find("button[title='播放']").trigger("click");

    const events = wrapper.emitted("set-playback");
    expect(events).toHaveLength(1);
    expect(events?.[0]?.[0]).toMatchObject({
      action: "play",
      positionSeconds: 30,
      playing: true,
      playbackRate: 1,
      baseVersion: 5
    });
  });

  it("点击静音按钮不会冒泡触发播放或暂停同步", async () => {
    const wrapper = mount(CustomVideoPlayer, {
      props: {
        src: "/demo.mp4",
        syncMode: true,
        playbackState: state({ playing: false, positionSeconds: 12, version: 3 })
      }
    });
    const video = wrapper.find("video").element as HTMLVideoElement;
    prepareVideo(video);
    await video.dispatchEvent(new Event("loadedmetadata"));

    await wrapper.find("button[title='静音']").trigger("click");

    expect(wrapper.emitted("set-playback")).toBeUndefined();
  });

  it("容器不支持 Fullscreen API 时进入伪全屏且不调用 video 原生全屏", async () => {
    const wrapper = mount(CustomVideoPlayer, {
      props: {
        src: "/demo.mp4"
      }
    });
    const root = wrapper.find(".custom-player").element as HTMLElement;
    const video = wrapper.find("video").element as HTMLVideoElement & { webkitEnterFullscreen?: () => void };
    const webkitEnterFullscreen = vi.fn();
    Object.defineProperty(root, "requestFullscreen", { configurable: true, value: undefined });
    Object.defineProperty(video, "webkitEnterFullscreen", { configurable: true, value: webkitEnterFullscreen });

    await wrapper.find("button[title='全屏']").trigger("click");

    expect(webkitEnterFullscreen).not.toHaveBeenCalled();
    expect(root.classList.contains("mobile-pseudo-fullscreen")).toBe(true);
    expect(document.body.classList.contains("custom-player-pseudo-fullscreen-open")).toBe(true);
  });

  it("伪全屏状态下再次点击全屏按钮会退出并清理 body class", async () => {
    const wrapper = mount(CustomVideoPlayer, {
      props: {
        src: "/demo.mp4"
      }
    });
    const root = wrapper.find(".custom-player").element as HTMLElement;
    Object.defineProperty(root, "requestFullscreen", { configurable: true, value: undefined });

    await wrapper.find("button[title='全屏']").trigger("click");
    await wrapper.find("button[title='退出全屏']").trigger("click");

    expect(root.classList.contains("mobile-pseudo-fullscreen")).toBe(false);
    expect(document.body.classList.contains("custom-player-pseudo-fullscreen-open")).toBe(false);
  });

  it("仍然向外暴露底层 video 元素", () => {
    const wrapper = mount(CustomVideoPlayer, {
      props: {
        src: "/demo.mp4"
      }
    });
    const exposed = wrapper.vm as unknown as { getVideoElement: () => HTMLVideoElement | null };

    expect(exposed.getVideoElement()).toBe(wrapper.find("video").element);
  });

  it("观众推流模式按房主快照显示只读真实进度", async () => {
    const updatedAt = new Date(Date.now() - 5000).toISOString();
    const wrapper = mount(CustomVideoPlayer, {
      props: {
        src: "",
        mediaStream: new MediaStream(),
        readonlyProgress: true,
        progressSnapshot: {
          durationSeconds: 120,
          positionSeconds: 30,
          playing: false,
          playbackRate: 1,
          updatedAt
        }
      }
    });

    expect(wrapper.find(".player-time").text()).toBe("00:30 / 02:00");
    expect((wrapper.find(".player-progress-played").element as HTMLElement).style.width).toBe("25%");
  });

  it("只读进度条不会拖动底层 video，也不会发送同步事件", async () => {
    const wrapper = mount(CustomVideoPlayer, {
      props: {
        src: "",
        readonlyProgress: true,
        progressSnapshot: {
          durationSeconds: 100,
          positionSeconds: 20,
          playing: false,
          playbackRate: 1,
          updatedAt: new Date().toISOString()
        }
      }
    });
    const video = wrapper.find("video").element as HTMLVideoElement;
    const progress = wrapper.find(".player-progress");
    prepareVideo(video);
    prepareProgress(progress.element);
    video.currentTime = 20;

    await progress.trigger("pointerdown", { clientX: 100, pointerId: 1 });
    await progress.trigger("pointerup", { clientX: 160, pointerId: 1 });

    expect(video.currentTime).toBe(20);
    expect(wrapper.emitted("set-playback")).toBeUndefined();
  });

  it("请求房主控制模式下播放按钮只发送请求，不直接播放或暂停远端流", async () => {
    const wrapper = mount(CustomVideoPlayer, {
      props: {
        src: "",
        controlMode: "request-host",
        progressSnapshot: {
          durationSeconds: 100,
          positionSeconds: 20,
          playing: true,
          playbackRate: 1,
          updatedAt: new Date().toISOString()
        }
      }
    });
    const video = wrapper.find("video").element as HTMLVideoElement;
    prepareVideo(video);

    await wrapper.find("button[title='请求暂停']").trigger("click");

    expect(video.play).not.toHaveBeenCalled();
    expect(video.pause).not.toHaveBeenCalled();
    expect(wrapper.emitted("request-host-control")?.[0]?.[0]).toEqual({ action: "pause" });
  });
});
