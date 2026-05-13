import { describe, expect, it } from "vitest";
import { candidateMatchesHostStreamStage, canReplaceMdnsCandidate, describeHostStreamRoute, parseIceCandidate, updateDiagnosticsSelectedCandidate, createInitialHostStreamIceDiagnostics } from "./ice-diagnostics";

describe("ice-diagnostics", () => {
  it("解析 IPv4 host 候选", () => {
    const parsed = parseIceCandidate("candidate:1 1 udp 2122260223 192.168.1.8 53421 typ host generation 0");

    expect(parsed).toMatchObject({
      type: "host",
      protocol: "udp",
      address: "192.168.1.8",
      port: 53421,
      family: "ipv4",
      isPrivateIpv4: true
    });
  });

  it("解析 IPv4 srflx 候选作为 STUN 打洞候选", () => {
    const parsed = parseIceCandidate("candidate:2 1 udp 1686052607 203.0.113.12 62000 typ srflx raddr 192.168.1.8 rport 53421");

    expect(parsed).toMatchObject({
      type: "srflx",
      address: "203.0.113.12",
      family: "ipv4",
      isPublicIpv4: true
    });
  });

  it("解析 IPv4 relay 候选", () => {
    const parsed = parseIceCandidate("candidate:3 1 udp 41885695 198.51.100.7 3478 typ relay raddr 0.0.0.0 rport 0");

    expect(parsed).toMatchObject({
      type: "relay",
      family: "ipv4",
      isPublicIpv4: true
    });
  });

  it("解析 IPv6 候选", () => {
    const parsed = parseIceCandidate("candidate:4 1 udp 2122260223 2001:db8::1 53421 typ host");

    expect(parsed).toMatchObject({
      type: "host",
      family: "ipv6",
      isPrivateIpv4: false,
      isPublicIpv4: false
    });
  });

  it("解析 mDNS 候选", () => {
    const parsed = parseIceCandidate("candidate:5 1 udp 2122260223 a1b2c3d4.local 53421 typ host");

    expect(parsed).toMatchObject({
      type: "host",
      family: "mdns",
      isMdns: true
    });
  });

  it("兼容缺失 address 和 port 的异常候选", () => {
    const parsed = parseIceCandidate("candidate:6 1 udp 2122260223 typ host");

    expect(parsed).toMatchObject({
      type: "host",
      address: null,
      port: null,
      family: "unknown"
    });
  });

  it("只允许使用私有 IPv4 替换 mDNS 候选", () => {
    const candidate = "candidate:7 1 udp 2122260223 a1b2c3d4.local 53421 typ host";

    expect(canReplaceMdnsCandidate(candidate, "192.168.1.10")).toBe(true);
    expect(canReplaceMdnsCandidate(candidate, "10.0.0.2")).toBe(true);
    expect(canReplaceMdnsCandidate(candidate, "172.16.0.2")).toBe(true);
    expect(canReplaceMdnsCandidate(candidate, "172.31.255.254")).toBe(true);
    expect(canReplaceMdnsCandidate(candidate, "172.32.0.2")).toBe(false);
    expect(canReplaceMdnsCandidate(candidate, "203.0.113.8")).toBe(false);
    expect(canReplaceMdnsCandidate(candidate, "2001:db8::1")).toBe(false);
    expect(canReplaceMdnsCandidate(candidate, "unknown")).toBe(false);
  });

  it("按房主推流阶段过滤 ICE 候选", () => {
    const ipv6Host = parseIceCandidate("candidate:8 1 udp 2122260223 240e:1::8 53421 typ host");
    const ipv4Srflx = parseIceCandidate("candidate:9 1 udp 1686052607 203.0.113.12 62000 typ srflx");
    const relay = parseIceCandidate("candidate:10 1 udp 41885695 198.51.100.7 3478 typ relay");

    expect(candidateMatchesHostStreamStage("ipv6", ipv6Host)).toBe(true);
    expect(candidateMatchesHostStreamStage("ipv6", ipv4Srflx)).toBe(false);
    expect(candidateMatchesHostStreamStage("ipv4", ipv4Srflx)).toBe(true);
    expect(candidateMatchesHostStreamStage("ipv4", relay)).toBe(false);
    expect(candidateMatchesHostStreamStage("relay", relay)).toBe(true);
  });

  it("描述 IPv6 直连和 TURN 中继路径", () => {
    const ipv6Diagnostics = updateDiagnosticsSelectedCandidate(
      createInitialHostStreamIceDiagnostics("ipv6"),
      parseIceCandidate("candidate:11 1 udp 2122260223 240e:1::8 53421 typ host")
    );
    const relayDiagnostics = updateDiagnosticsSelectedCandidate(
      createInitialHostStreamIceDiagnostics("relay"),
      parseIceCandidate("candidate:12 1 udp 41885695 198.51.100.7 3478 typ relay")
    );

    expect(describeHostStreamRoute(ipv6Diagnostics)).toBe("IPv6 直连");
    expect(describeHostStreamRoute(relayDiagnostics)).toBe("TURN 中继");
  });
});
