import { describe, expect, it } from "vitest";
import { RealtimeService } from "./realtime.service.js";

describe("RealtimeService", () => {
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
});
