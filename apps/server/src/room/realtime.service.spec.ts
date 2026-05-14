import { afterEach, describe, expect, it, vi } from "vitest";
import { RealtimeService } from "./realtime.service.js";

describe("RealtimeService", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("按房间和成员定位目标 socket，避免推流信令广播给全房间", () => {
    const service = new RealtimeService();
    service.bind("socket-a", "ABC123", "m1");
    service.bind("socket-b", "ABC123", "m2");
    service.bind("socket-c", "XYZ999", "m2");

    expect(service.targetSocketIds("ABC123", "m2")).toEqual(["socket-b"]);
    expect(service.targetSocketIds("XYZ999", "m2")).toEqual(["socket-c"]);

    service.unbind("socket-b");
    expect(service.targetSocketIds("ABC123", "m2")).toEqual([]);
  });

  it("房间状态事件包含服务端发送时间", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.123Z"));
    const service = new RealtimeService();

    const event = service.stateEvent({ roomCode: "1234" } as never);

    expect(event.serverTimeMs).toBe(1767225600123);
    expect(event).toMatchObject({ type: "room_state", room: { roomCode: "1234" } });
  });
});
