export type IceCandidateType = "host" | "srflx" | "relay" | "prflx" | "unknown";
export type IceIpFamily = "ipv4" | "ipv6" | "mdns" | "unknown";
export type HostStreamIceStage = "ipv6" | "ipv4" | "relay";
export type HostStreamConnectionRoute = "ipv6-direct" | "lan" | "ipv4-stun" | "turn" | "no-ipv4-stun" | "checking";

export interface ParsedIceCandidate {
  candidate: string;
  type: IceCandidateType;
  protocol: string | null;
  address: string | null;
  port: number | null;
  family: IceIpFamily;
  isPrivateIpv4: boolean;
  isPublicIpv4: boolean;
  isMdns: boolean;
}

export interface HostStreamIceDiagnostics {
  stage: HostStreamIceStage;
  state: RTCIceConnectionState;
  hasIpv6HostCandidate: boolean;
  hasIpv4HostCandidate: boolean;
  hasIpv4SrflxCandidate: boolean;
  hasRelayCandidate: boolean;
  hasMdnsCandidate: boolean;
  selectedCandidateType: IceCandidateType | null;
  selectedCandidateFamily: IceIpFamily | null;
  route: HostStreamConnectionRoute;
  restarted: boolean;
}

export function createInitialHostStreamIceDiagnostics(stage: HostStreamIceStage = "ipv6"): HostStreamIceDiagnostics {
  return {
    stage,
    state: "new",
    hasIpv6HostCandidate: false,
    hasIpv4HostCandidate: false,
    hasIpv4SrflxCandidate: false,
    hasRelayCandidate: false,
    hasMdnsCandidate: false,
    selectedCandidateType: null,
    selectedCandidateFamily: null,
    route: "checking",
    restarted: false
  };
}

export function parseIceCandidate(input: RTCIceCandidateInit | RTCIceCandidate | string | null | undefined): ParsedIceCandidate | null {
  const candidate = typeof input === "string" ? input : input?.candidate;
  if (!candidate) return null;

  const parts = candidate.trim().split(/\s+/);
  const typeIndex = parts.indexOf("typ");
  const rawType = typeIndex >= 0 ? parts[typeIndex + 1] : undefined;
  const type = normalizeCandidateType(rawType);
  const protocol = parts[2]?.toLowerCase() ?? null;
  const hasAddressAndPort = typeIndex >= 6;
  const address = hasAddressAndPort ? parts[4] ?? null : null;
  const port = hasAddressAndPort && Number.isFinite(Number(parts[5])) ? Number(parts[5]) : null;
  const isMdns = Boolean(address?.toLowerCase().endsWith(".local")) || /\.local(?:\s|$)/i.test(candidate);
  const isIpv4 = Boolean(address && isIpv4Address(address));
  const isPrivate = isIpv4 && isPrivateIpv4Address(address!);

  return {
    candidate,
    type,
    protocol,
    address,
    port,
    family: isMdns ? "mdns" : isIpv4 ? "ipv4" : address?.includes(":") ? "ipv6" : "unknown",
    isPrivateIpv4: isPrivate,
    isPublicIpv4: isIpv4 && !isPrivate,
    isMdns
  };
}

export function parseIceCandidateStats(report: Record<string, unknown> | null | undefined): ParsedIceCandidate | null {
  if (!report) return null;
  const type = normalizeCandidateType(typeof report.candidateType === "string" ? report.candidateType : undefined);
  const protocol = typeof report.protocol === "string" ? report.protocol.toLowerCase() : null;
  const addressValue = typeof report.address === "string" ? report.address : typeof report.ip === "string" ? report.ip : null;
  const portValue = typeof report.port === "number" ? report.port : null;
  const candidate = `candidate:stats 1 ${protocol ?? "unknown"} 0 ${addressValue ?? "unknown"} ${portValue ?? 0} typ ${type}`;
  const parsed = parseIceCandidate(candidate);
  return parsed ? { ...parsed, type, protocol, address: addressValue, port: portValue } : null;
}

export function canReplaceMdnsCandidate(
  candidate: RTCIceCandidateInit | RTCIceCandidate | string | null | undefined,
  localIp: string
): boolean {
  const parsed = parseIceCandidate(candidate);
  return Boolean(parsed?.isMdns && parsed.type === "host" && isPrivateIpv4Address(localIp));
}

/**
 * 判断当前 ICE 阶段是否允许发送该候选。
 *
 * @param stage 房主推流当前回落阶段。
 * @param parsed 已解析候选；解析失败时不发送，避免污染远端 ICE 池。
 * @returns 是否应通过信令转发给对端。
 */
export function candidateMatchesHostStreamStage(stage: HostStreamIceStage, parsed: ParsedIceCandidate | null): boolean {
  if (!parsed) return false;
  if (stage === "ipv6") return parsed.type === "host" && parsed.family === "ipv6" && parsed.protocol === "udp";
  if (stage === "ipv4") return parsed.type !== "relay" && (parsed.family === "ipv4" || parsed.family === "mdns");
  return parsed.type === "relay";
}

export function replaceMdnsCandidateAddress(candidate: RTCIceCandidate, localIp: string): RTCIceCandidateInit {
  return {
    candidate: candidate.candidate.replace(/[a-z0-9-]+\.local/gi, localIp),
    sdpMid: candidate.sdpMid,
    sdpMLineIndex: candidate.sdpMLineIndex,
    usernameFragment: candidate.usernameFragment ?? undefined
  };
}

export function updateDiagnosticsWithCandidate(
  diagnostics: HostStreamIceDiagnostics,
  parsed: ParsedIceCandidate | null
): HostStreamIceDiagnostics {
  if (!parsed) return diagnostics;
  return resolveDiagnosticsRoute({
    ...diagnostics,
    hasIpv6HostCandidate: diagnostics.hasIpv6HostCandidate || (parsed.type === "host" && parsed.family === "ipv6"),
    hasIpv4HostCandidate: diagnostics.hasIpv4HostCandidate || (parsed.type === "host" && parsed.family === "ipv4"),
    hasIpv4SrflxCandidate: diagnostics.hasIpv4SrflxCandidate || (parsed.type === "srflx" && parsed.family === "ipv4"),
    hasRelayCandidate: diagnostics.hasRelayCandidate || parsed.type === "relay",
    hasMdnsCandidate: diagnostics.hasMdnsCandidate || parsed.isMdns
  });
}

export function updateDiagnosticsStage(diagnostics: HostStreamIceDiagnostics, stage: HostStreamIceStage): HostStreamIceDiagnostics {
  return resolveDiagnosticsRoute({
    ...createInitialHostStreamIceDiagnostics(stage),
    restarted: diagnostics.restarted
  });
}

export function updateDiagnosticsConnectionState(
  diagnostics: HostStreamIceDiagnostics,
  state: RTCIceConnectionState,
  restarted = diagnostics.restarted
): HostStreamIceDiagnostics {
  return resolveDiagnosticsRoute({
    ...diagnostics,
    state,
    restarted
  });
}

export function updateDiagnosticsSelectedCandidate(
  diagnostics: HostStreamIceDiagnostics,
  parsed: ParsedIceCandidate | null
): HostStreamIceDiagnostics {
  if (!parsed) return resolveDiagnosticsRoute(diagnostics);
  return resolveDiagnosticsRoute({
    ...diagnostics,
    selectedCandidateType: parsed.type,
    selectedCandidateFamily: parsed.family
  });
}

export function describeHostStreamRoute(diagnostics: HostStreamIceDiagnostics): string {
  if (diagnostics.route === "ipv6-direct") return "IPv6 直连";
  if (diagnostics.route === "lan") return "局域网直连";
  if (diagnostics.route === "ipv4-stun") return "IPv4 STUN 打洞";
  if (diagnostics.route === "turn") return "TURN 中继";
  if (diagnostics.route === "no-ipv4-stun") return "未发现 IPv4 STUN 候选";
  return "正在检测连接路径";
}

export function isPrivateIpv4Address(value: string): boolean {
  if (!isIpv4Address(value)) return false;
  const [first, second] = value.split(".").map(Number);
  return first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168) || first === 169 && second === 254;
}

function isIpv4Address(value: string): boolean {
  const parts = value.split(".");
  return parts.length === 4 && parts.every((part) => /^\d+$/.test(part) && Number(part) >= 0 && Number(part) <= 255);
}

function normalizeCandidateType(value: string | undefined): IceCandidateType {
  if (value === "host" || value === "srflx" || value === "relay" || value === "prflx") return value;
  return "unknown";
}

function resolveDiagnosticsRoute(diagnostics: HostStreamIceDiagnostics): HostStreamIceDiagnostics {
  if (diagnostics.selectedCandidateType === "relay") {
    return { ...diagnostics, route: "turn" };
  }
  if (diagnostics.selectedCandidateType === "host" && diagnostics.selectedCandidateFamily === "ipv6") {
    return { ...diagnostics, route: "ipv6-direct" };
  }
  if (diagnostics.selectedCandidateType === "srflx" && diagnostics.selectedCandidateFamily === "ipv4") {
    return { ...diagnostics, route: "ipv4-stun" };
  }
  if (diagnostics.selectedCandidateType === "host") {
    return { ...diagnostics, route: "lan" };
  }
  if (diagnostics.hasIpv6HostCandidate && (diagnostics.state === "connected" || diagnostics.state === "completed")) {
    return { ...diagnostics, route: "ipv6-direct" };
  }
  if (diagnostics.hasIpv4HostCandidate && (diagnostics.state === "connected" || diagnostics.state === "completed")) {
    return { ...diagnostics, route: "lan" };
  }
  if ((diagnostics.state === "failed" || diagnostics.state === "disconnected") && !diagnostics.hasIpv4SrflxCandidate) {
    return { ...diagnostics, route: "no-ipv4-stun" };
  }
  if (diagnostics.hasIpv4SrflxCandidate) {
    return { ...diagnostics, route: "ipv4-stun" };
  }
  return { ...diagnostics, route: "checking" };
}
